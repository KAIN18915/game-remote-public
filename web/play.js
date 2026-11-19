(function () {
  const STREAM_PORT = 8080;
  const params = new URLSearchParams(location.search);

  // Tailscale MTU is 1280. 20 Mbps GameStream/WebSocket over it fragments and
  // the picture gets blockier. On the home LAN the host is reached directly over Ethernet/Wi-Fi.
  function streamPath() {
    const host = String(location.hostname || "").toLowerCase();
    const tailscale =
      host.endsWith(".ts.net") ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
    if (tailscale) {
      return {
        kind: "tailscale",
        transport: "websocket",
        fps: 30,
        bitrate: { "720p": 6000, "1080p": 8000, "1440p": 8000, "4k": 8000, native: 8000 },
      };
    }
    return {
      kind: "lan",
      transport: "webrtc",
      fps: 60,
      bitrate: { "720p": 12000, "1080p": 20000, "1440p": 30000, "4k": 40000, native: 20000 },
    };
  }

  function defaultStreamUrl() {
    const app = params.get("mwApp") || "Desktop";
    return `${location.protocol}//${location.hostname}:${STREAM_PORT}/auto.html?app=${encodeURIComponent(app)}`;
  }

  const RES_ORDER = ["720p", "1080p", "1440p", "4k", "native"];
  const RES_LABELS = {
    "720p": "720p",
    "1080p": "1080p",
    "1440p": "1440p",
    "4k": "4K",
    native: "画面合わせ",
  };
  const RES_SIZE = {
    "720p": { width: 1280, height: 720 },
    "1080p": { width: 1920, height: 1080 },
    "1440p": { width: 2560, height: 1440 },
    "4k": { width: 3840, height: 2160 },
  };
  // Bitrate/fps follow the page host: LAN Ethernet vs Tailscale MTU 1280.
  const STREAM_PATH = streamPath();
  const RES_BITRATE = STREAM_PATH.bitrate;
  const STREAM_FPS = STREAM_PATH.fps;

  function preferredStreamRes() {
    const v = localStorage.getItem("gr_stream_res");
    if (localStorage.getItem("gr_stream_res_explicit") === "1" && RES_ORDER.includes(v)) return v;
    return STREAM_PATH.kind === "tailscale" ? "720p" : "1080p";
  }

  function syncStreamResButton(res) {
    const btn = document.getElementById("btnStreamRes");
    if (!btn) return;
    const r = res || preferredStreamRes();
    btn.dataset.mode = r;
    btn.textContent = `解像度: ${RES_LABELS[r] || r}`;
  }

  function withStreamSettings(url) {
    try {
      const u = new URL(url, location.href);
      const res = preferredStreamRes();
      u.searchParams.set("videoSize", res);
      const size = RES_SIZE[res];
      if (size) {
        u.searchParams.set("width", String(size.width));
        u.searchParams.set("height", String(size.height));
      }
      const br = RES_BITRATE[res];
      if (br) u.searchParams.set("bitrate", String(br));
      u.searchParams.set("fps", String(STREAM_FPS));
      // Tailscale / NAT では WebRTC ICE が切れやすく、15秒後に
      // "Failed to establish WebRTC connection..." が出る。同じ :8080 の
      // WebSocket なら Tailscale TCP だけで通る。
      const transport = localStorage.getItem("gr_stream_transport");
      u.searchParams.set(
        "dataTransport",
        transport === "webrtc" || transport === "auto" || transport === "websocket"
          ? transport
          : STREAM_PATH.transport,
      );
      return u.href;
    } catch (_) {
      return url;
    }
  }

  async function applyHostDisplayForRes(res) {
    // Only called from the pull-menu resolution picker (not on launch/auto-start).
    if (res === "native") {
      try {
        const r = await fetch("/api/display/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || data.error || "restore");
        return { ...data, restored: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    const size = RES_SIZE[res];
    if (!size) return null;
    try {
      const r = await fetch("/api/display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          width: size.width,
          height: size.height,
          save_backup: true,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || data.error || "display");
      return data;
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  function toast(msg, ms = 2400) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), ms);
  }

  function streamUrl() {
    const fromQuery = params.get("stream");
    let base;
    if (fromQuery) {
      try {
        base = new URL(fromQuery, location.origin).href;
      } catch (_) {
        base = fromQuery;
      }
    } else {
      base = defaultStreamUrl();
    }
    return withStreamSettings(base);
  }

  async function loadStream() {
    const frame = document.getElementById("streamFrame");
    const cover = document.getElementById("streamCover");
    // No automatic host resolution change here: PS Vita Moonlight cannot rebuild its
    // decoder mid-stream and freezes. Resolution stays manual via the pull menu.
    const url = streamUrl();
    frame.src = url;
    cover?.classList.remove("hidden");
    frame.addEventListener(
      "load",
      () => setTimeout(() => cover?.classList.add("hidden"), 350),
      { once: true }
    );
    const openBtn = document.getElementById("btnOpenMw");
    if (openBtn) openBtn.dataset.url = url;
  }

  async function setStreamRes(res, { quiet, reload, applyHost } = {}) {
    const next = RES_ORDER.includes(res) ? res : "720p";
    localStorage.setItem("gr_stream_res", next);
    localStorage.setItem("gr_stream_res_explicit", "1");
    syncStreamResButton(next);

    if (applyHost) {
      const host = await applyHostDisplayForRes(next);
      if (host?.ok) {
        if (host.restored) {
          const c = host.current || {};
          if (!quiet) toast(`PC画面を元に戻しました${c.width ? `（${c.width}×${c.height}）` : ""}`);
        } else {
          const a = host.applied || host.current || {};
          const note = host.changed === false ? "（すでに同じ）" : "";
          if (!quiet) toast(`PC画面を ${a.width || "?"}×${a.height || "?"} に変更${note}`);
        }
      } else if (host && host.ok === false) {
        toast(`PC解像度の変更に失敗: ${host.error || "不明"}`);
      }
    } else if (!quiet) {
      toast(`解像度: ${RES_LABELS[next] || next}`);
    }

    if (reload !== false) await loadStream();
    return next;
  }

  async function cycleStreamRes() {
    const cur = preferredStreamRes();
    const i = Math.max(0, RES_ORDER.indexOf(cur));
    return setStreamRes(RES_ORDER[(i + 1) % RES_ORDER.length]);
  }

  async function ensureActiveGame() {
    const gameId = params.get("game");
    if (!gameId) return;
    const name = params.get("name") || "";
    try {
      await fetch("/api/input/active-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: gameId, name }),
      });
      localStorage.setItem(
        "gr_now_playing",
        JSON.stringify({ id: gameId, name })
      );
    } catch (_) {}
  }

  async function ensureLaunch() {
    const gameId = params.get("game");
    if (!gameId) return null;
    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: gameId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || res.statusText);
      try {
        localStorage.setItem(
          "gr_now_playing",
          JSON.stringify({ id: gameId, name: params.get("name") || "" })
        );
      } catch (_) {}
      toast(data.message || "起動しました");
      return data;
    } catch (_) {
      toast("起動できませんでした");
      return null;
    }
  }

  /** Physical browser viewport (not the CSS-rotated body box). */
  function physicalViewportSize() {
    const vv = window.visualViewport;
    const w = Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 0);
    const h = Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 0);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function isCssRotated() {
    return (
      document.body.classList.contains("orient-rot-cw") ||
      document.body.classList.contains("orient-rot-ccw")
    );
  }

  /**
   * Logical viewport for layout/CSS.
   * When CSS-rotated 90°, logical W/H are swapped vs the physical phone screen.
   * Pass needRotate explicitly when classes are about to change (avoids 1:1 glitches).
   */
  function updateLayoutViewportVars(needRotate) {
    const root = document.documentElement;
    const { w: physW, h: physH } = physicalViewportSize();
    const rotated = needRotate == null ? isCssRotated() : !!needRotate;
    // Logical landscape box on a portrait phone: wide=physH, tall=physW
    const lw = rotated ? physH : physW;
    const lh = rotated ? physW : physH;
    root.style.setProperty("--lvw", `${lw}px`);
    root.style.setProperty("--lvh", `${lh}px`);
    root.style.setProperty("--lvmin", `${Math.min(lw, lh)}px`);
    root.style.setProperty("--lvmax", `${Math.max(lw, lh)}px`);
    // Also pin body box when rotated (viewport units beat self-referential --lv*)
    if (rotated) {
      document.body.style.width = `${lw}px`;
      document.body.style.height = `${lh}px`;
    } else {
      document.body.style.width = "";
      document.body.style.height = "";
    }
  }

  function measureControlGutters() {
    const root = document.documentElement;
    const left = document.getElementById("railLeft");
    const right = document.getElementById("railRight");
    const padOn = document.body.classList.contains("pad-on");
    const overlay = document.body.classList.contains("pad-overlay");
    const custom = document.body.classList.contains("pad-custom");

    updateLayoutViewportVars();

    if (!padOn || overlay || custom) {
      root.style.setProperty("--rail-left-w", "0px");
      root.style.setProperty("--rail-right-w", "0px");
      return;
    }

    // getBoundingClientRect is axis-aligned in screen space — wrong after CSS rotate.
    // offsetWidth is pre-transform layout size.
    if (isCssRotated()) {
      root.style.setProperty("--rail-left-w", "auto");
      root.style.setProperty("--rail-right-w", "auto");
      return;
    }

    const lw = left ? Math.ceil(left.offsetWidth || left.getBoundingClientRect().width) : 0;
    const rw = right ? Math.ceil(right.offsetWidth || right.getBoundingClientRect().width) : 0;
    if (lw > 0) root.style.setProperty("--rail-left-w", `${lw}px`);
    if (rw > 0) root.style.setProperty("--rail-right-w", `${rw}px`);
  }

  function watchGutters() {
    const targets = [
      document.getElementById("railLeft"),
      document.getElementById("railRight"),
      document.getElementById("playLayout"),
    ].filter(Boolean);
    const ro = new ResizeObserver(() => requestAnimationFrame(measureControlGutters));
    targets.forEach((el) => ro.observe(el));
    window.addEventListener("orientationchange", () => {
      setTimeout(() => {
        // Re-apply: if forced layout ≠ new device tilt, CSS rotate may need to toggle
        applyViewOrient(preferredViewOrient(), { quiet: true });
        measureControlGutters();
      }, 100);
    });
    const mqOrient = window.matchMedia("(orientation: portrait)");
    const onDeviceOrient = () => {
      applyViewOrient(preferredViewOrient(), { quiet: true });
    };
    if (typeof mqOrient.addEventListener === "function") mqOrient.addEventListener("change", onDeviceOrient);
    else if (typeof mqOrient.addListener === "function") mqOrient.addListener(onDeviceOrient);
    window.addEventListener("resize", () => requestAnimationFrame(measureControlGutters));
    window.addEventListener("gr-pad-visibility", () => requestAnimationFrame(measureControlGutters));
    window.addEventListener("gr-pad-chrome", () => requestAnimationFrame(measureControlGutters));
    measureControlGutters();
  }

  function syncPadButton() {
    const visible = document.body.classList.contains("pad-on");
    const btn = document.getElementById("btnTogglePad");
    if (!btn) return;
    btn.textContent = visible ? "パッド off" : "パッド on";
    btn.setAttribute("aria-pressed", visible ? "true" : "false");
  }

  function preferredMouseMode() {
    const saved = localStorage.getItem("gr_mouse_mode");
    if (saved === "touch" || saved === "click" || saved === "trackpad" || saved === "off") return saved;
    // migrate: old "tap" was pointAndDrag mouse-at-position
    if (saved === "tap") return "click";
    if (localStorage.getItem("gr_mouse_enabled") === "0") return "off";
    return "touch";
  }

  function syncMouseButton(mode) {
    const btn = document.getElementById("btnMouse");
    if (!btn) return;
    const labels = {
      touch: "マウス: タッチ",
      click: "マウス: マウスタップ",
      trackpad: "マウス: トラックパッド",
      off: "マウス: 無効",
    };
    btn.textContent = labels[mode] || labels.touch;
    btn.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
    btn.dataset.mode = mode;
  }

  function pushGamepadCapture(active) {
    const frame = document.getElementById("streamFrame");
    if (!frame?.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        { type: "gr-gamepad-capture", active: !!active, fixFace: true },
        "*"
      );
    } catch (_) {
      /* ignore */
    }
    if (active) {
      fetch("/api/input/release-all", { method: "POST" }).catch(() => {});
    }
  }

  function syncStreamGamepadCapture() {
    const menuOpen = !!window.GameRemoteStreamMenu?.isSheetOpen?.();
    const confirmOpen = !!window.GameRemoteConfirm?.isOpen?.();
    const resOpen = !!window.GameRemoteResPicker?.isOpen?.();
    pushGamepadCapture(menuOpen || confirmOpen || resOpen);
  }

  function pushMouseModeToStream(mode) {
    const frame = document.getElementById("streamFrame");
    if (!frame?.contentWindow) return;
    const payload = { type: "gr-input-mode", mode };
    if (mode === "touch") {
      // Native OS touch events (when Sunshine reports touch capability)
      payload.touchMode = "touch";
      payload.mouseMode = "follow";
    } else if (mode === "click") {
      // Absolute mouse click at contact point
      payload.touchMode = "pointAndDrag";
      payload.mouseMode = "follow";
    } else if (mode === "trackpad") {
      payload.touchMode = "mouseRelative";
      payload.mouseMode = "relative";
    }
    try {
      frame.contentWindow.postMessage(payload, "*");
    } catch (_) {
      /* ignore */
    }
  }

  function setMouseMode(mode, { quiet } = {}) {
    const allowed = ["touch", "click", "trackpad", "off"];
    const next = allowed.includes(mode) ? mode : "touch";
    localStorage.setItem("gr_mouse_mode", next);
    localStorage.setItem("gr_mouse_enabled", next === "off" ? "0" : "1");
    document.body.classList.toggle("mouse-mode-touch", next === "touch");
    document.body.classList.toggle("mouse-mode-click", next === "click");
    document.body.classList.toggle("mouse-mode-tap", next === "click"); // legacy class
    document.body.classList.toggle("mouse-mode-trackpad", next === "trackpad");
    document.body.classList.toggle("mouse-mode-off", next === "off");
    document.body.classList.remove("mouse-off", "mouse-on");
    syncMouseButton(next);
    pushMouseModeToStream(next);
    window.dispatchEvent(new CustomEvent("gr-mouse-mode", { detail: { mode: next } }));
    if (!quiet) {
      const msgs = {
        touch: "タッチ入力",
        click: "マウスタップ",
        trackpad: "トラックパッド",
        off: "マウス無効",
      };
      toast(msgs[next] || msgs.touch);
    }
    return next;
  }

  function cycleMouseMode() {
    const cur = preferredMouseMode();
    const order = ["touch", "click", "trackpad", "off"];
    const i = Math.max(0, order.indexOf(cur));
    return setMouseMode(order[(i + 1) % order.length]);
  }

  function deviceOrient() {
    return window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape";
  }

  function preferredViewOrient() {
    const v = localStorage.getItem("gr_view_orient");
    if (v === "portrait" || v === "landscape" || v === "auto") return v;
    return "auto";
  }

  function effectiveViewOrient(pref) {
    const p = pref || preferredViewOrient();
    if (p === "portrait" || p === "landscape") return p;
    return deviceOrient();
  }

  function syncViewOrientButton(pref) {
    const btn = document.getElementById("btnViewOrient");
    if (!btn) return;
    const p = pref || preferredViewOrient();
    const labels = { auto: "画面: 自動", portrait: "画面: 縦", landscape: "画面: 横" };
    btn.textContent = labels[p] || labels.auto;
    btn.dataset.mode = p;
    btn.setAttribute("aria-pressed", p === "auto" ? "false" : "true");
  }

  async function tryLockScreenOrient(mode) {
    // Best-effort; many mobile browsers only allow this in fullscreen.
    try {
      const o = screen.orientation;
      if (!o) return false;
      if (mode === "auto") {
        if (typeof o.unlock === "function") o.unlock();
        return false;
      }
      if (typeof o.lock === "function") {
        await o.lock(mode === "portrait" ? "portrait" : "landscape");
        return true;
      }
    } catch (_) {
      /* ignore NotSupported / SecurityError */
    }
    return false;
  }

  function clearOrientRotate() {
    document.body.classList.remove("orient-rot-cw", "orient-rot-ccw");
    document.body.style.width = "";
    document.body.style.height = "";
  }

  function preferredRotDir() {
    // Default: clockwise (右90°) — better match for most phone grips
    const v = localStorage.getItem("gr_view_rot_dir");
    if (v === "ccw") return "ccw";
    return "cw";
  }

  function applyCssOrientRotate(device, effective) {
    clearOrientRotate();
    if (!device || !effective || device === effective) return false;
    const dir = preferredRotDir();
    // Portrait phone → landscape UI: default counter-clockwise (-90)
    // Landscape phone → portrait UI: opposite of that
    let useCw;
    if (device === "portrait" && effective === "landscape") {
      useCw = dir === "cw";
    } else {
      useCw = dir !== "cw";
    }
    document.body.classList.add(useCw ? "orient-rot-cw" : "orient-rot-ccw");
    return true;
  }

  async function applyViewOrient(pref, { quiet } = {}) {
    const nextPref = pref === "portrait" || pref === "landscape" || pref === "auto" ? pref : "auto";
    localStorage.setItem("gr_view_orient", nextPref);
    const device = deviceOrient();
    const effective = effectiveViewOrient(nextPref);
    const needRotate = nextPref !== "auto" && nextPref !== device;

    document.body.classList.toggle("layout-portrait", effective === "portrait");
    document.body.classList.toggle("layout-landscape", effective === "landscape");
    syncViewOrientButton(nextPref);

    // Size logical viewport BEFORE toggling rotate classes (prevents square / 1:1 flash)
    updateLayoutViewportVars(needRotate);

    let rotated = false;
    if (!needRotate) {
      clearOrientRotate();
      await tryLockScreenOrient(nextPref === "auto" ? "auto" : nextPref);
    } else {
      await tryLockScreenOrient("auto");
      rotated = applyCssOrientRotate(device, effective);
      updateLayoutViewportVars(true);
    }

    window.dispatchEvent(
      new CustomEvent("gr-view-orient", {
        detail: { pref: nextPref, effective, device, rotated },
      })
    );
    requestAnimationFrame(() => {
      updateLayoutViewportVars(needRotate);
      measureControlGutters();
      window.dispatchEvent(new Event("resize"));
    });
    if (!quiet) {
      if (nextPref === "auto") toast("画面: 端末の向きに合わせる");
      else if (rotated) toast(effective === "portrait" ? "縦レイアウト（90°回転）" : "横レイアウト（90°回転）");
      else toast(effective === "portrait" ? "画面: 縦レイアウト" : "画面: 横レイアウト");
    }
    return effective;
  }

  function cycleViewOrient() {
    const cur = preferredViewOrient();
    const order = ["auto", "portrait", "landscape"];
    const i = Math.max(0, order.indexOf(cur));
    return applyViewOrient(order[(i + 1) % order.length]);
  }

  function syncRotDirButton() {
    const btn = document.getElementById("btnViewRotDir");
    if (!btn) return;
    btn.textContent = preferredRotDir() === "cw" ? "回転: 右90°" : "回転: 左90°";
  }

  function cycleRotDir() {
    const next = preferredRotDir() === "cw" ? "ccw" : "cw";
    localStorage.setItem("gr_view_rot_dir", next);
    syncRotDirButton();
    const pref = preferredViewOrient();
    applyViewOrient(pref, { quiet: true });
    toast(next === "cw" ? "回転: 右90°" : "回転: 左90°");
    return next;
  }

  function preferredPadChrome() {
    return localStorage.getItem("gr_pad_chrome") === "overlay" ? "overlay" : "rails";
  }

  function syncPadChromeButton(mode) {
    const btn = document.getElementById("btnPadChrome");
    if (!btn) return;
    const overlay = mode === "overlay";
    btn.textContent = overlay ? "配置: 重ね" : "配置: 横並び";
    btn.setAttribute("aria-pressed", overlay ? "true" : "false");
    btn.dataset.mode = overlay ? "overlay" : "rails";
  }

  function setPadChrome(mode, { quiet } = {}) {
    const next = mode === "overlay" ? "overlay" : "rails";
    localStorage.setItem("gr_pad_chrome", next);
    document.body.classList.toggle("pad-overlay", next === "overlay");
    document.body.classList.toggle("pad-rails", next !== "overlay");
    syncPadChromeButton(next);
    syncOpacityRow(next === "overlay");
    window.dispatchEvent(new CustomEvent("gr-pad-chrome", { detail: { mode: next } }));
    requestAnimationFrame(measureControlGutters);
    if (!quiet) toast(next === "overlay" ? "重ね表示" : "横並び表示");
    return next;
  }

  function preferredPadOpacity() {
    const n = Number(localStorage.getItem("gr_pad_opacity"));
    if (!Number.isFinite(n)) return 50;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function applyPadOpacity(pct) {
    const v = Math.min(100, Math.max(0, Math.round(Number(pct) || 0)));
    localStorage.setItem("gr_pad_opacity", String(v));
    const root = document.documentElement;
    const body = document.body;

    // 0: solid gray → 50: glass → 100: invisible
    let bg;
    let border;
    let fg;
    let knob;
    let opacity = 1;
    let blur = "0px";

    if (v >= 100) {
      bg = "rgba(0,0,0,0)";
      border = "rgba(0,0,0,0)";
      fg = "rgba(0,0,0,0)";
      knob = "rgba(0,0,0,0)";
      opacity = 0;
      blur = "0px";
      body.classList.add("pad-ov-gone");
    } else if (v <= 50) {
      body.classList.remove("pad-ov-gone");
      const u = v / 50; // 0..1
      // gray solid → translucent white glass
      const r = Math.round(lerp(92, 255, u));
      const g = Math.round(lerp(90, 255, u));
      const b = Math.round(lerp(86, 255, u));
      const a = lerp(0.94, 0.16, u);
      bg = `rgba(${r}, ${g}, ${b}, ${a})`;
      border = `rgba(${Math.round(lerp(70, 255, u))}, ${Math.round(lerp(68, 255, u))}, ${Math.round(lerp(64, 255, u))}, ${lerp(0.55, 0.28, u)})`;
      fg = `rgba(239, 234, 225, ${lerp(1, 0.92, u)})`;
      knob = `rgba(${r}, ${g}, ${b}, ${lerp(0.98, 0.32, u)})`;
      opacity = 1;
      blur = `${lerp(0, 2.5, u).toFixed(2)}px`;
    } else {
      body.classList.remove("pad-ov-gone");
      const u = (v - 50) / 50; // 0..1
      // colorless glass → fully transparent
      const a = lerp(0.16, 0, u);
      const ba = lerp(0.28, 0, u);
      bg = `rgba(255, 255, 255, ${a})`;
      border = `rgba(255, 255, 255, ${ba})`;
      fg = `rgba(239, 234, 225, ${lerp(0.92, 0, u)})`;
      knob = `rgba(255, 255, 255, ${lerp(0.32, 0, u)})`;
      opacity = lerp(1, 0, u);
      blur = `${lerp(2.5, 0, u).toFixed(2)}px`;
    }

    root.style.setProperty("--pad-ov-bg", bg);
    root.style.setProperty("--pad-ov-border", border);
    root.style.setProperty("--pad-ov-fg", fg);
    root.style.setProperty("--pad-ov-knob", knob);
    root.style.setProperty("--pad-ov-opacity", String(opacity));
    root.style.setProperty("--pad-ov-blur", blur);

    const input = document.getElementById("padOpacity");
    const label = document.getElementById("padOpacityVal");
    if (input && Number(input.value) !== v) input.value = String(v);
    if (label) label.textContent = `${v}%`;
    return v;
  }

  function syncOpacityRow(overlayOn) {
    const row = document.getElementById("padOpacityRow");
    if (!row) return;
    row.hidden = !overlayOn;
  }

  function syncLeftInputButton(mode) {
    const btn = document.getElementById("btnLeftInput");
    if (!btn) return;
    const stick = mode === "stick";
    btn.textContent = stick ? "左: スティック" : "左: 十字";
    btn.setAttribute("aria-pressed", stick ? "true" : "false");
    btn.dataset.mode = stick ? "stick" : "dpad";
  }

  function setLeftInput(mode, { quiet } = {}) {
    const next = window.GameControls?.setLeftInputMode?.(mode) || (mode === "stick" ? "stick" : "dpad");
    syncLeftInputButton(next);
    if (!quiet) toast(next === "stick" ? "左スティック" : "十字キー");
    return next;
  }

  function preferredStreamMode() {
    const v = localStorage.getItem("gr_stream_mode");
    return v === "desktop" ? "desktop" : "game";
  }

  function syncStreamModeButton(mode) {
    const btn = document.getElementById("btnStreamMode");
    if (!btn) return;
    const game = mode !== "desktop";
    btn.textContent = game ? "配信: ゲーム" : "配信: 全体";
    btn.setAttribute("aria-pressed", game ? "true" : "false");
    btn.dataset.mode = game ? "game" : "desktop";
  }

  async function setStreamMode(mode, { quiet } = {}) {
    const next = mode === "desktop" ? "desktop" : "game";
    localStorage.setItem("gr_stream_mode", next);
    syncStreamModeButton(next);
    try {
      const res = await fetch("/api/stream-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || res.statusText);
      if (!quiet) {
        if (next === "game" && data.ok === false) toast("ゲーム窓が見つかりません");
        else toast(next === "game" ? "ゲーム配信" : "画面全体");
      }
      return data;
    } catch (_) {
      if (!quiet) toast("切替できませんでした");
      return null;
    }
  }

  function scheduleGameCover() {
    if (preferredStreamMode() !== "game") return;
    [700, 1800, 3500].forEach((ms) => {
      setTimeout(() => setStreamMode("game", { quiet: true }), ms);
    });
  }

  function setupMenu() {
    const root = document.getElementById("streamMenu");
    const pull = document.getElementById("menuPull");
    const sheet = document.getElementById("menuSheet");
    const closeBtn = document.getElementById("menuClose");
    if (!root || !pull || !sheet) return;

    const menuNav = {
      index: 0,
      prevAxes: {},
      hold: {},
    };

    function menuItems() {
      return [...sheet.querySelectorAll(".menu-item")].filter(
        (el) => !el.hidden && el.offsetParent !== null
      );
    }

    function setMenuFocus(i) {
      const items = menuItems();
      if (!items.length) return;
      const idx = Math.max(0, Math.min(items.length - 1, i | 0));
      menuNav.index = idx;
      items.forEach((el, n) => el.classList.toggle("is-gp-focus", n === idx));
      try {
        items[idx].scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (_) {
        items[idx].scrollIntoView(false);
      }
    }

    function activateFocused() {
      const items = menuItems();
      const el = items[menuNav.index];
      if (!el) return;
      el.click();
    }

    function setOpen(open) {
      root.classList.toggle("is-open", open);
      pull.setAttribute("aria-expanded", open ? "true" : "false");
      sheet.hidden = !open;
      const hint = document.getElementById("menuGpHint");
      if (hint) {
        const phys = document.body.classList.contains("physical-pad");
        hint.hidden = !(open && phys);
      }
      if (open) {
        setMenuFocus(0);
      } else {
        sheet.querySelectorAll(".menu-item.is-gp-focus").forEach((el) => {
          el.classList.remove("is-gp-focus");
        });
      }
      syncStreamGamepadCapture();
    }

    function toggle() {
      setOpen(sheet.hidden);
    }

    function isOpen() {
      return !sheet.hidden;
    }

    function gpEdge(dir, pressed, now) {
      const hold = menuNav.hold;
      if (!pressed) {
        hold[dir] = 0;
        hold[`${dir}Step`] = -1;
        return false;
      }
      if (!hold[dir]) {
        hold[dir] = now;
        hold[`${dir}Step`] = -1;
        return true;
      }
      const held = now - hold[dir];
      if (held < 280) return false;
      const step = Math.floor((held - 280) / 100);
      if (hold[`${dir}Step`] === step) return false;
      hold[`${dir}Step`] = step;
      return true;
    }

    function handlePad(axes, face) {
      if (window.GameRemoteResPicker?.isOpen?.()) {
        return window.GameRemoteResPicker.handlePad(axes, face);
      }
      if (window.GameRemoteConfirm?.isOpen?.()) {
        return window.GameRemoteConfirm.handlePad(axes, face);
      }
      if (!isOpen()) return false;
      const now = performance.now();
      const items = menuItems();
      if (!items.length) return true;

      // 2-column grid navigation
      const cols = 2;
      if (gpEdge("up", !!axes.up, now) && !axes.down) setMenuFocus(menuNav.index - cols);
      if (gpEdge("down", !!axes.down, now) && !axes.up) setMenuFocus(menuNav.index + cols);
      if (gpEdge("left", !!axes.left, now) && !axes.right) setMenuFocus(menuNav.index - 1);
      if (gpEdge("right", !!axes.right, now) && !axes.left) setMenuFocus(menuNav.index + 1);

      const prev = menuNav.prevFace || {};
      const just = (k) => !!(face[k] && !prev[k]);
      if (just("a")) activateFocused();
      if (just("b") || just("select")) setOpen(false);
      menuNav.prevFace = { ...face };
      return true; // consumed — do not inject to game
    }

    pull.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    closeBtn?.addEventListener("click", () => setOpen(false));

    let startX = null;
    pull.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      pull.setPointerCapture?.(e.pointerId);
    });
    pull.addEventListener("pointerup", (e) => {
      if (startX == null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (dx < -18) setOpen(true);
      else if (dx > 18) setOpen(false);
    });

    document.addEventListener("pointerdown", (e) => {
      if (!root.classList.contains("is-open")) return;
      if (root.contains(e.target)) return;
      setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });

    setOpen(false);

    window.GameRemoteStreamMenu = {
      isOpen: () =>
        isOpen() ||
        !!window.GameRemoteConfirm?.isOpen?.() ||
        !!window.GameRemoteResPicker?.isOpen?.(),
      setOpen,
      toggle,
      handlePad,
      isSheetOpen: isOpen,
    };
  }

  function setupConfirmDialog() {
    const root = document.getElementById("quitConfirm");
    const titleEl = document.getElementById("quitConfirmTitle");
    const msgEl = document.getElementById("quitConfirmMsg");
    const hintEl = document.getElementById("quitConfirmHint");
    const cancelBtn = document.getElementById("quitConfirmCancel");
    const okBtn = document.getElementById("quitConfirmOk");
    if (!root || !cancelBtn || !okBtn) return;

    const nav = { index: 0, hold: {}, prevFace: {} };
    let resolver = null;

    function buttons() {
      return [cancelBtn, okBtn];
    }

    function isOpen() {
      return !root.hidden;
    }

    function setFocus(i) {
      const items = buttons();
      nav.index = Math.max(0, Math.min(items.length - 1, i | 0));
      items.forEach((el, n) => el.classList.toggle("is-gp-focus", n === nav.index));
    }

    function finish(result) {
      if (!isOpen()) return;
      root.hidden = true;
      document.body.classList.remove("gr-confirm-open");
      buttons().forEach((el) => el.classList.remove("is-gp-focus"));
      const r = resolver;
      resolver = null;
      syncStreamGamepadCapture();
      r?.(!!result);
    }

    function gpEdge(dir, pressed, now) {
      const hold = nav.hold;
      if (!pressed) {
        hold[dir] = 0;
        hold[`${dir}Step`] = -1;
        return false;
      }
      if (!hold[dir]) {
        hold[dir] = now;
        hold[`${dir}Step`] = -1;
        return true;
      }
      const held = now - hold[dir];
      if (held < 280) return false;
      const step = Math.floor((held - 280) / 100);
      if (hold[`${dir}Step`] === step) return false;
      hold[`${dir}Step`] = step;
      return true;
    }

    function handlePad(axes, face) {
      if (!isOpen()) return false;
      const now = performance.now();
      if (gpEdge("left", !!axes.left, now) && !axes.right) setFocus(nav.index - 1);
      if (gpEdge("right", !!axes.right, now) && !axes.left) setFocus(nav.index + 1);
      if (gpEdge("up", !!axes.up, now) && !axes.down) setFocus(nav.index - 1);
      if (gpEdge("down", !!axes.down, now) && !axes.up) setFocus(nav.index + 1);

      const prev = nav.prevFace || {};
      const just = (k) => !!(face[k] && !prev[k]);
      if (just("a")) buttons()[nav.index]?.click();
      if (just("b") || just("select")) finish(false);
      nav.prevFace = { ...face };
      return true;
    }

    function open(opts = {}) {
      if (resolver) finish(false);
      return new Promise((resolve) => {
        resolver = resolve;
        if (titleEl) titleEl.textContent = opts.title || "確認";
        if (msgEl) msgEl.textContent = opts.message || "";
        cancelBtn.textContent = opts.cancelLabel || "キャンセル";
        okBtn.textContent = opts.confirmLabel || "OK";
        okBtn.classList.toggle("gr-confirm-btn-danger", opts.danger !== false);
        const phys = document.body.classList.contains("physical-pad");
        const isPs =
          (typeof window.GameRemoteFaceLayout === "function" &&
            window.GameRemoteFaceLayout(navigator.getGamepads?.()?.[0])) === "ps";
        if (hintEl) {
          hintEl.hidden = !phys;
          hintEl.textContent = isPs
            ? "←→で選択 · ○ 決定 · × キャンセル"
            : "←→で選択 · A 決定 · B キャンセル";
        }
        root.hidden = false;
        document.body.classList.add("gr-confirm-open");
        nav.hold = {};
        // Require face release before accepting A/B (avoids instant confirm from the menu press)
        nav.prevFace = { a: true, b: true, x: true, y: true, start: true, select: true };
        setFocus(0); // default: キャンセル
        syncStreamGamepadCapture();
      });
    }

    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));
    root.addEventListener("click", (e) => {
      if (e.target === root) finish(false);
    });
    document.addEventListener("keydown", (e) => {
      if (!isOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        buttons()[nav.index]?.click();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocus(nav.index - 1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocus(nav.index + 1);
      }
    });

    window.GameRemoteConfirm = {
      isOpen,
      open,
      handlePad,
      cancel: () => finish(false),
    };

    // Resolution picker popup
    (function bindResPicker() {
      const root = document.getElementById("resPicker");
      const cancelBtn = document.getElementById("resPickerCancel");
      const hintEl = document.getElementById("resPickerHint");
      if (!root || !cancelBtn) return;

      const nav = { index: 0, hold: {}, prevFace: {} };
      let resolver = null;

      function isOpen() {
        return !root.hidden;
      }

      function options() {
        return [...root.querySelectorAll(".gr-res-opt")];
      }

      function setFocus(i) {
        const items = options();
        if (!items.length) return;
        nav.index = Math.max(0, Math.min(items.length - 1, i | 0));
        items.forEach((el, n) => el.classList.toggle("is-gp-focus", n === nav.index));
        items[nav.index]?.scrollIntoView?.({ block: "nearest" });
      }

      function finish(result) {
        if (!isOpen()) return;
        root.hidden = true;
        document.body.classList.remove("gr-res-open");
        options().forEach((el) => el.classList.remove("is-gp-focus"));
        const r = resolver;
        resolver = null;
        syncStreamGamepadCapture();
        r?.(result);
      }

      function gpEdge(dir, pressed, now) {
        const hold = nav.hold;
        if (!pressed) {
          hold[dir] = 0;
          hold[`${dir}Step`] = -1;
          return false;
        }
        if (!hold[dir]) {
          hold[dir] = now;
          hold[`${dir}Step`] = -1;
          return true;
        }
        const held = now - hold[dir];
        if (held < 280) return false;
        const step = Math.floor((held - 280) / 100);
        if (hold[`${dir}Step`] === step) return false;
        hold[`${dir}Step`] = step;
        return true;
      }

      function handlePad(axes, face) {
        if (!isOpen()) return false;
        const now = performance.now();
        if (gpEdge("up", !!axes.up, now) && !axes.down) setFocus(nav.index - 1);
        if (gpEdge("down", !!axes.down, now) && !axes.up) setFocus(nav.index + 1);
        if (gpEdge("left", !!axes.left, now) && !axes.right) setFocus(nav.index - 1);
        if (gpEdge("right", !!axes.right, now) && !axes.left) setFocus(nav.index + 1);

        const prev = nav.prevFace || {};
        const just = (k) => !!(face[k] && !prev[k]);
        if (just("a")) options()[nav.index]?.click();
        if (just("b") || just("select")) finish(null);
        nav.prevFace = { ...face };
        return true;
      }

      function open() {
        if (resolver) finish(null);
        return new Promise((resolve) => {
          resolver = resolve;
          const cur = preferredStreamRes();
          options().forEach((el) => {
            el.classList.toggle("is-current", el.dataset.res === cur);
          });
          const phys = document.body.classList.contains("physical-pad");
          const isPs =
            (typeof window.GameRemoteFaceLayout === "function" &&
              window.GameRemoteFaceLayout(navigator.getGamepads?.()?.[0])) === "ps";
          if (hintEl) {
            hintEl.hidden = !phys;
            hintEl.textContent = isPs
              ? "↑↓で選択 · ○ 決定 · × 閉じる"
              : "↑↓で選択 · A 決定 · B 閉じる";
          }
          root.hidden = false;
          document.body.classList.add("gr-res-open");
          nav.hold = {};
          nav.prevFace = { a: true, b: true, x: true, y: true, start: true, select: true };
          const idx = Math.max(0, options().findIndex((el) => el.dataset.res === cur));
          setFocus(idx >= 0 ? idx : 0);
          syncStreamGamepadCapture();
        });
      }

      options().forEach((btn) => {
        btn.addEventListener("click", () => {
          const res = btn.dataset.res;
          finish(RES_ORDER.includes(res) ? res : null);
        });
      });
      cancelBtn.addEventListener("click", () => finish(null));
      root.addEventListener("click", (e) => {
        if (e.target === root) finish(null);
      });
      document.addEventListener("keydown", (e) => {
        if (!isOpen()) return;
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          options()[nav.index]?.click();
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          setFocus(nav.index - 1);
        } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          setFocus(nav.index + 1);
        }
      });

      window.GameRemoteResPicker = {
        isOpen,
        open,
        handlePad,
        close: () => finish(null),
      };
    })();

    // On-screen pad → confirm / stream menu (same logical face as physical)
    const uiPad = { dirs: {}, face: {} };
    window.GameRemoteStreamUiPad = function (action, pressed) {
      const dirs = ["up", "down", "left", "right"];
      const faces = ["a", "b", "x", "y", "start", "select"];
      if (dirs.includes(action)) uiPad.dirs[action] = !!pressed;
      if (faces.includes(action)) uiPad.face[action] = !!pressed;
      const axes = {
        left: !!uiPad.dirs.left,
        right: !!uiPad.dirs.right,
        up: !!uiPad.dirs.up,
        down: !!uiPad.dirs.down,
      };
      const face = {
        a: !!uiPad.face.a,
        b: !!uiPad.face.b,
        x: !!uiPad.face.x,
        y: !!uiPad.face.y,
        start: !!uiPad.face.start,
        select: !!uiPad.face.select,
      };
      if (window.GameRemoteResPicker?.isOpen?.()) {
        window.GameRemoteResPicker.handlePad(axes, face);
      } else if (window.GameRemoteConfirm?.isOpen?.()) {
        window.GameRemoteConfirm.handlePad(axes, face);
      } else if (window.GameRemoteStreamMenu?.isSheetOpen?.()) {
        window.GameRemoteStreamMenu.handlePad(axes, face);
      }
    };
  }

  let padHintTimer = 0;
  let padHintWasConnected = false;

  function syncPhysicalPadChrome(connected, meta = {}) {
    document.body.classList.toggle("physical-pad", !!connected);
    document.body.classList.toggle("pad-auto-hide", !!connected);
    const hint = document.getElementById("padConnectHint");
    const main = document.getElementById("padConnectHintMain");
    const sub = document.getElementById("padConnectHintSub");
    const layout = meta.layout || "xbox";
    const isPs = layout === "ps";
    if (main) {
      main.textContent = connected
        ? isPs
          ? "PSコントローラ接続中"
          : "コントローラ接続中"
        : "";
    }
    if (sub) {
      sub.textContent = isPs
        ? "OPTIONS 長押しでメニュー · ○決定 ×閉じる"
        : "☰/Start 長押しでメニュー · A決定 B閉じる";
    }
    // Relabel on-screen pad glyphs
    document.querySelectorAll(".pad-btn[data-label-xbox]").forEach((btn) => {
      const key = isPs ? "labelPs" : "labelXbox";
      const v = btn.dataset[key];
      if (v) btn.textContent = v;
    });
    const menuHint = document.getElementById("menuGpHint");
    if (menuHint && window.GameRemoteStreamMenu?.isOpen?.()) {
      menuHint.hidden = !connected;
      menuHint.textContent = isPs
        ? "↑↓で移動 · ○ 決定 · × 閉じる"
        : "↑↓で移動 · A 決定 · B 閉じる";
    }
    if (hint) {
      clearTimeout(padHintTimer);
      if (!connected) {
        hint.hidden = true;
      } else if (!padHintWasConnected) {
        // Fresh connect: show briefly, then fade out of the way
        hint.hidden = false;
        padHintTimer = setTimeout(() => {
          hint.hidden = true;
        }, 4200);
      }
    }
    padHintWasConnected = !!connected;
  }

  function nudgeStreamAudio() {
    const frame = document.getElementById("streamFrame");
    try {
      frame?.contentWindow?.postMessage({ type: "gr-unmute" }, "*");
    } catch (_) {
      /* cross-origin / not ready */
    }
  }

  function pushFaceFixToStream() {
    const frame = document.getElementById("streamFrame");
    if (!frame?.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        { type: "gr-gamepad-capture", active: false, fixFace: true },
        "*"
      );
    } catch (_) {
      /* ignore */
    }
  }

  function setupAudioUnlock() {
    const onceOpts = { passive: true };
    const unlock = () => {
      nudgeStreamAudio();
      pushMouseModeToStream(preferredMouseMode());
      pushFaceFixToStream();
      syncStreamGamepadCapture();
    };
    document.addEventListener("pointerdown", unlock, onceOpts);
    document.addEventListener("touchstart", unlock, onceOpts);
    document.addEventListener("keydown", unlock, onceOpts);
    const frame = document.getElementById("streamFrame");
    frame?.addEventListener("load", () => {
      nudgeStreamAudio();
      pushMouseModeToStream(preferredMouseMode());
      pushFaceFixToStream();
      syncStreamGamepadCapture();
      [500, 1500, 3000, 6000].forEach((ms) => {
        setTimeout(() => {
          nudgeStreamAudio();
          pushMouseModeToStream(preferredMouseMode());
          pushFaceFixToStream();
          syncStreamGamepadCapture();
        }, ms);
      });
    });
  }

  async function boot() {
    const gameId = params.get("game");
    const gameName = params.get("name") || "";
    document.getElementById("playGameName").textContent = gameName || (gameId ? gameId : "ストリーム");
    if (gameId) {
      await window.GameControls?.setContextGame?.({ id: gameId, name: gameName });
    }

    window.GameControls?.init?.();
    setupConfirmDialog();
    setupMenu();
    setupAudioUnlock();
    window.addEventListener("gr-pad-presence", (e) => {
      syncPhysicalPadChrome(!!e.detail?.connected, e.detail || {});
    });
    // Initial sync in case pad already connected
    syncPhysicalPadChrome(!!window.GameControls?.isPhysicalConnected?.(), {
      layout:
        (typeof window.GameRemoteFaceLayout === "function" &&
          window.GameRemoteFaceLayout(navigator.getGamepads?.()?.[0])) ||
        "xbox",
    });

    const preferPad = localStorage.getItem("gr_pad_visible");
    const show = preferPad === null ? true : preferPad === "1";
    window.GameControls?.setPadVisible?.(show);
    document.body.classList.toggle("pad-on", show);
    document.body.classList.toggle("pad-off", !show);
    syncPadButton();
    setMouseMode(preferredMouseMode(), { quiet: true });
    applyPadOpacity(preferredPadOpacity());
    applyViewOrient(preferredViewOrient(), { quiet: true });
    syncRotDirButton();
    setPadChrome(preferredPadChrome(), { quiet: true });
    setLeftInput(window.GameControls?.getLeftInputMode?.() || "dpad", { quiet: true });
    window.PadLayout?.init?.();

    document.getElementById("btnTogglePad")?.addEventListener("click", () => {
      window.GameControls?.togglePad?.();
      syncPadButton();
      requestAnimationFrame(measureControlGutters);
    });

    document.getElementById("btnMouse")?.addEventListener("click", () => {
      cycleMouseMode();
    });

    document.getElementById("btnViewOrient")?.addEventListener("click", () => {
      cycleViewOrient();
    });
    document.getElementById("btnViewRotDir")?.addEventListener("click", () => {
      cycleRotDir();
    });

    document.getElementById("btnPadChrome")?.addEventListener("click", () => {
      // Leaving free layout when switching chrome modes
      if (document.body.classList.contains("pad-custom") && !window.PadLayout?.isEditing?.()) {
        window.PadLayout?.clearCustomLayout?.({ quiet: true });
      }
      const cur = document.getElementById("btnPadChrome")?.dataset.mode || preferredPadChrome();
      setPadChrome(cur === "overlay" ? "rails" : "overlay");
    });

    document.getElementById("btnLeftInput")?.addEventListener("click", () => {
      const cur = document.getElementById("btnLeftInput")?.dataset.mode || "dpad";
      setLeftInput(cur === "stick" ? "dpad" : "stick");
    });

    document.getElementById("padOpacity")?.addEventListener("input", (e) => {
      applyPadOpacity(e.target.value);
    });

    syncStreamResButton(preferredStreamRes());
    syncStreamModeButton(preferredStreamMode());
    document.getElementById("btnStreamMode")?.addEventListener("click", () => {
      const cur = document.getElementById("btnStreamMode")?.dataset.mode || preferredStreamMode();
      setStreamMode(cur === "game" ? "desktop" : "game");
    });
    document.getElementById("btnStreamRes")?.addEventListener("click", async () => {
      const picked = await window.GameRemoteResPicker?.open?.();
      if (!picked) return;
      // Always apply: even re-picking the same preset updates Windows if needed.
      await setStreamRes(picked, { applyHost: true });
    });

    // ライブラリへ戻るだけ — ゲームプロセスは終了しない
    document.getElementById("btnBack")?.addEventListener("click", async (e) => {
      e.preventDefault();
      location.href = "/";
    });

    document.getElementById("btnQuitGame")?.addEventListener("click", async () => {
      const ok = await window.GameRemoteConfirm?.open?.({
        title: "ゲーム終了",
        message: "起動中のゲームを終了しますか？",
        confirmLabel: "終了する",
        cancelLabel: "キャンセル",
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch("/api/quit-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            force: true,
            game_id: params.get("game") || null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || res.statusText);
        try {
          localStorage.removeItem("gr_now_playing");
        } catch (_) {}
        toast("ゲームを終了しました");
        window.GameRemoteStreamMenu?.setOpen?.(false);
      } catch (_) {
        toast("終了できませんでした");
      }
    });

    const reload = () => loadStream();
    document.getElementById("btnLoadStream")?.addEventListener("click", reload);
    document.getElementById("btnLoadStreamCover")?.addEventListener("click", reload);

    document.getElementById("btnOpenMw")?.addEventListener("click", () => {
      const url = document.getElementById("btnOpenMw").dataset.url || streamUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    });

    document.getElementById("btnFs")?.addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        else await document.exitFullscreen();
      } catch (_) {
        try {
          const stage = document.getElementById("playStage");
          if (!document.fullscreenElement) await stage.requestFullscreen();
          else await document.exitFullscreen();
        } catch (e2) {
          toast("全画面にできません");
        }
      }
      requestAnimationFrame(measureControlGutters);
    });

    watchGutters();
    const skipLaunch = params.get("skipLaunch") === "1";
    // Start stream ASAP — launch/active-game bookkeeping can finish in parallel.
    loadStream();
    if (gameId && !skipLaunch) {
      ensureLaunch().then(() => scheduleGameCover());
    } else if (gameId && skipLaunch) {
      ensureActiveGame();
      scheduleGameCover();
    } else if (preferredStreamMode() === "game") {
      setStreamMode("game", { quiet: true });
    }
  }

  boot().catch(() => toast("初期化エラー"));
})();
