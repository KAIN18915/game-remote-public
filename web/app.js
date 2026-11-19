const STREAM_PORT = 8080;

const FILTER_KEYS = [
  { key: "tags", label: "タグ", multi: true },
  { key: "genres", label: "ジャンル", multi: true },
  { key: "platforms", label: "プラットフォーム", multi: true },
  { key: "developers", label: "開発元", multi: true },
  { key: "publishers", label: "パブリッシャー", multi: true },
  { key: "categories", label: "カテゴリ", multi: true },
  { key: "features", label: "機能", multi: true },
  { key: "source", label: "ソース", multi: false },
  { key: "completionStatus", label: "クリア状況", multi: false },
  { key: "installRoot", label: "インストール場所", multi: false },
];

const state = {
  games: [],
  lookups: {},
  selected: null,
  focused: null,
  nowPlaying: null, // { id, name, alive }
  sort: localStorage.getItem("gr_sort") || "name",
  sortDir: localStorage.getItem("gr_sort_dir") || "",
  group: localStorage.getItem("gr_group") || "none",
  libView: (() => {
    const v = localStorage.getItem("gr_lib_view");
    return v === "showcase" || v === "list" ? v : "grid";
  })(),
  filters: JSON.parse(localStorage.getItem("gr_filters") || "{}"),
  streamUrl: streamUrlFromPage(),
  showcaseTapId: null,
};

const $ = (id) => document.getElementById(id);

function streamPath() {
  const host = String(location.hostname || "").toLowerCase();
  const tailscale =
    host.endsWith(".ts.net") ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  if (tailscale) return { kind: "tailscale", transport: "websocket" };
  return { kind: "lan", transport: "webrtc" };
}

function streamUrlFromPage() {
  const host = location.hostname || "127.0.0.1";
  return `${location.protocol}//${host}:${STREAM_PORT}/`;
}

function moonlightAutoUrl(appName = "Desktop") {
  const base = (state.streamUrl || streamUrlFromPage()).replace(/\/?$/, "/");
  const transport = localStorage.getItem("gr_stream_transport");
  const dataTransport =
    transport === "webrtc" || transport === "auto" || transport === "websocket"
      ? transport
      : streamPath().transport;
  return `${base}auto.html?app=${encodeURIComponent(appName)}&dataTransport=${encodeURIComponent(dataTransport)}`;
}

function mediaUrl(path) {
  if (!path) return null;
  return `/api/cover?path=${encodeURIComponent(path)}`;
}

function hours(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return "0時間";
  if (s < 3600) return `${Math.round(s / 60)}分`;
  return `${(s / 3600).toFixed(1)}時間`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function coverOf(g) {
  return mediaUrl(g?.coverImage || g?.icon || g?.backgroundImage);
}

function bgOf(g) {
  return mediaUrl(g?.backgroundImage || g?.coverImage || g?.icon);
}

/* ===== Background art preload + crossfade (fixes first-focus black flash) ===== */
const artBg = {
  cache: new Map(), // url -> Promise<boolean>
  shownUrl: null,
  flip: false,
  gen: 0,
};

function prefetchArtUrl(url) {
  if (!url) return Promise.resolve(false);
  if (artBg.cache.has(url)) return artBg.cache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  artBg.cache.set(url, p);
  return p;
}

function setBillboardLayer(el, url) {
  if (!el) return;
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
    el.style.opacity = "1";
  } else {
    el.style.backgroundImage = "none";
    el.style.opacity = "0.3";
  }
}

async function showShowcaseArt(url) {
  const a = $("showcaseArtA");
  const b = $("showcaseArtB");
  if (!a || !b) {
    setBillboardLayer($("showcaseArt"), url);
    return;
  }
  const gen = ++artBg.gen;
  if (!url) {
    // Keep last art if we only lost the URL briefly
    return;
  }
  if (url === artBg.shownUrl) return;

  // Stay on previous art while the next image loads (no black gap)
  const ok = await prefetchArtUrl(url);
  if (gen !== artBg.gen) return;
  if (!ok) {
    // Still attempt paint; network may recover via CSS url()
  }

  artBg.flip = !artBg.flip;
  const next = artBg.flip ? b : a;
  const prev = artBg.flip ? a : b;
  next.style.backgroundImage = `url("${url}")`;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (gen !== artBg.gen) return;
  next.classList.add("is-shown");
  // Remove previous only after next is visible
  requestAnimationFrame(() => {
    if (gen !== artBg.gen) return;
    prev.classList.remove("is-shown");
    artBg.shownUrl = url;
  });
}

function prefetchNeighborBackgrounds(centerId) {
  const cards = visibleCards();
  if (!cards.length) return;
  let i = cards.findIndex((c) => c.dataset.gameId === centerId);
  if (i < 0) i = typeof gpLib !== "undefined" ? gpLib.index || 0 : 0;
  const urls = [];
  // Wider window — fast scrubbing still hits warm cache
  for (let d = -10; d <= 10; d++) {
    const c = cards[i + d];
    if (!c) continue;
    const g = gameById(c.dataset.gameId);
    const url = bgOf(g);
    if (url) urls.push(url);
  }
  const ordered = [];
  const cur = bgOf(gameById(centerId));
  if (cur) ordered.push(cur);
  for (const u of urls) {
    if (!ordered.includes(u)) ordered.push(u);
  }
  ordered.forEach((u, n) => {
    setTimeout(() => prefetchArtUrl(u), n * 30);
  });
}

/* Sequential cover prefetch for library / showcase tiles */
const coverPrefetch = {
  queue: [],
  busy: 0,
  max: 3,
  seen: new Set(),
};

function enqueueCoverPrefetch(urls) {
  for (const url of urls) {
    if (!url || coverPrefetch.seen.has(url)) continue;
    coverPrefetch.seen.add(url);
    coverPrefetch.queue.push(url);
  }
  pumpCoverPrefetch();
}

function pumpCoverPrefetch() {
  while (coverPrefetch.busy < coverPrefetch.max && coverPrefetch.queue.length) {
    const url = coverPrefetch.queue.shift();
    coverPrefetch.busy += 1;
    const img = new Image();
    const done = () => {
      coverPrefetch.busy -= 1;
      pumpCoverPrefetch();
    };
    img.onload = done;
    img.onerror = done;
    img.decoding = "async";
    img.src = url;
  }
}

function prefetchVisibleCovers() {
  const cards = document.querySelectorAll(".card[data-game-id]");
  const urls = [];
  cards.forEach((c) => {
    const g = gameById(c.dataset.gameId);
    const u = coverOf(g);
    if (u) urls.push(u);
  });
  enqueueCoverPrefetch(urls);
}

function setBillboard(g) {
  state.focused = g || null;
  const url = bgOf(g);

  const bb = $("billboardArt");
  if (bb) {
    if (url) {
      prefetchArtUrl(url).then(() => {
        if (state.focused?.id !== g?.id) return;
        setBillboardLayer(bb, url);
      });
    } else {
      setBillboardLayer(bb, null);
    }
  }

  showShowcaseArt(url);
  if (g?.id) prefetchNeighborBackgrounds(g.id);

  const listArt = $("listDetailArt");
  if (listArt) {
    if (url) {
      prefetchArtUrl(url).then(() => {
        if (state.focused?.id !== g?.id) return;
        listArt.style.backgroundImage = `url("${url}")`;
      });
    } else {
      listArt.style.backgroundImage = "none";
    }
  }

  const playing = isNowPlaying(g);
  const eyebrow = g
    ? playing
      ? "プレイ中"
      : (g.platforms || []).slice(0, 2).join(" / ") || g.source || "Playnite"
    : "ライブラリ";
  const title = g?.name || "タイトルを選ぶ";
  const descPlain = g
    ? plainText(g.description, 900) || g.installDirectory || "説明なし"
    : state.libView === "showcase"
      ? "コントローラかタップでタイトルを選べます。"
      : state.libView === "list"
        ? "左の一覧からタイトルを選ぶと、ここに詳細が入ります。"
        : "カバーに触れると、その作品の背景がここに広がります。";
  const statsHtml = g
    ? [
        `<span>プレイ ${hours(g.playtime)}</span>`,
        `<span>最近 ${fmtDate(g.lastActivity)}</span>`,
        `<span>${g.isInstalled ? "インストール済" : "未インストール"}</span>`,
        playing ? `<span class="bb-playing-tag">プレイ中</span>` : "",
      ]
        .filter(Boolean)
        .join("")
    : "";

  if ($("bbEyebrow")) $("bbEyebrow").textContent = eyebrow;
  if ($("bbTitle")) $("bbTitle").textContent = title;
  if ($("bbDesc")) $("bbDesc").textContent = descPlain;
  if ($("bbStats")) $("bbStats").innerHTML = statsHtml;
  if ($("bbPlay")) $("bbPlay").disabled = !g;
  if ($("bbOpen")) $("bbOpen").disabled = !g;

  if ($("scEyebrow")) $("scEyebrow").textContent = eyebrow;
  if ($("scTitle")) $("scTitle").textContent = title;
  if ($("scDesc")) {
    if (g?.description) {
      $("scDesc").innerHTML = sanitizeHtml(g.description);
    } else if (g) {
      $("scDesc").textContent = g.installDirectory || "説明なし";
    } else {
      $("scDesc").textContent = descPlain;
    }
  }
  if ($("scStats")) $("scStats").innerHTML = statsHtml;
  if ($("scPlay")) $("scPlay").disabled = !g;
  if ($("scOpen")) $("scOpen").disabled = !g;

  if ($("listEyebrow")) $("listEyebrow").textContent = eyebrow;
  if ($("listTitle")) $("listTitle").textContent = title;
  if ($("listStats")) $("listStats").innerHTML = statsHtml;
  if ($("listDesc")) {
    if (g?.description) {
      $("listDesc").innerHTML = sanitizeHtml(g.description);
    } else if (g) {
      $("listDesc").textContent = g.installDirectory || "説明なし";
    } else {
      $("listDesc").textContent = descPlain;
    }
  }
  if ($("listPlay")) $("listPlay").disabled = !g;
  if ($("listOpen")) $("listOpen").disabled = !g;

  syncBillboardActions(g);
  markShowcaseSelected(g?.id);
}

function plainText(html, max = 220) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const t = (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function toast(msg, ms = 3200) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function notifyPress(el, msg) {
  if (msg) toast(msg, 2200);
  if (!el || !el.classList) return;
  el.classList.add("is-pressed");
  clearTimeout(el._pressT);
  el._pressT = setTimeout(() => el.classList.remove("is-pressed"), 320);
}

function setStatus(text) {
  // Status line removed from chrome; keep for toasts on errors only
  if (text && /エラー|失敗|できません/.test(String(text))) {
    toast(String(text));
  }
}

function syncStreamUrl(url) {
  state.streamUrl = (url || streamUrlFromPage()).replace(/\/?$/, "/");
}

async function openStream(opts = {}) {
  // Prefer already-known URL; only hit health if we still need moonlight_web.
  if (!state.streamUrl || state.streamUrl.includes("127.0.0.1")) {
    try {
      await refreshStreamUrlFromHealth();
    } catch (_) {}
  }
  syncStreamUrl(state.streamUrl || streamUrlFromPage());
  const mwApp = opts.mwApp || "Desktop";
  const url = opts.streamUrl || moonlightAutoUrl(mwApp);
  const hasGameOpt = Object.prototype.hasOwnProperty.call(opts, "game");
  const g = hasGameOpt
    ? opts.game
    : state.selected || state.focused || window.GameControls?.getContextGame?.();
  const params = new URLSearchParams();
  params.set("stream", url);
  params.set("mwApp", mwApp);
  if (opts.name) params.set("name", opts.name);
  else if (g?.name) params.set("name", g.name);
  if (g?.id) {
    params.set("game", g.id);
    if (opts.launch === false) params.set("skipLaunch", "1");
  }
  location.href = `/play?${params.toString()}`;
}

async function openMoonlightApp(appName, label) {
  syncStreamUrl(state.streamUrl || streamUrlFromPage());
  return openStream({
    mwApp: appName,
    streamUrl: moonlightAutoUrl(appName),
    name: label || appName,
    launch: false,
    game: null,
  });
}

async function refreshStreamUrlFromHealth() {
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    if (h.moonlight_web) syncStreamUrl(h.moonlight_web);
  } catch (_) {
    syncStreamUrl(streamUrlFromPage());
  }
}

function markShowcaseSelected(gameId) {
  document.querySelectorAll("#showcaseTrack .card").forEach((c) => {
    c.classList.toggle("is-selected", !!(gameId && c.dataset.gameId === gameId));
  });
  document.querySelectorAll("#listRail .list-row").forEach((c) => {
    c.classList.toggle("is-selected", !!(gameId && c.dataset.gameId === gameId));
  });
}

const LIB_VIEWS = ["grid", "showcase", "list"];
const LIB_VIEW_LABELS = {
  grid: "次: ショーケース表示",
  showcase: "次: リスト表示",
  list: "次: グリッド表示",
};

function listSplitNarrow() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function clampListRailPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return listSplitNarrow() ? 40 : 34;
  return Math.max(18, Math.min(70, n));
}

function applyListSplitRatio() {
  const root = $("listView");
  const handle = $("listSplit");
  if (!root) return;
  const narrow = listSplitNarrow();
  const key = narrow ? "gr_list_rail_h" : "gr_list_rail_w";
  const fallback = narrow ? 40 : 34;
  const pct = clampListRailPct(localStorage.getItem(key) || fallback);
  root.style.setProperty("--list-rail-pct", `${pct}%`);
  if (handle) {
    handle.setAttribute("aria-orientation", narrow ? "horizontal" : "vertical");
    handle.setAttribute("aria-valuenow", String(Math.round(pct)));
    handle.setAttribute("aria-valuemin", "18");
    handle.setAttribute("aria-valuemax", "70");
  }
}

function setListSplitRatio(pct) {
  const narrow = listSplitNarrow();
  const next = clampListRailPct(pct);
  localStorage.setItem(narrow ? "gr_list_rail_h" : "gr_list_rail_w", String(Math.round(next * 10) / 10));
  applyListSplitRatio();
}

function bindListSplitter() {
  const root = $("listView");
  const handle = $("listSplit");
  if (!root || !handle || handle.dataset.bound) return;
  handle.dataset.bound = "1";

  const readPctFromPointer = (clientX, clientY) => {
    const rect = root.getBoundingClientRect();
    if (listSplitNarrow()) {
      if (!rect.height) return null;
      return ((clientY - rect.top) / rect.height) * 100;
    }
    if (!rect.width) return null;
    return ((clientX - rect.left) / rect.width) * 100;
  };

  const onMove = (e) => {
    const pt = e.touches?.[0] || e;
    const pct = readPctFromPointer(pt.clientX, pt.clientY);
    if (pct == null) return;
    if (e.cancelable) e.preventDefault();
    setListSplitRatio(pct);
  };

  const onUp = () => {
    root.classList.remove("is-resizing");
    document.body.classList.remove("is-list-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onUp);
    window.removeEventListener("touchcancel", onUp);
  };

  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    root.classList.add("is-resizing");
    document.body.classList.add("is-list-resizing");
    if (e.pointerId != null && handle.setPointerCapture) {
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    window.addEventListener("touchcancel", onUp);
    const pt = e.touches?.[0] || e;
    const pct = readPctFromPointer(pt.clientX, pt.clientY);
    if (pct != null) setListSplitRatio(pct);
    e.preventDefault();
  };

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("touchstart", onDown, { passive: false });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 5 : 2;
    let delta = 0;
    const narrow = listSplitNarrow();
    if (!narrow && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      delta = e.key === "ArrowLeft" ? -step : step;
    } else if (narrow && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      delta = e.key === "ArrowUp" ? -step : step;
    } else if (e.key === "Home") {
      setListSplitRatio(18);
      e.preventDefault();
      return;
    } else if (e.key === "End") {
      setListSplitRatio(70);
      e.preventDefault();
      return;
    } else {
      return;
    }
    const key = narrow ? "gr_list_rail_h" : "gr_list_rail_w";
    const cur = clampListRailPct(localStorage.getItem(key) || (narrow ? 40 : 34));
    setListSplitRatio(cur + delta);
    e.preventDefault();
  });

  window.addEventListener("resize", () => {
    if (state.libView === "list") applyListSplitRatio();
  });
  applyListSplitRatio();
}

function applyLibView() {
  const view = state.libView;
  state.showcaseTapId = null;
  document.body.classList.toggle("lib-showcase", view === "showcase");
  document.body.classList.toggle("lib-grid", view === "grid");
  document.body.classList.toggle("lib-list", view === "list");
  if (view === "list") applyListSplitRatio();
  const sc = $("showcase");
  if (sc) {
    sc.classList.toggle("hidden", view !== "showcase");
    sc.setAttribute("aria-hidden", view === "showcase" ? "false" : "true");
  }
  const lv = $("listView");
  if (lv) {
    lv.classList.toggle("hidden", view !== "list");
    lv.setAttribute("aria-hidden", view === "list" ? "false" : "true");
  }
  const lib = $("library");
  if (lib && view !== "grid") {
    /* grid uses #library; other views hide via body class */
  }
  const bb = $("billboard");
  if (bb) bb.classList.toggle("hidden", view !== "grid");
  const btn = $("btnView");
  if (btn) btn.textContent = LIB_VIEW_LABELS[view] || "表示切替";
  requestAnimationFrame(syncShowcaseNav);
}

function setLibView(view) {
  state.libView = LIB_VIEWS.includes(view) ? view : "grid";
  localStorage.setItem("gr_lib_view", state.libView);
  applyLibView();
  renderLibrary();
  if (state.focused) setBillboard(state.focused);
}

function toggleLibView() {
  const i = LIB_VIEWS.indexOf(state.libView);
  setLibView(LIB_VIEWS[(i + 1) % LIB_VIEWS.length]);
}

function isNowPlaying(g) {
  // Only treat as "playing" when the host process is actually alive.
  // Stale active-game (alive:false) used to hide Launch and only open an empty stream.
  return !!(
    g?.id &&
    state.nowPlaying?.id &&
    g.id === state.nowPlaying.id &&
    state.nowPlaying.alive
  );
}

function syncBillboardActions(g) {
  const playing = isNowPlaying(g);
  for (const [resumeId, playId] of [
    ["bbResume", "bbPlay"],
    ["scResume", "scPlay"],
    ["listResume", "listPlay"],
  ]) {
    const resume = $(resumeId);
    const play = $(playId);
    if (!resume || !play) continue;
    resume.hidden = !playing;
    play.hidden = !!playing;
    if (playing) play.disabled = true;
    else play.disabled = !g;
  }
  if ($("listOpen")) $("listOpen").disabled = !g;
}

function syncResumeChrome() {
  const btn = $("btnResumePlay");
  if (!btn) return;
  const np = state.nowPlaying;
  if (np?.id && np.alive) {
    btn.hidden = false;
    btn.textContent = np.name ? `プレイ中に戻る · ${truncate(np.name, 18)}` : "プレイ中に戻る";
  } else {
    btn.hidden = true;
  }
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function gameById(id) {
  if (!id) return null;
  return state.games.find((g) => g.id === id) || null;
}

async function refreshNowPlaying() {
  try {
    const res = await fetch("/api/now-playing");
    if (!res.ok) throw new Error("now-playing");
    const data = await res.json();
    if (data.playing && data.game_id) {
      state.nowPlaying = {
        id: data.game_id,
        name: data.name || gameById(data.game_id)?.name || "",
        alive: !!data.alive,
      };
      try {
        localStorage.setItem(
          "gr_now_playing",
          JSON.stringify({ id: state.nowPlaying.id, name: state.nowPlaying.name })
        );
      } catch (_) {}
    } else {
      state.nowPlaying = null;
      try {
        localStorage.removeItem("gr_now_playing");
      } catch (_) {}
    }
  } catch (_) {
    // Fallback to last known client cache
    try {
      const raw = JSON.parse(localStorage.getItem("gr_now_playing") || "null");
      state.nowPlaying = raw?.id ? { id: raw.id, name: raw.name || "", alive: null } : null;
    } catch (_) {
      state.nowPlaying = null;
    }
  }
  syncResumeChrome();
  syncBillboardActions(state.focused);
  return state.nowPlaying;
}

async function resumeNowPlaying() {
  const np = state.nowPlaying;
  if (!np?.id) return;
  const g = gameById(np.id) || { id: np.id, name: np.name };
  // Process gone → relaunch instead of opening a blank Desktop stream
  if (!np.alive) {
    try {
      await launchGame(g, true);
    } catch (e) {
      toast(String(e.message || e) || "起動できませんでした");
    }
    return;
  }
  openStream({ game: g, launch: false, mwApp: "Desktop", name: g.name });
}

async function fetchGamesOnce(refresh = false) {
  const params = new URLSearchParams();
  const q = $("search").value.trim();
  if (q) params.set("q", q);
  if ($("installedOnly").checked) params.set("installed", "true");
  if (refresh) params.set("refresh", "true");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(`/api/games?${params}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  let games = data.games || [];
  if ($("favoriteOnly").checked) games = games.filter((g) => g.favorite);
  state.games = games;
  state.lookups = data.lookups || {};
  const src = data.library_source === "stale-cache" ? "キャッシュ" : "読取専用";
  setStatus(`${data.count} タイトル · ${src}`);
  buildFilterPanel();
  await refreshNowPlaying();
  renderLibrary();

  const playing = state.nowPlaying?.id ? gameById(state.nowPlaying.id) : null;
  if (playing) {
    setBillboard(playing);
  } else {
    const sorted = sortGames(games.filter(matchesFilters));
    const focus =
      [...sorted].sort((a, b) => Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0))[0] ||
      sorted[0] ||
      null;
    setBillboard(focus);
  }
}

async function fetchGames(refresh = false) {
  setStatus("読み込み中…");
  let lastErr;
  const tries = refresh ? 2 : 3;
  for (let i = 0; i < tries; i += 1) {
    try {
      await fetchGamesOnce(refresh);
      return;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 700 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function matchesFilters(g) {
  for (const [key, selected] of Object.entries(state.filters)) {
    if (!selected || !selected.length) continue;
    const conf = FILTER_KEYS.find((f) => f.key === key);
    if (!conf) continue;
    if (conf.multi) {
      const vals = g[key] || [];
      if (!selected.some((s) => vals.includes(s))) return false;
    } else if (!selected.includes(g[key] || "")) {
      return false;
    }
  }
  return true;
}

function defaultSortDir(sortKey) {
  // Natural defaults: name A→Z; dates/playtime newest/most first
  return sortKey === "name" ? "asc" : "desc";
}

function effectiveSortDir() {
  if (state.sortDir === "asc" || state.sortDir === "desc") return state.sortDir;
  return defaultSortDir(state.sort);
}

function sortGames(list) {
  const arr = [...list];
  const nameKey = (g) => (g.sortingName || g.name || "").toLocaleLowerCase();
  let cmp;
  switch (state.sort) {
    case "recent":
      cmp = (a, b) => Date.parse(a.lastActivity || 0) - Date.parse(b.lastActivity || 0);
      break;
    case "playtime":
      cmp = (a, b) => (a.playtime || 0) - (b.playtime || 0);
      break;
    case "added":
      cmp = (a, b) => Date.parse(a.added || 0) - Date.parse(b.added || 0);
      break;
    default:
      cmp = (a, b) => nameKey(a).localeCompare(nameKey(b), "ja");
  }
  const dir = effectiveSortDir() === "desc" ? -1 : 1;
  arr.sort((a, b) => {
    const r = cmp(a, b);
    if (r < 0) return -1 * dir;
    if (r > 0) return 1 * dir;
    return 0;
  });
  return arr;
}

function groupGames(list) {
  if (state.group === "none") return [{ title: "すべて", games: list }];
  const map = new Map();
  for (const g of list) {
    const v = g[state.group];
    const keys = Array.isArray(v) ? (v.length ? v : ["(なし)"]) : [v || "(なし)"];
    for (const k of keys) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(g);
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .map(([title, games]) => ({ title, games: sortGames(games) }));
}

function renderLibrary() {
  const filtered = sortGames(state.games.filter(matchesFilters));
  $("resultCount").textContent = `${filtered.length} 件`;

  if (state.libView === "showcase") {
    renderShowcase(filtered);
    return;
  }
  if (state.libView === "list") {
    renderListView(filtered);
    return;
  }

  const root = $("library");
  root.innerHTML = "";

  const pid = state.nowPlaying?.id;
  const playingGame =
    (pid && filtered.find((g) => g.id === pid)) ||
    (pid && gameById(pid)) ||
    null;
  const rest = playingGame ? filtered.filter((g) => g.id !== playingGame.id) : filtered;

  if (playingGame) {
    const sec = document.createElement("section");
    sec.className = "shelf is-playing-shelf";
    sec.innerHTML = `<div class="shelf-title"><span>プレイ中</span><span class="shelf-count">1</span></div>`;
    const rail = document.createElement("div");
    rail.className = "rail";
    rail.appendChild(cardEl(playingGame));
    sec.appendChild(rail);
    root.appendChild(sec);
  }

  for (const shelf of groupGames(rest)) {
    const sec = document.createElement("section");
    sec.className = "shelf";
    sec.innerHTML = `<div class="shelf-title"><span>${escapeHtml(shelf.title)}</span><span class="shelf-count">${shelf.games.length}</span></div>`;
    const rail = document.createElement("div");
    rail.className = "rail";
    for (const g of shelf.games) rail.appendChild(cardEl(g));
    sec.appendChild(rail);
    root.appendChild(sec);
  }
  if (!filtered.length && !playingGame) {
    root.innerHTML = `<p style="color:var(--paper-dim);padding:1rem">条件に一致するタイトルがありません</p>`;
  }
  // Restore / seed controller focus after re-render
  requestAnimationFrame(() => {
    const preferId = state.focused?.id || state.nowPlaying?.id || null;
    syncGpFocusByGameId(preferId);
    prefetchVisibleCovers();
  });
}

function renderShowcase(filtered) {
  const track = $("showcaseTrack");
  if (!track) return;
  track.innerHTML = "";
  state.showcaseTapId = null;

  const pid = state.nowPlaying?.id;
  const ordered = [...filtered];
  if (pid) {
    const ix = ordered.findIndex((g) => g.id === pid);
    if (ix > 0) {
      const [np] = ordered.splice(ix, 1);
      ordered.unshift(np);
    } else if (ix < 0) {
      const np = gameById(pid);
      if (np) ordered.unshift(np);
    }
  }

  if (!ordered.length) {
    track.innerHTML = `<p style="color:var(--paper-dim);padding:0.5rem 0">条件に一致するタイトルがありません</p>`;
    setBillboard(null);
    syncShowcaseNav();
    return;
  }

  for (const g of ordered) {
    track.appendChild(cardEl(g, { selectOnly: true }));
  }

  requestAnimationFrame(() => {
    const preferId = state.focused?.id || state.nowPlaying?.id || ordered[0]?.id || null;
    syncGpFocusByGameId(preferId);
    const g = gameById(preferId) || ordered[0];
    if (g) {
      prefetchNeighborBackgrounds(g.id);
      setBillboard(g);
    }
    prefetchVisibleCovers();
    syncShowcaseNav();
  });
}

function renderListView(filtered) {
  const rail = $("listRail");
  if (!rail) return;
  rail.innerHTML = "";

  const pid = state.nowPlaying?.id;
  const ordered = [...filtered];
  if (pid) {
    const ix = ordered.findIndex((g) => g.id === pid);
    if (ix > 0) {
      const [np] = ordered.splice(ix, 1);
      ordered.unshift(np);
    } else if (ix < 0) {
      const np = gameById(pid);
      if (np) ordered.unshift(np);
    }
  }

  if (!ordered.length) {
    rail.innerHTML = `<p style="color:var(--paper-dim);padding:0.75rem 0.5rem">条件に一致するタイトルがありません</p>`;
    setBillboard(null);
    return;
  }

  for (const g of ordered) {
    rail.appendChild(listRowEl(g));
  }

  requestAnimationFrame(() => {
    const preferId = state.focused?.id || state.nowPlaying?.id || ordered[0]?.id || null;
    syncGpFocusByGameId(preferId);
    const g = gameById(preferId) || ordered[0];
    if (g) {
      prefetchNeighborBackgrounds(g.id);
      setBillboard(g);
    }
    prefetchVisibleCovers();
  });
}

function listRowEl(g) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "list-row";
  btn.dataset.gameId = g.id || "";
  if (isNowPlaying(g)) btn.classList.add("is-playing");

  const url = coverOf(g);
  if (url) {
    const img = document.createElement("img");
    img.className = "list-row-cover";
    img.loading = "lazy";
    img.alt = "";
    img.src = url;
    img.onerror = () => {
      const d = document.createElement("div");
      d.className = "list-row-cover ph";
      d.textContent = (g.name || "?").slice(0, 2);
      img.replaceWith(d);
    };
    btn.appendChild(img);
  } else {
    const d = document.createElement("div");
    d.className = "list-row-cover ph";
    d.textContent = (g.name || "?").slice(0, 2);
    btn.appendChild(d);
  }

  const title = document.createElement("p");
  title.className = "list-row-title";
  title.textContent = g.name || "(no name)";
  btn.appendChild(title);

  btn.addEventListener("focus", () => setBillboard(g));
  btn.addEventListener("click", () => {
    const rows = visibleCards();
    const idx = rows.findIndex((c) => c.dataset.gameId === g.id);
    if (idx >= 0) setGpFocus(idx, { scroll: true });
    else setBillboard(g);
  });
  return btn;
}

function bindGridCardTilt(btn) {
  const clear = () => {
    btn.classList.remove("is-tilt");
    btn.style.transform = "";
    btn.style.setProperty("--tilt-x", "0deg");
    btn.style.setProperty("--tilt-y", "0deg");
  };
  btn.addEventListener("pointerenter", () => {
    if (!document.body.classList.contains("lib-grid")) return;
    btn.classList.add("is-tilt");
  });
  btn.addEventListener("pointermove", (e) => {
    if (!document.body.classList.contains("lib-grid")) {
      clear();
      return;
    }
    const r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    const rotY = Math.max(-11, Math.min(11, px * 16));
    const rotX = Math.max(-9, Math.min(9, -py * 12));
    btn.style.setProperty("--tilt-x", `${rotX.toFixed(2)}deg`);
    btn.style.setProperty("--tilt-y", `${rotY.toFixed(2)}deg`);
    btn.classList.add("is-tilt");
  });
  btn.addEventListener("pointerleave", clear);
  btn.addEventListener("blur", clear);
}

function cardEl(g, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "card";
  btn.dataset.gameId = g.id || "";
  if (isNowPlaying(g)) btn.classList.add("is-playing");
  // Keyboard / pad focus still updates the showcase panel; mouse hover must not.
  btn.addEventListener("focus", () => {
    if (document.body.classList.contains("lib-showcase")) setBillboard(g);
  });
  btn.addEventListener("click", () => {
    if (opts.selectOnly) {
      // Touch: first tap selects, second tap on same card opens detail.
      // (Ignore programmatic focus — iPad would otherwise open on first tap.)
      const already = state.showcaseTapId === g.id;
      state.showcaseTapId = g.id;
      setBillboard(g);
      const cards = visibleCards();
      const idx = cards.findIndex((c) => c.dataset.gameId === g.id);
      if (idx >= 0) setGpFocus(idx, { scroll: true });
      if (already) openDetail(g);
      return;
    }
    openDetail(g);
  });

  if (!opts.selectOnly) {
    bindGridCardTilt(btn);
  }

  if (isNowPlaying(g)) {
    const badge = document.createElement("span");
    badge.className = "card-playing-badge";
    badge.textContent = "プレイ中";
    btn.appendChild(badge);
  }

  const url = coverOf(g);
  if (url) {
    const img = document.createElement("img");
    img.className = "cover";
    img.loading = "lazy";
    img.alt = "";
    img.src = url;
    img.onerror = () => img.replaceWith(ph(g.name));
    btn.appendChild(img);
  } else {
    btn.appendChild(ph(g.name));
  }
  const h = document.createElement("h3");
  h.textContent = g.name || "(no name)";
  btn.appendChild(h);
  return btn;
}

function ph(name) {
  const d = document.createElement("div");
  d.className = "cover ph";
  d.textContent = (name || "?").slice(0, 40);
  return d;
}

/* ===== Library gamepad / keyboard navigation ===== */
const gpLib = {
  index: 0,
  prev: {}, // padKey -> { buttons, axes, hold }
  armed: false,
  seen: false,
  lastPadCount: 0,
  hostTimer: 0,
  hostPrev: null,
};

/** Overlay / chrome focus for console-style UI control */
const uiNav = {
  zone: "library", // library | chrome | filter | menu | detail | dialog | map | search
  index: 0,
};

function libraryUiBlocked() {
  if ($("sortDlg")?.open || $("groupDlg")?.open) return "dialog";
  if ($("mapDlg")?.open) return "map";
  if ($("filterPanel") && !$("filterPanel").classList.contains("hidden")) return "filter";
  if ($("mainMenu") && !$("mainMenu").classList.contains("hidden")) return "menu";
  if ($("detail") && !$("detail").classList.contains("hidden")) return "detail";
  if ($("searchPanel") && !$("searchPanel").classList.contains("hidden")) return "search";
  return null;
}

function clearGpItemFocus() {
  document
    .querySelectorAll(".is-gp-focus:not(.card)")
    .forEach((el) => el.classList.remove("is-gp-focus"));
}

function collectUiItems(zone) {
  const visible = (el) => {
    if (!el || el.disabled) return false;
    if (el.hidden) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.hasAttribute("hidden")) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    return true;
  };

  if (zone === "chrome") {
    return [
      $("btnResumePlay"),
      $("btnMwDesktop"),
      $("btnMwPlaynite"),
      $("btnMwSteam"),
      $("btnSearch"),
      $("btnFilterMenu"),
      $("btnMainMenu"),
    ].filter(visible);
  }
  if (zone === "filter") {
    const panel = $("filterPanel");
    if (!panel) return [];
    const items = [];
    panel.querySelectorAll(".filter-quick button").forEach((el) => items.push(el));
    panel.querySelectorAll("#filterFields details").forEach((det) => {
      const sum = det.querySelector("summary");
      if (sum) items.push(sum);
      if (det.open) {
        det.querySelectorAll(".filter-option").forEach((lab) => items.push(lab));
      }
    });
    const close = $("filterClose");
    if (close) items.push(close);
    return items.filter(visible);
  }
  if (zone === "menu") {
    const panel = $("mainMenu");
    if (!panel) return [];
    return [...panel.querySelectorAll(".menu-row, #mainMenuClose")].filter(visible);
  }
  if (zone === "detail") {
    return [$("detailPlay"), $("detailStreamOnly"), $("detailTogglePad"), $("detailBack")].filter(
      visible
    );
  }
  if (zone === "search") {
    const panel = $("searchPanel");
    if (!panel) return [];
    return [...panel.querySelectorAll("input, button, label")].filter((el) => {
      if (el.tagName === "LABEL") return visible(el) && el.querySelector("input");
      return visible(el) && el.id !== "resultCount";
    });
  }
  if (zone === "dialog") {
    const dlg = $("sortDlg")?.open ? $("sortDlg") : $("groupDlg")?.open ? $("groupDlg") : null;
    if (!dlg) return [];
    return [...dlg.querySelectorAll("label, button")].filter(visible);
  }
  if (zone === "map") {
    const dlg = $("mapDlg");
    if (!dlg?.open) return [];
    return [...dlg.querySelectorAll("button, select, input")].filter(visible);
  }
  return [];
}

function syncUiFocus(opts = {}) {
  const { scroll = true, zone = uiNav.zone } = opts;
  const block = libraryUiBlocked();
  let z = zone;
  if (block) z = block;
  else if (z !== "chrome" && z !== "library") z = "library";
  uiNav.zone = z;

  clearGpItemFocus();
  if (z === "library") return;

  const items = collectUiItems(z);
  if (!items.length) {
    uiNav.index = 0;
    return;
  }
  uiNav.index = Math.max(0, Math.min(items.length - 1, uiNav.index | 0));
  const el = items[uiNav.index];
  el.classList.add("is-gp-focus");
  if (scroll) {
    try {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (_) {
      el.scrollIntoView(false);
    }
  }
}

function moveUiFocus(delta) {
  const items = collectUiItems(uiNav.zone);
  if (!items.length) return;
  uiNav.index = (uiNav.index + delta + items.length * 8) % items.length;
  syncUiFocus({ scroll: true });
}

function activateUiFocus() {
  const items = collectUiItems(uiNav.zone);
  const el = items[uiNav.index];
  if (!el) return;

  if (el.tagName === "SUMMARY") {
    const det = el.closest("details");
    if (det) {
      det.open = !det.open;
      // Rebuild list so options appear; keep focus on this summary
      const before = el;
      syncUiFocus({ scroll: false });
      const next = collectUiItems(uiNav.zone);
      const hit = next.indexOf(before);
      if (hit >= 0) {
        uiNav.index = hit;
        syncUiFocus({ scroll: true });
      }
    }
    return;
  }

  if (el.classList?.contains("filter-option")) {
    const input = el.querySelector('input[type="checkbox"]');
    if (input) {
      input.checked = !input.checked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }

  if (el.tagName === "LABEL") {
    const input = el.querySelector("input");
    if (input?.type === "radio") {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (input?.type === "checkbox") {
      input.checked = !input.checked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (input?.type === "search" || input?.type === "text") {
      try {
        input.focus();
      } catch (_) {}
      return;
    }
  }

  if (el.tagName === "INPUT") {
    if (el.type === "search" || el.type === "text") {
      try {
        el.focus();
      } catch (_) {}
      return;
    }
    if (el.type === "checkbox" || el.type === "radio") {
      if (el.type === "checkbox") el.checked = !el.checked;
      else el.checked = true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }

  if (typeof el.click === "function") el.click();
}

function enterUiZone(zone, index = 0) {
  uiNav.zone = zone;
  uiNav.index = index;
  if (zone !== "library") {
    document.querySelectorAll(".card.is-gp-focus").forEach((c) => c.classList.remove("is-gp-focus"));
  }
  syncUiFocus({ scroll: true, zone });
}

function leaveOverlayToLibrary() {
  uiNav.zone = "library";
  uiNav.index = 0;
  clearGpItemFocus();
  syncGpFocusByGameId(state.focused?.id || state.nowPlaying?.id || null);
}

function readGamepadsSafe() {
  try {
    if (!navigator.getGamepads) return [];
    return [...navigator.getGamepads()].filter(Boolean);
  } catch (_) {
    return [];
  }
}

function noteGamepadReady(label) {
  if (gpLib.seen) return;
  gpLib.seen = true;
  const name = String(label || "コントローラ").split("(")[0].trim().slice(0, 40);
  toast(`${name || "コントローラ"} · △/Yフィルタ · OPTIONSメニュー`);
  if (!visibleCards().some((c) => c.classList.contains("is-gp-focus"))) {
    syncGpFocusByGameId(state.focused?.id || state.nowPlaying?.id || null);
  }
}

function visibleCards() {
  if (state.libView === "showcase") {
    return [...document.querySelectorAll("#showcaseTrack .card[data-game-id]")];
  }
  if (state.libView === "list") {
    return [...document.querySelectorAll("#listRail .list-row[data-game-id]")];
  }
  return [...document.querySelectorAll("#library .card[data-game-id]")];
}

function colsForCard(card) {
  const rail = card?.closest(".rail");
  if (!rail) return 1;
  const cards = [...rail.querySelectorAll(".card")];
  if (cards.length < 2) return 1;
  const y0 = cards[0].offsetTop;
  let cols = 1;
  for (let i = 1; i < cards.length; i++) {
    if (Math.abs(cards[i].offsetTop - y0) > 4) break;
    cols++;
  }
  return Math.max(1, cols);
}

function syncGpFocusByGameId(gameId) {
  const cards = visibleCards();
  if (!cards.length) return;
  let idx = 0;
  if (gameId) {
    const hit = cards.findIndex((c) => c.dataset.gameId === gameId);
    if (hit >= 0) idx = hit;
  } else if (gpLib.index >= 0 && gpLib.index < cards.length) {
    idx = gpLib.index;
  }
  setGpFocus(idx, { scroll: false });
}

function setGpFocus(index, { scroll = true } = {}) {
  const cards = visibleCards();
  if (!cards.length) return;
  const i = Math.max(0, Math.min(cards.length - 1, index | 0));
  gpLib.index = i;
  cards.forEach((c, n) => c.classList.toggle("is-gp-focus", n === i));
  const g = gameById(cards[i].dataset.gameId);
  if (g) setBillboard(g);
  if (scroll) {
    if (state.libView === "showcase") {
      scrollShowcaseToSlot(cards[i]);
    } else {
      try {
        cards[i].scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
      } catch (_) {
        cards[i].scrollIntoView(false);
      }
    }
  }
}

/** Put focused tile roughly at the Nth slot from the left (CSS --showcase-focus-slot). */
function scrollShowcaseToSlot(card) {
  const track = $("showcaseTrack");
  if (!track || !card) return;
  const rootStyles = getComputedStyle(document.documentElement);
  const trackStyles = getComputedStyle(track);
  const gap = parseFloat(trackStyles.columnGap || trackStyles.gap) || 12;
  const pad = parseFloat(trackStyles.paddingLeft) || 18;
  const slotParsed = parseFloat(rootStyles.getPropertyValue("--showcase-focus-slot"));
  const focusSlot = Number.isFinite(slotParsed) ? slotParsed : 2;
  const tile = card.getBoundingClientRect().width || card.offsetWidth;
  const lead = pad + focusSlot * (tile + gap);
  const cardLeft = card.getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft;
  const left = Math.max(0, cardLeft - lead);
  try {
    track.scrollTo({ left, behavior: "smooth" });
  } catch (_) {
    track.scrollLeft = left;
  }
  requestAnimationFrame(syncShowcaseNav);
}

function syncShowcaseNav() {
  const track = $("showcaseTrack");
  const prev = $("showcaseNavPrev");
  const next = $("showcaseNavNext");
  const edgeL = document.querySelector(".showcase-edge-left");
  const edgeR = document.querySelector(".showcase-edge-right");
  if (!track || state.libView !== "showcase") {
    if (prev) prev.hidden = true;
    if (next) next.hidden = true;
    edgeL?.classList.remove("is-on");
    edgeR?.classList.remove("is-on");
    return;
  }
  const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
  const sl = track.scrollLeft;
  const atStart = sl <= 4;
  const atEnd = sl >= maxScroll - 4;
  const canScroll = maxScroll > 8;
  if (prev) prev.hidden = !(canScroll && !atStart);
  if (next) next.hidden = !(canScroll && !atEnd);
  edgeL?.classList.toggle("is-on", canScroll && !atStart);
  edgeR?.classList.toggle("is-on", canScroll && !atEnd);
}

function bindShowcaseNav() {
  if (bindShowcaseNav._done) return;
  bindShowcaseNav._done = true;
  const track = $("showcaseTrack");
  $("showcaseNavPrev")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    moveGpFocus(-1, 0);
    syncShowcaseNav();
  });
  $("showcaseNavNext")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    moveGpFocus(1, 0);
    syncShowcaseNav();
  });
  track?.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(bindShowcaseNav._t);
      bindShowcaseNav._t = window.setTimeout(syncShowcaseNav, 40);
    },
    { passive: true }
  );
  window.addEventListener("resize", () => syncShowcaseNav());
}

function moveGpFocus(dx, dy) {
  const cards = visibleCards();
  if (!cards.length) return;
  let i = cards.findIndex((c) => c.classList.contains("is-gp-focus"));
  if (i < 0) i = gpLib.index || 0;
  i = Math.max(0, Math.min(cards.length - 1, i));

  if (state.libView === "showcase") {
    setGpFocus(i + (dx || dy));
    return;
  }
  if (state.libView === "list") {
    setGpFocus(i + (dy || dx));
    return;
  }

  if (dx !== 0 && dy === 0) {
    setGpFocus(i + dx);
    return;
  }

  const card = cards[i];
  const rail = card.closest(".rail");
  const railCards = rail ? [...rail.querySelectorAll(".card")] : cards;
  const local = railCards.indexOf(card);
  const cols = colsForCard(card);
  const nextLocal = local + dy * cols + dx;

  if (nextLocal >= 0 && nextLocal < railCards.length) {
    const global = cards.indexOf(railCards[nextLocal]);
    if (global >= 0) setGpFocus(global);
    return;
  }

  const rails = [...document.querySelectorAll("#library .rail")];
  const rIdx = rails.indexOf(rail);
  const targetRail = rails[rIdx + (dy > 0 ? 1 : dy < 0 ? -1 : 0)];
  if (!targetRail) {
    setGpFocus(i + dy * cols + dx);
    return;
  }
  const tCards = [...targetRail.querySelectorAll(".card")];
  if (!tCards.length) return;
  const tCols = colsForCard(tCards[0]);
  const col = ((local % cols) + cols) % cols;
  const row = dy > 0 ? 0 : Math.floor((tCards.length - 1) / tCols);
  const dest = Math.min(tCards.length - 1, row * tCols + Math.min(col, tCols - 1));
  const global = cards.indexOf(tCards[dest]);
  if (global >= 0) setGpFocus(global);
}

async function gpConfirm() {
  const block = libraryUiBlocked();
  if (block === "filter" || block === "menu" || block === "dialog" || block === "map" || block === "search") {
    activateUiFocus();
    return;
  }
  if (block === "detail") {
    activateUiFocus();
    return;
  }
  if (uiNav.zone === "chrome") {
    activateUiFocus();
    return;
  }
  const cards = visibleCards();
  const card = cards[gpLib.index] || cards.find((c) => c.classList.contains("is-gp-focus"));
  const g = gameById(card?.dataset.gameId) || state.focused;
  if (!g) return;
  if (state.libView === "showcase") {
    setBillboard(g);
    openDetail(g);
    return;
  }
  if (state.libView === "list") {
    setBillboard(g);
    try {
      if (isNowPlaying(g)) resumeNowPlaying();
      else await launchGame(g, true);
    } catch (_) {
      toast("起動できませんでした");
    }
    return;
  }
  openDetail(g);
}

function gpBack() {
  const block = libraryUiBlocked();
  if (block === "dialog") {
    const dlg = $("sortDlg")?.open ? $("sortDlg") : $("groupDlg")?.open ? $("groupDlg") : null;
    if (dlg) {
      try {
        dlg.close("cancel");
      } catch (_) {
        dlg.close();
      }
    }
    const next = libraryUiBlocked();
    if (next) enterUiZone(next, 0);
    else leaveOverlayToLibrary();
    return;
  }
  if (block === "map") {
    try {
      $("mapDlg")?.close();
    } catch (_) {}
    leaveOverlayToLibrary();
    return;
  }
  if (block === "detail") {
    closeDetail();
    leaveOverlayToLibrary();
    syncGpFocusByGameId(state.focused?.id || state.selected?.id);
    return;
  }
  if (block === "filter" || block === "menu") {
    closeLibDrawers();
    leaveOverlayToLibrary();
    return;
  }
  if (block === "search") {
    toggleSearchPanel();
    leaveOverlayToLibrary();
    return;
  }
  if (uiNav.zone === "chrome") {
    leaveOverlayToLibrary();
    return;
  }
}

async function gpQuickLaunch() {
  const block = libraryUiBlocked();
  if (block === "dialog" || block === "map" || block === "filter" || block === "menu" || block === "search") {
    return;
  }
  if (block === "detail") {
    const g = state.selected;
    if (!g) return;
    try {
      if (isNowPlaying(g)) resumeNowPlaying();
      else await launchGame(g, true);
    } catch (_) {
      toast("起動できませんでした");
    }
    return;
  }
  const g = state.focused || gameById(visibleCards()[gpLib.index]?.dataset.gameId);
  if (!g) return;
  try {
    if (isNowPlaying(g)) resumeNowPlaying();
    else await launchGame(g, true);
  } catch (_) {
    toast("起動できませんでした");
  }
}

function gpOpenFilter() {
  if (libraryUiBlocked() === "detail") return;
  if (libraryUiBlocked() === "dialog" || libraryUiBlocked() === "map") return;
  if (!$("filterPanel")?.classList.contains("hidden")) {
    closeLibDrawers();
    leaveOverlayToLibrary();
    return;
  }
  openDrawer("filterPanel");
  enterUiZone("filter", 0);
}

function gpOpenMenu() {
  if (libraryUiBlocked() === "detail") return;
  if (libraryUiBlocked() === "dialog" || libraryUiBlocked() === "map") return;
  if (!$("mainMenu")?.classList.contains("hidden")) {
    closeLibDrawers();
    leaveOverlayToLibrary();
    return;
  }
  openDrawer("mainMenu");
  enterUiZone("menu", 0);
}

function gpJumpTiles(delta) {
  const cards = visibleCards();
  if (!cards.length) return;
  setGpFocus((gpLib.index || 0) + delta);
}

function gpEdge(dir, pressed, now, slot) {
  const hold = slot.hold || (slot.hold = {});
  const stepKey = `${dir}Step`;
  if (!pressed) {
    hold[dir] = 0;
    hold[stepKey] = -1;
    return false;
  }
  if (!hold[dir]) {
    hold[dir] = now;
    hold[stepKey] = -1;
    return true;
  }
  const held = now - hold[dir];
  if (held < 280) return false;
  const step = Math.floor((held - 280) / 90);
  if (hold[stepKey] === step) return false;
  hold[stepKey] = step;
  return true;
}

function readPadDirections(gp, buttons) {
  const dead = 0.38;
  const ax0 = gp.axes[0] || 0;
  const ax1 = gp.axes[1] || 0;
  const ax2 = gp.axes[2] || 0;
  const ax3 = gp.axes[3] || 0;
  return {
    left: ax0 < -dead || ax2 < -dead || !!buttons[14],
    right: ax0 > dead || ax2 > dead || !!buttons[15],
    up: ax1 < -dead || ax3 < -dead || !!buttons[12],
    down: ax1 > dead || ax3 > dead || !!buttons[13],
  };
}

function blurTypingTarget() {
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/i.test(ae.tagName)) {
    try {
      ae.blur();
    } catch (_) {}
  }
}

/** Shared edge handling for browser Gamepad OR host XInput/winmm snapshot. */
function applyPadFrame(padKey, axes, face, now) {
  if (!gpLib.prev[padKey]) {
    gpLib.prev[padKey] = {
      axes: { ...axes },
      face: { ...face },
      hold: {},
    };
    return;
  }
  const prev = gpLib.prev[padKey];
  const block = libraryUiBlocked();
  const just = (k) => !!(face[k] && !prev.face?.[k]);

  // Keep uiNav.zone aligned with open overlays
  if (block && uiNav.zone !== block) {
    enterUiZone(block, uiNav.zone === block ? uiNav.index : 0);
  }

  const overlay =
    block === "filter" ||
    block === "menu" ||
    block === "dialog" ||
    block === "map" ||
    block === "search" ||
    block === "detail";

  if (overlay) {
    if (block === "detail") {
      // Stick / d-pad: horizontal = actions, vertical = scroll page
      if (gpEdge("left", !!axes.left, now, prev) && !axes.right) moveUiFocus(-1);
      if (gpEdge("right", !!axes.right, now, prev) && !axes.left) moveUiFocus(1);
      if (gpEdge("up", !!axes.up, now, prev) && !axes.down) {
        window.scrollBy({ top: -140, behavior: "smooth" });
      }
      if (gpEdge("down", !!axes.down, now, prev) && !axes.up) {
        window.scrollBy({ top: 140, behavior: "smooth" });
      }
    } else {
      if (gpEdge("up", !!axes.up, now, prev) && !axes.down) moveUiFocus(-1);
      if (gpEdge("down", !!axes.down, now, prev) && !axes.up) moveUiFocus(1);
      if (gpEdge("left", !!axes.left, now, prev) && !axes.right) moveUiFocus(-1);
      if (gpEdge("right", !!axes.right, now, prev) && !axes.left) moveUiFocus(1);
    }

    if (just("a")) {
      blurTypingTarget();
      gpConfirm();
    } else if (just("b")) {
      blurTypingTarget();
      gpBack();
    }
    if (just("x") && block === "detail") {
      blurTypingTarget();
      gpQuickLaunch();
    }

    gpLib.prev[padKey] = {
      axes: { ...axes },
      face: { ...face },
      hold: prev.hold || {},
    };
    return;
  }

  // Chrome bar focus (reached by pressing up from first game)
  if (uiNav.zone === "chrome") {
    if (gpEdge("left", !!axes.left, now, prev) && !axes.right) moveUiFocus(-1);
    if (gpEdge("right", !!axes.right, now, prev) && !axes.left) moveUiFocus(1);
    if (gpEdge("up", !!axes.up, now, prev) && !axes.down) moveUiFocus(-1);
    if (gpEdge("down", !!axes.down, now, prev) && !axes.up) {
      leaveOverlayToLibrary();
    }
    if (just("a")) {
      blurTypingTarget();
      activateUiFocus();
    } else if (just("b")) {
      leaveOverlayToLibrary();
    }
    if (just("y")) gpOpenFilter();
    if (just("start")) gpOpenMenu();

    gpLib.prev[padKey] = {
      axes: { ...axes },
      face: { ...face },
      hold: prev.hold || {},
    };
    return;
  }

  // Library browse
  if (gpEdge("left", !!axes.left, now, prev) && !axes.right) {
    blurTypingTarget();
    moveGpFocus(-1, 0);
  }
  if (gpEdge("right", !!axes.right, now, prev) && !axes.left) {
    blurTypingTarget();
    moveGpFocus(1, 0);
  }
  if (gpEdge("up", !!axes.up, now, prev) && !axes.down) {
    blurTypingTarget();
    const cards = visibleCards();
    const card = cards[gpLib.index];
    let atTop = (gpLib.index || 0) <= 0;
    if (card && state.libView !== "showcase") {
      const rails = [...document.querySelectorAll("#library .rail")];
      const rail = card.closest(".rail");
      const rIdx = rails.indexOf(rail);
      const railCards = rail ? [...rail.querySelectorAll(".card")] : cards;
      const local = railCards.indexOf(card);
      const cols = colsForCard(card);
      atTop = rIdx <= 0 && local >= 0 && local < cols;
    }
    if (atTop) {
      const chromeItems = collectUiItems("chrome");
      if (chromeItems.length) enterUiZone("chrome", Math.max(0, chromeItems.length - 1));
    } else {
      moveGpFocus(0, -1);
    }
  }
  if (gpEdge("down", !!axes.down, now, prev) && !axes.up) {
    blurTypingTarget();
    moveGpFocus(0, 1);
  }

  if (just("a")) {
    blurTypingTarget();
    gpConfirm();
  } else if (just("b")) {
    blurTypingTarget();
    gpBack();
  }
  if (just("x")) {
    blurTypingTarget();
    gpQuickLaunch();
  }
  if (just("y")) {
    blurTypingTarget();
    gpOpenFilter();
  }
  if (just("start")) {
    blurTypingTarget();
    gpOpenMenu();
  }
  if (just("select")) {
    blurTypingTarget();
    if (state.nowPlaying?.id) resumeNowPlaying();
    else toggleSearchPanel();
    if (!$("searchPanel")?.classList.contains("hidden")) enterUiZone("search", 0);
    else leaveOverlayToLibrary();
  }
  if (just("l1")) gpJumpTiles(state.libView === "showcase" ? -4 : -8);
  if (just("r1")) gpJumpTiles(state.libView === "showcase" ? 4 : 8);

  gpLib.prev[padKey] = {
    axes: { ...axes },
    face: { ...face },
    hold: prev.hold || {},
  };
}

function pollLibraryGamepad() {
  // Browser pads are forwarded from controls.js via GameRemoteLibraryPad.
  // This rAF only keeps the loop alive for status; host uses setInterval.
  requestAnimationFrame(pollLibraryGamepad);
}

function getFaceLayout(gp) {
  try {
    if (localStorage.getItem("gr_face_fix_v1") !== "1") {
      localStorage.setItem("gr_face_fix_v1", "1");
      if (localStorage.getItem("gr_face_layout") === "ps") {
        localStorage.removeItem("gr_face_layout");
      }
      if (localStorage.getItem("gr_face_layout_auto") === "ps") {
        localStorage.removeItem("gr_face_layout_auto");
      }
    }
  } catch (_) {}
  const pref = localStorage.getItem("gr_face_layout");
  if (pref === "ps" || pref === "xbox") return pref;
  return "xbox";
}

/** Xbox standard indices → logical face. PS (Steam/Xbox wrap) swaps A↔B and X↔Y. */
function faceFromButtons(gp, buttons) {
  const layout = getFaceLayout(gp);
  const shoulders = {
    l1: !!buttons[4],
    r1: !!buttons[5],
    select: !!buttons[8],
    start: !!buttons[9],
  };
  if (layout === "ps") {
    return {
      a: !!buttons[1],
      b: !!buttons[0],
      x: !!buttons[3],
      y: !!buttons[2],
      ...shoulders,
    };
  }
  return {
    a: !!buttons[0],
    b: !!buttons[1],
    x: !!buttons[2],
    y: !!buttons[3],
    ...shoulders,
  };
}

function remapNamedFace(face, gp) {
  if (!face) return face;
  if (getFaceLayout(gp) !== "ps") return face;
  return {
    a: !!face.b,
    b: !!face.a,
    x: !!face.y,
    y: !!face.x,
    select: !!face.select,
    start: !!face.start,
    l1: !!face.l1,
    r1: !!face.r1,
    l2: !!face.l2,
    r2: !!face.r2,
    l3: !!face.l3,
    r3: !!face.r3,
    up: !!face.up,
    down: !!face.down,
    left: !!face.left,
    right: !!face.right,
  };
}

window.GameRemoteFaceLayout = getFaceLayout;

function handleBrowserPad(gp, now = performance.now()) {
  if (!gp) return;
  // Host latch must not block local pads (and must be cleared when host isn't allowed)
  if (gpLib.hostPrev && hostPadAllowed()) return;
  noteGamepadReady(gp.id || "コントローラ");
  const buttons = [];
  for (let i = 0; i < gp.buttons.length; i++) {
    const b = gp.buttons[i];
    buttons[i] = !!(b && (b.pressed || b.value > 0.45));
  }
  const axes = readPadDirections(gp, buttons);
  applyPadFrame(`browser:${gp.index}`, axes, faceFromButtons(gp, buttons), now);
}

// Called from controls.js poll loop (same getGamepads source as play page)
window.GameRemoteLibraryPad = handleBrowserPad;

/* On-screen pad → library / detail navigation (same actions as physical pad) */
const libUiPad = { dirs: {}, face: {} };
window.GameRemoteLibraryAction = function (action, pressed) {
  if (document.body.classList.contains("play-shell")) return;
  const now = performance.now();
  const dirs = ["up", "down", "left", "right"];
  const faces = ["a", "b", "x", "y", "start", "select", "l1", "r1"];
  if (dirs.includes(action)) {
    libUiPad.dirs[action] = !!pressed;
  }
  const nextFace = { ...libUiPad.face };
  if (faces.includes(action)) {
    nextFace[action] = !!pressed;
  }
  applyPadFrame(
    "ui-pad",
    {
      left: !!libUiPad.dirs.left,
      right: !!libUiPad.dirs.right,
      up: !!libUiPad.dirs.up,
      down: !!libUiPad.dirs.down,
    },
    {
      a: !!nextFace.a,
      b: !!nextFace.b,
      x: !!nextFace.x,
      y: !!nextFace.y,
      start: !!nextFace.start,
      select: !!nextFace.select,
      l1: !!nextFace.l1,
      r1: !!nextFace.r1,
    },
    now
  );
  if (faces.includes(action)) {
    libUiPad.face = nextFace;
  }
};

function hostPadAllowed() {
  // Host XInput is shared by ALL library clients. Sunshine also exposes a virtual
  // pad on the PC while streaming — without these guards, every open library tab
  // (other PC / background) would navigate together with the stream controller.
  if (typeof document !== "undefined") {
    if (document.visibilityState === "hidden") return false;
    try {
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    } catch (_) {}
  }
  // While a game stream is live on the host, XInput is for the game — not the library UI
  if (state.nowPlaying?.id && state.nowPlaying.alive) return false;
  // Prefer this device's own Gamepad API when available
  if (readGamepadsSafe().length > 0) return false;
  return true;
}

function clearHostPadLatch() {
  if (!gpLib.hostPrev) return;
  gpLib.hostPrev = null;
  delete gpLib.prev.host;
}

async function pollHostPad() {
  try {
    if (!hostPadAllowed()) {
      clearHostPadLatch();
      return;
    }
    const res = await fetch("/api/input/pad-state", { cache: "no-store" });
    if (!res.ok) return;
    if (!hostPadAllowed()) {
      clearHostPadLatch();
      return;
    }
    const data = await res.json();
    const pad = data.pads && data.pads[0];
    if (!pad) {
      clearHostPadLatch();
      if (!readGamepadsSafe().length) gpLib.seen = false;
      return;
    }
    noteGamepadReady(pad.id || data.backend || "ホストパッド");
    gpLib.hostPrev = pad;
    // XInput reports Xbox layout; PS via Steam needs A↔B / X↔Y for Circle=決定
    applyPadFrame(
      "host",
      pad.axes || {},
      remapNamedFace(pad.buttons || {}, { id: pad.id }),
      performance.now()
    );
  } catch (_) {
    /* server restarting */
  }
}

function updatePadDetectStatus() {
  /* chrome status removed */
}

function bindLibraryGamepad() {
  if (gpLib.armed) return;
  gpLib.armed = true;

  window.addEventListener("gamepadconnected", (e) => {
    noteGamepadReady(e.gamepad?.id || "コントローラ");
    if (e.gamepad) delete gpLib.prev[`browser:${e.gamepad.index}`];
    updatePadDetectStatus();
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    if (e.gamepad) delete gpLib.prev[`browser:${e.gamepad.index}`];
    updatePadDetectStatus();
  });

  window.addEventListener(
    "pointerdown",
    () => {
      // Wake Gamepad API gesture + nudge
      readGamepadsSafe();
      if (gpLib.seen || gpLib._hinted) return;
      gpLib._hinted = true;
      if (!readGamepadsSafe().length && !gpLib.hostPrev) {
        toast("コントローラのボタンを押してください（Steam占有時はSteamを終了）");
      }
    },
    { once: true }
  );

  document.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) {
      if (e.key === "Escape") {
        e.preventDefault();
        gpBack();
      }
      return;
    }
    const block = libraryUiBlocked();
    if (block === "filter" || block === "menu" || block === "dialog" || block === "map" || block === "search" || block === "detail") {
      const overlayMap = {
        ArrowUp: () => (block === "detail" ? window.scrollBy({ top: -140, behavior: "smooth" }) : moveUiFocus(-1)),
        ArrowDown: () => (block === "detail" ? window.scrollBy({ top: 140, behavior: "smooth" }) : moveUiFocus(1)),
        ArrowLeft: () => moveUiFocus(-1),
        ArrowRight: () => moveUiFocus(1),
        Enter: () => gpConfirm(),
        Escape: () => gpBack(),
        " ": () => (block === "detail" ? gpQuickLaunch() : gpConfirm()),
      };
      const fn = overlayMap[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
      return;
    }
    if (uiNav.zone === "chrome") {
      const chromeMap = {
        ArrowLeft: () => moveUiFocus(-1),
        ArrowRight: () => moveUiFocus(1),
        ArrowUp: () => moveUiFocus(-1),
        ArrowDown: () => leaveOverlayToLibrary(),
        Enter: () => activateUiFocus(),
        Escape: () => leaveOverlayToLibrary(),
      };
      const fn = chromeMap[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      gpOpenFilter();
      return;
    }
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      gpOpenMenu();
      return;
    }
    const map = {
      ArrowLeft: () => moveGpFocus(-1, 0),
      ArrowRight: () => moveGpFocus(1, 0),
      ArrowUp: () => {
        const cards = visibleCards();
        const card = cards[gpLib.index];
        let atTop = (gpLib.index || 0) <= 0;
        if (card && state.libView !== "showcase") {
          const rails = [...document.querySelectorAll("#library .rail")];
          const rail = card.closest(".rail");
          const rIdx = rails.indexOf(rail);
          const railCards = rail ? [...rail.querySelectorAll(".card")] : cards;
          const local = railCards.indexOf(card);
          const cols = colsForCard(card);
          atTop = rIdx <= 0 && local >= 0 && local < cols;
        }
        if (atTop) {
          const chromeItems = collectUiItems("chrome");
          if (chromeItems.length) enterUiZone("chrome", Math.max(0, chromeItems.length - 1));
        } else moveGpFocus(0, -1);
      },
      ArrowDown: () => moveGpFocus(0, 1),
      Enter: () => gpConfirm(),
      Escape: () => gpBack(),
      " ": () => gpQuickLaunch(),
    };
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  });

  requestAnimationFrame(pollLibraryGamepad);
  pollHostPad();
  // 33ms was ~30 req/s; 80ms is enough for UI nav and much lighter on the library API.
  const HOST_PAD_MS = 80;
  gpLib.hostTimer = window.setInterval(pollHostPad, HOST_PAD_MS);
  window.setInterval(updatePadDetectStatus, 2000);
  // Keep now-playing in sync so host-pad stays off while another device is streaming
  window.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refreshNowPlaying().then(() => {
      if (state.nowPlaying?.alive) clearHostPadLatch();
    });
  }, 4000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearHostPadLatch();
      if (gpLib.hostTimer) {
        clearInterval(gpLib.hostTimer);
        gpLib.hostTimer = null;
      }
    } else if (!gpLib.hostTimer) {
      pollHostPad();
      gpLib.hostTimer = window.setInterval(pollHostPad, HOST_PAD_MS);
    }
  });
  window.addEventListener("blur", () => clearHostPadLatch());
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name) || (attr.name === "href" && /^javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

async function hydrateGame(g) {
  if (!g?.id) return g;
  if (g.description && !g.descriptionTruncated && g.notes != null) return g;
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(g.id)}`);
    if (!res.ok) return g;
    const full = await res.json();
    const idx = state.games.findIndex((x) => x.id === g.id);
    if (idx >= 0) state.games[idx] = { ...state.games[idx], ...full, descriptionTruncated: false };
    return idx >= 0 ? state.games[idx] : { ...g, ...full };
  } catch (_) {
    return g;
  }
}

function fillDetail(g) {
  const url = bgOf(g);
  const detailArt = $("detailArt");
  if (detailArt) {
    if (url) {
      prefetchArtUrl(url).then(() => {
        if (state.selected?.id !== g.id) return;
        detailArt.style.backgroundImage = `url("${url}")`;
      });
    } else {
      detailArt.style.backgroundImage = "none";
    }
  }
  $("detailTitle").textContent = g.name || "";
  $("detailEyebrow").textContent = (g.platforms || []).join(" / ") || g.source || "Playnite";
  $("detailStats").innerHTML = [
    `<span>プレイ ${hours(g.playtime)}</span>`,
    `<span>最近 ${fmtDate(g.lastActivity)}</span>`,
    `<span>${g.isInstalled ? "インストール済" : "未インストール"}</span>`,
  ].join("");
  const tags = [...(g.tags || []), ...(g.genres || []), ...(g.categories || [])];
  $("detailTags").innerHTML = tags.slice(0, 24).map((t) => `<span>${escapeHtml(t)}</span>`).join("");

  $("detailPlay").textContent = isNowPlaying(g) ? "ストリームに戻る" : "起動してストリーム";

  const meta = [
    ["開発", (g.developers || []).join(", ")],
    ["発売", (g.publishers || []).join(", ")],
    ["追加日", fmtDate(g.added)],
    ["リリース", fmtDate(g.releaseDate)],
    ["インストール先", g.installDirectory || "—"],
    ["容量", g.installSize ? `${(g.installSize / 1024 ** 3).toFixed(2)} GB` : "—"],
    ["完成度", g.completionStatus || "—"],
    ["シリーズ", g.series || "—"],
    ["バージョン", g.version || "—"],
  ];
  $("detailMeta").innerHTML = meta
    .filter(([, v]) => v && v !== "—")
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");

  $("detailDesc").innerHTML = sanitizeHtml(g.description || "<p>説明はありません。</p>");
  if (g.notes) {
    $("notesHead").classList.remove("hidden");
    $("detailNotes").classList.remove("hidden");
    $("detailNotes").innerHTML = sanitizeHtml(g.notes);
  } else {
    $("notesHead").classList.add("hidden");
    $("detailNotes").classList.add("hidden");
  }
}

function openDetail(g) {
  state.selected = g;
  setBillboard(g);
  window.GameControls?.setContextGame?.(g);
  $("library").classList.add("hidden");
  $("billboard").classList.add("hidden");
  $("showcase")?.classList.add("hidden");
  $("listView")?.classList.add("hidden");
  $("searchPanel")?.classList.add("hidden");
  $("searchPanel")?.setAttribute("aria-hidden", "true");
  closeLibDrawers();
  $("detail").classList.remove("hidden");
  $("detail").setAttribute("aria-hidden", "false");
  fillDetail(g);
  hydrateGame(g).then((full) => {
    if (state.selected?.id !== g.id) return;
    state.selected = full;
    fillDetail(full);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
  enterUiZone("detail", 0);
}

function closeDetail() {
  $("detail").classList.add("hidden");
  $("detail").setAttribute("aria-hidden", "true");
  $("library").classList.remove("hidden");
  applyLibView();
  if (state.libView === "grid") {
    $("billboard").classList.remove("hidden");
  }
  leaveOverlayToLibrary();
}

function closeLibDrawers() {
  $("filterPanel")?.classList.add("hidden");
  $("filterPanel")?.setAttribute("aria-hidden", "true");
  $("mainMenu")?.classList.add("hidden");
  $("mainMenu")?.setAttribute("aria-hidden", "true");
  $("menuBackdrop")?.classList.add("hidden");
  $("menuBackdrop")?.setAttribute("hidden", "");
  $("btnMainMenu")?.setAttribute("aria-expanded", "false");
  if (uiNav.zone === "filter" || uiNav.zone === "menu") {
    uiNav.zone = "library";
    clearGpItemFocus();
  }
}

function openDrawer(id) {
  closeLibDrawers();
  const search = $("searchPanel");
  if (search && !search.classList.contains("hidden")) {
    search.classList.add("hidden");
    search.setAttribute("aria-hidden", "true");
    $("btnSearch")?.setAttribute("aria-expanded", "false");
  }
  const el = $(id);
  if (!el) return;
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  $("menuBackdrop")?.classList.remove("hidden");
  $("menuBackdrop")?.removeAttribute("hidden");
  if (id === "mainMenu") $("btnMainMenu")?.setAttribute("aria-expanded", "true");
  if (id === "filterPanel") enterUiZone("filter", 0);
  else if (id === "mainMenu") enterUiZone("menu", 0);
}

function toggleSearchPanel() {
  const panel = $("searchPanel");
  if (!panel) return;
  const open = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  $("btnSearch")?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    $("search")?.focus();
    enterUiZone("search", 0);
  } else if (uiNav.zone === "search") {
    leaveOverlayToLibrary();
  }
}

async function launchGame(g, openStreamAfter = true) {
  if (!g) return;
  notifyPress(null, openStreamAfter ? "起動してストリーム…" : "起動しています…");
  window.GameControls?.setContextGame?.(g);

  const res = await fetch("/api/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: g.id }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
  if (data.stream_url) syncStreamUrl(data.stream_url);
  state.nowPlaying = { id: g.id, name: g.name || "", alive: true };
  try {
    localStorage.setItem("gr_now_playing", JSON.stringify({ id: g.id, name: g.name || "" }));
  } catch (_) {}
  syncResumeChrome();
  setStatus(data.message || "起動しました");
  toast(data.message || "ゲームを起動しました");
  if (openStreamAfter) {
    const delay = Math.min(Number(data.stream_delay_ms) || 0, 400);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (window.matchMedia("(pointer: coarse)").matches) {
      window.GameControls?.setPadVisible(true);
    }
    openStream({ game: g, launch: false, mwApp: "Desktop" });
  }
}

function buildFilterPanel() {
  const root = $("filterFields");
  root.innerHTML = "";
  for (const conf of FILTER_KEYS) {
    const values = new Map();
    for (const g of state.games) {
      const v = g[conf.key];
      if (Array.isArray(v)) v.forEach((x) => x && values.set(x, (values.get(x) || 0) + 1));
      else if (v) values.set(v, (values.get(v) || 0) + 1);
    }
    if (!values.size) continue;
    const details = document.createElement("details");
    details.open = !!(state.filters[conf.key]?.length);
    const sorted = [...values.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));
    details.innerHTML = `<summary>${conf.label} (${sorted.length})</summary>`;
    for (const [name, count] of sorted.slice(0, 80)) {
      const label = document.createElement("label");
      label.className = "filter-option";
      const checked = (state.filters[conf.key] || []).includes(name);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.fkey = conf.key;
      input.value = name;
      input.checked = checked;
      label.appendChild(input);
      label.appendChild(document.createTextNode(` ${name} `));
      const c = document.createElement("span");
      c.style.opacity = "0.5";
      c.textContent = String(count);
      label.appendChild(c);
      details.appendChild(label);
    }
    root.appendChild(details);
  }
  root.querySelectorAll("input[type=checkbox][data-fkey]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.fkey;
      const selected = [...root.querySelectorAll(`input[data-fkey="${key}"]:checked`)].map((x) => x.value);
      if (selected.length) state.filters[key] = selected;
      else delete state.filters[key];
      localStorage.setItem("gr_filters", JSON.stringify(state.filters));
      renderLibrary();
    });
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function boot() {
  syncStreamUrl(streamUrlFromPage());
  applyLibView();
  bindShowcaseNav();
  await refreshStreamUrlFromHealth();

  document.querySelectorAll('#sortDlg input[name="sort"]').forEach((el) => {
    el.checked = el.value === state.sort;
  });
  const dirNow = effectiveSortDir();
  document.querySelectorAll('#sortDlg input[name="sortDir"]').forEach((el) => {
    el.checked = el.value === dirNow;
  });
  // When changing sort key in the dialog, jump to that key's natural direction
  document.querySelectorAll('#sortDlg input[name="sort"]').forEach((el) => {
    el.addEventListener("change", () => {
      const d = defaultSortDir(el.value);
      document.querySelectorAll('#sortDlg input[name="sortDir"]').forEach((r) => {
        r.checked = r.value === d;
      });
    });
  });
  document.querySelectorAll('#groupDlg input[name="group"]').forEach((el) => {
    el.checked = el.value === state.group;
  });

  $("search")?.addEventListener("input", debounce(() => fetchGames(false), 250));
  $("installedOnly")?.addEventListener("change", () => fetchGames(false));
  $("favoriteOnly")?.addEventListener("change", () => fetchGames(false));
  $("btnRefresh")?.addEventListener("click", () => {
    closeLibDrawers();
    fetchGames(true);
    toast("ライブラリを更新しています…");
  });
  $("btnSearch")?.addEventListener("click", () => toggleSearchPanel());
  $("btnFilterMenu")?.addEventListener("click", () => {
    if ($("filterPanel")?.classList.contains("hidden")) openDrawer("filterPanel");
    else closeLibDrawers();
  });
  $("btnMainMenu")?.addEventListener("click", () => {
    if ($("mainMenu")?.classList.contains("hidden")) openDrawer("mainMenu");
    else closeLibDrawers();
  });
  $("filterClose")?.addEventListener("click", () => closeLibDrawers());
  $("mainMenuClose")?.addEventListener("click", () => closeLibDrawers());
  $("menuBackdrop")?.addEventListener("click", () => closeLibDrawers());
  $("clearFilters")?.addEventListener("click", () => {
    state.filters = {};
    localStorage.setItem("gr_filters", "{}");
    buildFilterPanel();
    renderLibrary();
  });
  $("btnSort")?.addEventListener("click", () => {
    document.querySelectorAll('#sortDlg input[name="sort"]').forEach((el) => {
      el.checked = el.value === state.sort;
    });
    const d = effectiveSortDir();
    document.querySelectorAll('#sortDlg input[name="sortDir"]').forEach((el) => {
      el.checked = el.value === d;
    });
    $("sortDlg").showModal();
    enterUiZone("dialog", 0);
  });
  $("btnGroup")?.addEventListener("click", () => {
    $("groupDlg").showModal();
    enterUiZone("dialog", 0);
  });
  $("sortDlg")?.addEventListener("close", () => {
    if (libraryUiBlocked() === "filter") enterUiZone("filter", 0);
  });
  $("groupDlg")?.addEventListener("close", () => {
    if (libraryUiBlocked() === "filter") enterUiZone("filter", 0);
  });
  $("btnView")?.addEventListener("click", () => {
    toggleLibView();
    closeLibDrawers();
  });
  const syncFaceLayoutBtn = () => {
    const btn = $("btnFaceLayout");
    if (!btn) return;
    const pref = localStorage.getItem("gr_face_layout") || "auto";
    const label =
      pref === "ps" ? "面ボタン: PS（○決定）" : pref === "xbox" ? "面ボタン: Xbox（A決定）" : "面ボタン: 自動";
    btn.textContent = label;
  };
  syncFaceLayoutBtn();
  $("btnFaceLayout")?.addEventListener("click", () => {
    const cur = localStorage.getItem("gr_face_layout") || "auto";
    const next = cur === "auto" ? "ps" : cur === "ps" ? "xbox" : "auto";
    localStorage.setItem("gr_face_layout", next);
    syncFaceLayoutBtn();
    toast(
      next === "ps"
        ? "PS配列（○決定 / ×戻る）"
        : next === "xbox"
          ? "Xbox配列（A決定 / B戻る）"
          : "自動検出"
    );
  });
  $("sortDlg").addEventListener("close", () => {
    if ($("sortDlg").returnValue !== "ok") return;
    state.sort = document.querySelector('#sortDlg input[name="sort"]:checked')?.value || "name";
    state.sortDir = document.querySelector('#sortDlg input[name="sortDir"]:checked')?.value || defaultSortDir(state.sort);
    localStorage.setItem("gr_sort", state.sort);
    localStorage.setItem("gr_sort_dir", state.sortDir);
    renderLibrary();
  });
  $("groupDlg").addEventListener("close", () => {
    if ($("groupDlg").returnValue !== "ok") return;
    state.group = document.querySelector('#groupDlg input[name="group"]:checked')?.value || "none";
    localStorage.setItem("gr_group", state.group);
    renderLibrary();
  });

  $("btnMwDesktop")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "デスクトップをストリーム…");
    openMoonlightApp("Desktop", "デスクトップ");
  });
  $("btnMwPlaynite")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "Playnite をストリーム…");
    openMoonlightApp("Playnite", "Playnite");
  });
  $("btnMwSteam")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "Steam をストリーム…");
    openMoonlightApp("Steam", "Steam");
  });

  $("btnResumePlay")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "ストリームに戻ります…");
    resumeNowPlaying();
  });
  $("bbResume")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "ストリームに戻ります…");
    resumeNowPlaying();
  });
  $("scResume")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "ストリームに戻ります…");
    resumeNowPlaying();
  });
  $("scPlay")?.addEventListener("click", async (e) => {
    const g = state.focused;
    if (!g) return;
    notifyPress(e.currentTarget, isNowPlaying(g) ? "ストリームに戻ります…" : "起動してストリーム…");
    try {
      if (isNowPlaying(g)) resumeNowPlaying();
      else await launchGame(g, true);
    } catch (err) {
      toast(String(err.message || err));
    }
  });
  $("scOpen")?.addEventListener("click", () => {
    if (state.focused) openDetail(state.focused);
  });
  $("listResume")?.addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "ストリームに戻ります…");
    resumeNowPlaying();
  });
  $("listPlay")?.addEventListener("click", async (e) => {
    const g = state.focused;
    if (!g) return;
    notifyPress(e.currentTarget, isNowPlaying(g) ? "ストリームに戻ります…" : "起動してストリーム…");
    try {
      if (isNowPlaying(g)) resumeNowPlaying();
      else await launchGame(g, true);
    } catch (err) {
      toast(String(err.message || err));
    }
  });
  $("listOpen")?.addEventListener("click", () => {
    if (state.focused) openDetail(state.focused);
  });

  $("detailStreamOnly").addEventListener("click", (e) => {
    notifyPress(e.currentTarget, "ストリームのみ開きます…");
    openMoonlightApp("Desktop", "デスクトップ");
  });
  $("detailBack").addEventListener("click", closeDetail);
  $("detailPlay").addEventListener("click", async (e) => {
    notifyPress(
      e.currentTarget,
      isNowPlaying(state.selected) ? "ストリームに戻ります…" : "起動してストリーム…"
    );
    try {
      if (isNowPlaying(state.selected)) {
        resumeNowPlaying();
        return;
      }
      await launchGame(state.selected, true);
    } catch (err) {
      toast("起動できませんでした");
    }
  });
  $("bbPlay").addEventListener("click", async (e) => {
    notifyPress(e.currentTarget, "起動してストリーム…");
    try {
      await launchGame(state.focused, true);
    } catch (err) {
      toast("起動できませんでした");
    }
  });
  $("bbOpen").addEventListener("click", () => {
    if (state.focused) openDetail(state.focused);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    refreshNowPlaying().then(() => {
      renderLibrary();
      if (state.nowPlaying?.id) {
        const g = gameById(state.nowPlaying.id);
        if (g) setBillboard(g);
      } else {
        syncBillboardActions(state.focused);
      }
    });
  });

  window.GameControls?.init();
  bindLibraryGamepad();
  bindListSplitter();
  await fetchGames(false);
  fetchGames(true).catch(() => {});
}

boot().catch((e) => {
  setStatus("エラー: " + e.message);
  toast("読み込みエラー: " + e.message);
});
