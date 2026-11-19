/* Physical + on-screen gamepad → host input bridge (default + per-game maps) */
(function () {
  const ACTIONS = [
    "up", "down", "left", "right",
    "a", "b", "x", "y",
    "l1", "r1", "l2", "r2", "l3", "r3",
    "start", "select", "touchpad",
  ];

  const GP_BUTTONS = {
    0: "a", 1: "b", 2: "x", 3: "y",
    4: "l1", 5: "r1", 6: "l2", 7: "r2",
    8: "select", 9: "start",
    10: "l3", 11: "r3",
    12: "up", 13: "down", 14: "left", 15: "right",
    16: "touchpad",
  };

  // PS pad presented as Xbox/standard: swap A↔B and X↔Y (○=決定)
  const GP_BUTTONS_PS = {
    0: "b", 1: "a", 2: "y", 3: "x",
    4: "l1", 5: "r1", 6: "l2", 7: "r2",
    8: "select", 9: "start",
    10: "l3", 11: "r3",
    12: "up", 13: "down", 14: "left", 15: "right",
    16: "touchpad",
  };

  function faceButtonMap(gp) {
    const layout =
      (typeof window.GameRemoteFaceLayout === "function" && window.GameRemoteFaceLayout(gp)) ||
      detectFaceLayout(gp);
    return layout === "ps" ? GP_BUTTONS_PS : GP_BUTTONS;
  }

  function detectFaceLayout(gp) {
    // One-shot: older builds auto/forced "ps" to paper over moonlight A/B swap — clear it.
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

  if (typeof window.GameRemoteFaceLayout !== "function") {
    window.GameRemoteFaceLayout = detectFaceLayout;
  }

  const KEY_OPTIONS = [
    "up", "down", "left", "right", "enter", "esc", "tab", "space",
    "shift", "ctrl", "alt", "z", "x", "c", "a", "s", "d", "q", "e", "w",
    "1", "2", "3", "4", "f1", "f2", "f5", "f11",
  ];

  const BUILTIN_DEFAULT = {
    up: { type: "key", code: "up" },
    down: { type: "key", code: "down" },
    left: { type: "key", code: "left" },
    right: { type: "key", code: "right" },
    a: { type: "key", code: "enter" },
    b: { type: "key", code: "esc" },
    x: { type: "key", code: "z" },
    y: { type: "key", code: "x" },
    l1: { type: "key", code: "q" },
    r1: { type: "key", code: "e" },
    l2: { type: "key", code: "1" },
    r2: { type: "key", code: "3" },
    l3: { type: "key", code: "shift" },
    r3: { type: "key", code: "ctrl" },
    start: { type: "key", code: "enter" },
    select: { type: "key", code: "tab" },
    touchpad: { type: "mouse", code: "left" },
  };

  const state = {
    mappings: null,
    ws: null,
    padVisible: false,
    physicalConnected: false,
    pressed: new Set(),
    gpPrev: {},
    contextGame: null, // { id, name } for mapper / active profile
    mapScope: "default",
    menuChord: { startAt: 0, fired: false },
  };

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws/input`;
  }

  function ensureWs() {
    if (state.ws && state.ws.readyState <= 1) return state.ws;
    const ws = new WebSocket(wsUrl());
    state.ws = ws;
    ws.addEventListener("close", () => {
      if (state.ws === ws) state.ws = null;
    });
    return ws;
  }

  function sendInject(action, pressed) {
    if (document.body.classList.contains("pad-edit")) return;
    // Library / detail: drive UI navigation instead of host key inject
    if (!document.body.classList.contains("play-shell")) {
      try {
        window.GameRemoteLibraryAction?.(action, !!pressed);
      } catch (err) {
        console.warn("library pad action", err);
      }
      document.querySelectorAll(`.pad-btn[data-action="${action}"]`).forEach((el) => {
        el.classList.toggle("active", !!pressed);
      });
      return;
    }
    // Stream chrome / confirm: keep on-screen pad on the UI, not the game
    if (
      window.GameRemoteConfirm?.isOpen?.() ||
      window.GameRemoteResPicker?.isOpen?.() ||
      window.GameRemoteStreamMenu?.isSheetOpen?.() ||
      window.GameRemoteStreamMenu?.isOpen?.()
    ) {
      try {
        window.GameRemoteStreamUiPad?.(action, !!pressed);
      } catch (_) {}
      document.querySelectorAll(`.pad-btn[data-action="${action}"]`).forEach((el) => {
        el.classList.toggle("active", !!pressed);
      });
      return;
    }
    // Host mouse via touchpad mapping — blocked when mouse mode is off
    if (action === "touchpad" && document.body.classList.contains("mouse-mode-off")) {
      return;
    }
    if (pressed && state.pressed.has(action)) return;
    if (!pressed && !state.pressed.has(action)) return;
    if (pressed) state.pressed.add(action);
    else state.pressed.delete(action);

    const payload = {
      op: "inject",
      action,
      pressed: !!pressed,
      game_id: state.contextGame?.id || undefined,
    };
    const msg = JSON.stringify(payload);
    try {
      const ws = ensureWs();
      if (ws.readyState === 1) ws.send(msg);
      else {
        ws.addEventListener("open", () => ws.send(msg), { once: true });
        fetch("/api/input/inject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            pressed: !!pressed,
            game_id: state.contextGame?.id || null,
          }),
        }).catch(() => {});
      }
    } catch (_) {
      fetch("/api/input/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          pressed: !!pressed,
          game_id: state.contextGame?.id || null,
        }),
      }).catch(() => {});
    }

    document.querySelectorAll(`.pad-btn[data-action="${action}"]`).forEach((el) => {
      el.classList.toggle("active", !!pressed);
    });
  }

  function bindPadDom() {
    const roots = [
      document.getElementById("pad"),
      document.getElementById("playLayout"),
    ].filter(Boolean);
    const seen = new Set();
    for (const root of roots) {
      root.querySelectorAll(".pad-btn[data-action]").forEach((btn) => {
        if (seen.has(btn)) return;
        seen.add(btn);
        const action = btn.dataset.action;
        const down = (e) => {
          e.preventDefault();
          sendInject(action, true);
        };
        const up = (e) => {
          e.preventDefault();
          sendInject(action, false);
        };
        btn.addEventListener("pointerdown", down);
        btn.addEventListener("pointerup", up);
        btn.addEventListener("pointercancel", up);
        btn.addEventListener("pointerleave", (e) => {
          if (btn.classList.contains("active")) up(e);
        });
        btn.addEventListener("contextmenu", (e) => e.preventDefault());
        btn.addEventListener("selectstart", (e) => e.preventDefault());
        btn.addEventListener("dragstart", (e) => e.preventDefault());
      });
    }
    document.getElementById("padHide")?.addEventListener("click", () => setPadVisible(false));
  }

  function releaseCardinals() {
    ["up", "down", "left", "right"].forEach((a) => sendInject(a, false));
  }

  function bindVirtualStick() {
    const stick = document.getElementById("leftStick");
    const knob = document.getElementById("leftStickKnob");
    if (!stick || !knob || stick.dataset.bound === "1") return;
    stick.dataset.bound = "1";

    const dirs = { up: false, down: false, left: false, right: false };
    let pointerId = null;

    function setDirs(nx, ny) {
      const dead = 0.32;
      const next = {
        up: ny < -dead,
        down: ny > dead,
        left: nx < -dead,
        right: nx > dead,
      };
      for (const a of ["up", "down", "left", "right"]) {
        if (next[a] !== dirs[a]) sendInject(a, next[a]);
        dirs[a] = next[a];
      }
    }

    function moveTo(clientX, clientY) {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const maxR = Math.min(rect.width, rect.height) * 0.36;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const len = Math.hypot(dx, dy) || 1;
      if (len > maxR) {
        dx = (dx / len) * maxR;
        dy = (dy / len) * maxR;
      }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      setDirs(dx / maxR, dy / maxR);
    }

    function endStick() {
      pointerId = null;
      stick.classList.remove("is-active");
      knob.style.transform = "translate(-50%, -50%)";
      setDirs(0, 0);
    }

    stick.addEventListener("pointerdown", (e) => {
      if (document.body.classList.contains("left-dpad")) return;
      if (document.body.classList.contains("pad-edit")) return;
      e.preventDefault();
      pointerId = e.pointerId;
      stick.setPointerCapture?.(e.pointerId);
      stick.classList.add("is-active");
      moveTo(e.clientX, e.clientY);
    });
    stick.addEventListener("pointermove", (e) => {
      if (pointerId !== e.pointerId) return;
      e.preventDefault();
      moveTo(e.clientX, e.clientY);
    });
    stick.addEventListener("pointerup", (e) => {
      if (pointerId !== e.pointerId) return;
      e.preventDefault();
      endStick();
    });
    stick.addEventListener("pointercancel", endStick);
    stick.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function setLeftInputMode(mode) {
    const next = mode === "stick" ? "stick" : "dpad";
    localStorage.setItem("gr_left_input", next);
    document.body.classList.toggle("left-stick", next === "stick");
    document.body.classList.toggle("left-dpad", next === "dpad");
    const dpad = document.getElementById("dpad");
    const stick = document.getElementById("leftStick");
    if (dpad) dpad.hidden = next === "stick";
    if (stick) stick.hidden = next !== "stick";
    releaseCardinals();
    window.dispatchEvent(new CustomEvent("gr-left-input", { detail: { mode: next } }));
    return next;
  }

  function getLeftInputMode() {
    return localStorage.getItem("gr_left_input") === "stick" ? "stick" : "dpad";
  }

  function setPadVisible(visible) {
    state.padVisible = !!visible;
    const pad = document.getElementById("pad");
    if (pad) {
      pad.classList.toggle("hidden", !visible);
      pad.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    document.body.classList.toggle("pad-on", !!visible);
    document.body.classList.toggle("pad-off", !visible);
    const layout = document.getElementById("playLayout");
    if (layout) {
      layout.classList.toggle("controls-hidden", !visible);
      layout.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    localStorage.setItem("gr_pad_visible", visible ? "1" : "0");
    if (visible) ensureWs();
    // Notify play shell to remeasure reserved tracks
    window.dispatchEvent(new CustomEvent("gr-pad-visibility", { detail: { visible: !!visible } }));
  }

  function togglePad() {
    setPadVisible(!state.padVisible);
  }

  function updatePadModeLabel() {
    const el = document.getElementById("padMode");
    if (!el) return;
    const src = state.physicalConnected ? "物理パッド" : "オンスクリーン";
    const g = state.contextGame;
    const ov = state.mappings?.effective?.isOverride;
    const profile = g
      ? (ov ? `例外:${g.name || g.id.slice(0, 8)}` : `デフォルト(+${g.name || "ゲーム"})`)
      : "デフォルト";
    el.textContent = `${src} → キー割当（${profile}）`;
  }

  function emitPadPresence(connected, gp) {
    const layout = detectFaceLayout(gp);
    window.dispatchEvent(
      new CustomEvent("gr-pad-presence", {
        detail: {
          connected: !!connected,
          id: gp?.id || "",
          layout,
        },
      })
    );
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const any = pads.length > 0;
    if (any !== state.physicalConnected) {
      state.physicalConnected = any;
      updatePadModeLabel();
      emitPadPresence(any, pads[0] || null);
    }

    // Library page: forward pad to app.js (do not inject into host games)
    if (!document.body.classList.contains("play-shell")) {
      for (const gp of pads) {
        if (!gp) continue;
        try {
          window.GameRemoteLibraryPad?.(gp);
        } catch (err) {
          console.warn("library pad", err);
        }
      }
      requestAnimationFrame(pollGamepad);
      return;
    }

    const menuApi = window.GameRemoteStreamMenu;
    const confirmApi = window.GameRemoteConfirm;
    const resApi = window.GameRemoteResPicker;
    const confirmOpen = !!confirmApi?.isOpen?.() || !!resApi?.isOpen?.();
    const menuOpen = !!menuApi?.isOpen?.() || confirmOpen;
    const now = performance.now();

    for (const gp of pads) {
      const prev = state.gpPrev[gp.index] || { buttons: [], axes: {} };
      const btnMap = faceButtonMap(gp);
      const buttons = gp.buttons.map((b) => !!(b && (b.pressed || b.value > 0.4)));
      const axX = gp.axes[0] || 0;
      const axY = gp.axes[1] || 0;
      const dead = 0.45;
      const axes = {
        left: axX < -dead || !!buttons[14],
        right: axX > dead || !!buttons[15],
        up: axY < -dead || !!buttons[12],
        down: axY > dead || !!buttons[13],
      };
      const faceMapped = { a: false, b: false, x: false, y: false, start: !!buttons[9], select: !!buttons[8] };
      [0, 1, 2, 3].forEach((idx) => {
        const act = btnMap[idx];
        if (act && faceMapped[act] !== undefined) faceMapped[act] = !!buttons[idx];
      });

      // OPTIONS / Start long-press → stream menu (suppress game Start)
      const startPressed = !!buttons[9];
      const startWas = !!prev.buttons[9];
      if (startPressed && !startWas) {
        state.menuChord.startAt = now;
        state.menuChord.fired = false;
      } else if (startPressed && !state.menuChord.fired && state.menuChord.startAt) {
        if (now - state.menuChord.startAt >= 550) {
          state.menuChord.fired = true;
          if (confirmOpen) confirmApi.cancel?.();
          else menuApi?.toggle?.();
        }
      } else if (!startPressed && startWas) {
        if (!state.menuChord.fired && state.menuChord.startAt) {
          // short press → pass Start to game
          if (!menuOpen) {
            sendInject("start", true);
            sendInject("start", false);
          }
        }
        state.menuChord.startAt = 0;
        state.menuChord.fired = false;
      }

      if (confirmOpen) {
        confirmApi.handlePad?.(axes, faceMapped);
        state.gpPrev[gp.index] = { buttons, axes: { ...axes } };
        continue;
      }

      if (menuOpen) {
        menuApi.handlePad?.(axes, faceMapped);
        state.gpPrev[gp.index] = { buttons, axes: { ...axes } };
        continue;
      }

      buttons.forEach((pressed, idx) => {
        const action = btnMap[idx];
        if (!action) return;
        if (action === "start") return; // handled via short/long press above
        const was = !!prev.buttons[idx];
        if (pressed !== was) sendInject(action, pressed);
      });
      const pax = prev.axes || {};
      if (axes.left !== !!pax.left) sendInject("left", axes.left);
      if (axes.right !== !!pax.right) sendInject("right", axes.right);
      if (axes.up !== !!pax.up) sendInject("up", axes.up);
      if (axes.down !== !!pax.down) sendInject("down", axes.down);
      state.gpPrev[gp.index] = { buttons, axes: { ...axes } };
    }
    requestAnimationFrame(pollGamepad);
  }

  async function loadMappings(gameId) {
    const q = gameId ? `?game_id=${encodeURIComponent(gameId)}` : "";
    const res = await fetch(`/api/input/mappings${q}`);
    state.mappings = await res.json();
    updatePadModeLabel();
    return state.mappings;
  }

  async function setContextGame(game) {
    state.contextGame = game && game.id ? { id: game.id, name: game.name || "" } : null;
    if (state.contextGame) {
      await fetch("/api/input/active-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.contextGame.id, name: state.contextGame.name }),
      });
      await loadMappings(state.contextGame.id);
    } else {
      await fetch("/api/input/active-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: null }),
      });
      await loadMappings();
    }
    updatePadModeLabel();
  }

  function currentScope() {
    const checked = document.querySelector('input[name="mapScope"]:checked');
    return checked?.value || state.mapScope || "default";
  }

  function renderMapperRows() {
    const list = document.getElementById("mapList");
    const label = document.getElementById("mapGameLabel");
    if (!list || !state.mappings) return;

    const scope = currentScope();
    state.mapScope = scope;
    const defaults = state.mappings.mapping || {};
    const gid = state.contextGame?.id;
    const gameEntry = gid ? (state.mappings.gameOverrides || {})[gid] : null;
    const overrideMap = gameEntry?.mapping || {};
    const effective = state.mappings.effective?.mapping || defaults;

    if (label) {
      if (!state.contextGame) {
        label.textContent = "ゲーム未選択（詳細を開くか起動すると例外を設定できます）";
      } else if (scope === "game") {
        const n = Object.keys(overrideMap).length;
        label.textContent = `例外対象: ${state.contextGame.name || state.contextGame.id}（差分 ${n} 件）`;
      } else {
        label.textContent = `デフォルト編集中 / アクティブゲーム: ${state.contextGame.name || state.contextGame.id}`;
      }
    }

    const gameRadio = document.getElementById("mapScopeGame");
    if (gameRadio) gameRadio.disabled = !state.contextGame;

    list.innerHTML = "";
    for (const action of ACTIONS) {
      const isOv = scope === "game" && !!overrideMap[action];
      const bind = scope === "game"
        ? (overrideMap[action] || defaults[action] || { type: "key", code: "" })
        : (defaults[action] || { type: "key", code: "" });
      const row = document.createElement("div");
      row.className = "map-row" + (isOv ? " is-override" : "");
      row.dataset.action = action;
      row.innerHTML = `
        <strong>${action.toUpperCase()}${isOv ? ' <span class="ov-mark">例外</span>' : ""}</strong>
        <select data-field="type">
          <option value="key" ${bind.type === "key" ? "selected" : ""}>キー</option>
          <option value="mouse" ${bind.type === "mouse" ? "selected" : ""}>マウス</option>
        </select>
        <input data-field="code" list="keyOptions" value="${bind.code || ""}" placeholder="enter / z / left..." />
      `;
      list.appendChild(row);
    }
  }

  function openMapper() {
    const dlg = document.getElementById("mapDlg");
    if (!dlg || !state.mappings) return;
    if (!document.getElementById("keyOptions")) {
      const dl = document.createElement("datalist");
      dl.id = "keyOptions";
      dl.innerHTML = KEY_OPTIONS.map((k) => `<option value="${k}"></option>`).join("");
      document.body.appendChild(dl);
    }
    // prefer game scope if context game exists and already has overrides
    const gid = state.contextGame?.id;
    const hasOv = gid && state.mappings.gameOverrides?.[gid]?.mapping
      && Object.keys(state.mappings.gameOverrides[gid].mapping).length;
    const scope = hasOv ? "game" : "default";
    document.querySelectorAll('input[name="mapScope"]').forEach((el) => {
      el.checked = el.value === scope;
    });
    renderMapperRows();
    dlg.showModal();
  }

  async function saveMapper() {
    const scope = currentScope();
    const mapping = {};
    document.querySelectorAll("#mapList .map-row").forEach((row) => {
      const action = row.dataset.action;
      const type = row.querySelector('[data-field="type"]').value;
      const code = row.querySelector('[data-field="code"]').value.trim();
      mapping[action] = { type, code };
    });

    if (scope === "game") {
      if (!state.contextGame?.id) {
        alert("ゲームが選択されていません");
        return;
      }
      const res = await fetch("/api/input/mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "game",
          game_id: state.contextGame.id,
          game_name: state.contextGame.name,
          mapping,
        }),
      });
      state.mappings = await res.json();
      await loadMappings(state.contextGame.id);
    } else {
      const res = await fetch("/api/input/mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "default", mapping }),
      });
      state.mappings = await res.json();
      await loadMappings(state.contextGame?.id);
    }
    document.getElementById("mapDlg")?.close();
    updatePadModeLabel();
  }

  async function resetMapper() {
    const scope = currentScope();
    if (scope === "game") {
      if (!state.contextGame?.id) return;
      await fetch(`/api/input/mappings/game/${encodeURIComponent(state.contextGame.id)}`, {
        method: "DELETE",
      });
      await loadMappings(state.contextGame.id);
      renderMapperRows();
      return;
    }
    await fetch("/api/input/mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "default", mapping: BUILTIN_DEFAULT }),
    });
    await loadMappings(state.contextGame?.id);
    renderMapperRows();
  }

  async function clearGameOverride() {
    if (!state.contextGame?.id) {
      alert("ゲームが選択されていません");
      return;
    }
    await fetch(`/api/input/mappings/game/${encodeURIComponent(state.contextGame.id)}`, {
      method: "DELETE",
    });
    await loadMappings(state.contextGame.id);
    renderMapperRows();
    updatePadModeLabel();
  }

  window.GameControls = {
    ACTIONS,
    init() {
      bindPadDom();
      bindVirtualStick();
      setLeftInputMode(getLeftInputMode());
      const saved = localStorage.getItem("gr_pad_visible") === "1";
      setPadVisible(saved);
      loadMappings().catch(() => {});
      updatePadModeLabel();

      document.getElementById("btnControls")?.addEventListener("click", () => togglePad());
      document.getElementById("btnMap")?.addEventListener("click", async () => {
        await loadMappings(state.contextGame?.id);
        openMapper();
      });
      document.getElementById("mapSave")?.addEventListener("click", (e) => {
        e.preventDefault();
        saveMapper();
      });
      document.getElementById("mapReset")?.addEventListener("click", (e) => {
        e.preventDefault();
        resetMapper();
      });
      document.getElementById("mapClearGame")?.addEventListener("click", (e) => {
        e.preventDefault();
        clearGameOverride();
      });
      document.getElementById("detailTogglePad")?.addEventListener("click", () => togglePad());
      document.querySelectorAll('input[name="mapScope"]').forEach((el) => {
        el.addEventListener("change", () => renderMapperRows());
      });

      window.addEventListener("pointerdown", () => ensureWs(), { once: true });
      window.addEventListener("gamepadconnected", (e) => {
        state.physicalConnected = true;
        updatePadModeLabel();
        ensureWs();
        emitPadPresence(true, e.gamepad);
      });
      window.addEventListener("gamepaddisconnected", () => {
        const still = [...(navigator.getGamepads?.() || [])].some(Boolean);
        state.physicalConnected = still;
        updatePadModeLabel();
        emitPadPresence(still, still ? [...navigator.getGamepads()].find(Boolean) : null);
      });
      window.addEventListener("blur", () => {
        fetch("/api/input/release-all", { method: "POST" }).catch(() => {});
        state.pressed.clear();
        document.querySelectorAll(".pad-btn.active").forEach((el) => el.classList.remove("active"));
      });

      requestAnimationFrame(pollGamepad);
    },
    togglePad,
    setPadVisible,
    sendInject,
    setContextGame,
    getContextGame: () => state.contextGame,
    setLeftInputMode,
    getLeftInputMode,
    isPhysicalConnected: () => state.physicalConnected,
  };
})();
