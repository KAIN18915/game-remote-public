/**
 * Free-form on-screen pad layout editor.
 * 3 slots per orientation (portrait / landscape) = 6 total.
 * Clusters drag together once, then split into individually movable atoms.
 * Positions are center percentages of #playLayout.
 */
(function () {
  const STORAGE_KEY = "gr_pad_layouts_v2";
  const LEGACY_KEY = "gr_pad_layouts_v1";

  /** @type {Record<string, string[]>} */
  const CLUSTERS = {
    "l-shoulders": ["l2", "l1"],
    "l-sys": ["select", "touchpad"],
    dpad: ["up", "left", "right", "down"],
    stick: ["stick"],
    "r-shoulders": ["r1", "r2"],
    "r-sys": ["start"],
    face: ["y", "x", "b", "a"],
  };

  const ATOM_TO_CLUSTER = {};
  for (const [cid, atoms] of Object.entries(CLUSTERS)) {
    for (const a of atoms) ATOM_TO_CLUSTER[a] = cid;
  }

  const state = {
    editing: false,
    orient: "landscape", // landscape | portrait
    activeSlot: null,
    slots: [null, null, null],
    /** @type {{ landscape: any, portrait: any } | null} */
    store: null,
    drag: null,
    /** @type {Set<string>} */
    split: new Set(),
    /** @type {Set<string>} */
    hidden: new Set(),
  };

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg) {
    if (typeof window.grToast === "function") window.grToast(msg);
    else {
      const el = $("toast");
      if (!el) return;
      el.textContent = msg;
      el.classList.remove("hidden");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
    }
  }

  function currentOrient() {
    if (document.body.classList.contains("layout-portrait")) return "portrait";
    if (document.body.classList.contains("layout-landscape")) return "landscape";
    const pref = localStorage.getItem("gr_view_orient");
    if (pref === "portrait" || pref === "landscape") return pref;
    return window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape";
  }

  function orientLabel(orient) {
    return (orient || state.orient) === "portrait" ? "縦" : "横";
  }

  function emptyBucket() {
    return { slots: [null, null, null], activeSlot: null };
  }

  function normalizeBucket(b) {
    if (!b || typeof b !== "object") return emptyBucket();
    return {
      slots: [0, 1, 2].map((i) => (Array.isArray(b.slots) ? b.slots[i] || null : null)),
      activeSlot:
        b.activeSlot === 0 || b.activeSlot === 1 || b.activeSlot === 2 ? b.activeSlot : null,
    };
  }

  function cloneBucket(b) {
    return JSON.parse(JSON.stringify(normalizeBucket(b)));
  }

  function layoutEl() {
    return $("playLayout");
  }

  function atomEl(action) {
    if (action === "stick") return $("leftStick");
    return document.querySelector(`.play-layout [data-action="${action}"]`);
  }

  function loadStore() {
    const orient = currentOrient();
    state.orient = orient;
    try {
      let raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!raw || typeof raw !== "object" || (!raw.landscape && !raw.portrait)) {
        raw = { landscape: emptyBucket(), portrait: emptyBucket() };
        try {
          const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
          if (legacy && Array.isArray(legacy.slots)) {
            const migrated = {
              slots: [0, 1, 2].map((i) => legacy.slots[i] || null),
              activeSlot:
                legacy.activeSlot === 0 || legacy.activeSlot === 1 || legacy.activeSlot === 2
                  ? legacy.activeSlot
                  : null,
            };
            // Seed both orients so existing layouts keep working until re-saved per orient
            raw.landscape = cloneBucket(migrated);
            raw.portrait = cloneBucket(migrated);
          }
        } catch (_) {}
        localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
      }
      state.store = {
        landscape: normalizeBucket(raw.landscape),
        portrait: normalizeBucket(raw.portrait),
      };
      const bucket = state.store[orient];
      state.slots = bucket.slots;
      state.activeSlot = bucket.activeSlot;
    } catch (_) {
      state.store = { landscape: emptyBucket(), portrait: emptyBucket() };
      state.slots = [null, null, null];
      state.activeSlot = null;
    }
  }

  function saveStore() {
    const orient = state.orient || currentOrient();
    if (!state.store) {
      state.store = { landscape: emptyBucket(), portrait: emptyBucket() };
    }
    state.store[orient] = {
      slots: [0, 1, 2].map((i) => state.slots[i] || null),
      activeSlot:
        state.activeSlot === 0 || state.activeSlot === 1 || state.activeSlot === 2
          ? state.activeSlot
          : null,
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        landscape: state.store.landscape,
        portrait: state.store.portrait,
      })
    );
  }

  function centerPct(el, lr) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return {
      x: ((r.left + r.width / 2 - lr.left) / lr.width) * 100,
      y: ((r.top + r.height / 2 - lr.top) / lr.height) * 100,
    };
  }

  function clearPosStyles(el) {
    el.style.left = "";
    el.style.top = "";
    el.style.right = "";
    el.style.bottom = "";
    el.style.transform = "";
    el.style.margin = "";
    el.style.width = "";
    el.style.height = "";
    el.style.removeProperty("--pad-x");
    el.style.removeProperty("--pad-y");
    el.classList.remove("is-dragging");
  }

  function applyPos(el, pos) {
    if (!pos) {
      clearPosStyles(el);
      return;
    }
    const xRaw = Number(pos.x);
    const yRaw = Number(pos.y);
    const x = Math.min(96, Math.max(4, Number.isFinite(xRaw) ? xRaw : 50));
    const y = Math.min(96, Math.max(4, Number.isFinite(yRaw) ? yRaw : 50));
    const xs = `${x}%`;
    const ys = `${y}%`;
    // CSS variables beat .face-y / .dpad defaults (!important pair in stylesheet)
    el.style.setProperty("--pad-x", xs);
    el.style.setProperty("--pad-y", ys);
    el.style.left = xs;
    el.style.top = ys;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = "translate(-50%, -50%)";
    el.style.margin = "0";
  }

  /** Prefer already-applied % (drag/save stable); else measure vs playLayout. */
  function readPos(el, lr) {
    const cssX = el.style.getPropertyValue("--pad-x") || el.style.left;
    const cssY = el.style.getPropertyValue("--pad-y") || el.style.top;
    if (cssX.endsWith("%") && cssY.endsWith("%")) {
      const x = parseFloat(cssX);
      const y = parseFloat(cssY);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    return centerPct(el, lr);
  }

  function resetStructure() {
    // Unhide custom-hidden buttons
    document.querySelectorAll(".play-layout [data-pad-hidden], .play-layout .pad-hidden").forEach((el) => {
      el.removeAttribute("data-pad-hidden");
      el.classList.remove("pad-hidden");
    });
    state.hidden.clear();

    for (const cid of Object.keys(CLUSTERS)) {
      let root;
      if (cid === "dpad") root = $("dpad");
      else if (cid === "face") root = $("face");
      else if (cid === "stick") root = $("leftStick");
      else {
        root =
          document.querySelector(`.play-layout [data-pad-cluster="${cid}"]`) ||
          document.querySelector(`.play-layout [data-pad-unit="${cid}"]`);
      }
      if (!root) continue;

      root.classList.remove("pad-cluster-split");
      root.removeAttribute("data-pad-cluster");
      root.setAttribute("data-pad-unit", cid);

      if (cid === "stick") {
        clearPosStyles(root);
        root.classList.remove("pad-atom");
        continue;
      }

      root.querySelectorAll("[data-action]").forEach((btn) => {
        btn.classList.remove("pad-atom");
        btn.removeAttribute("data-pad-unit");
        clearPosStyles(btn);
      });
      clearPosStyles(root);
    }
    state.split.clear();
    removeHideBadges();

    // Restore dpad/stick visibility without firing gr-left-input (avoids re-entry)
    const mode =
      typeof window.GameControls?.getLeftInputMode === "function"
        ? window.GameControls.getLeftInputMode()
        : "dpad";
    const dpad = $("dpad");
    const stick = $("leftStick");
    if (dpad) dpad.hidden = mode === "stick";
    if (stick) stick.hidden = mode !== "stick";
  }

  function findClusterRoot(cid) {
    if (cid === "dpad") return $("dpad");
    if (cid === "face") return $("face");
    if (cid === "stick") return $("leftStick");
    return (
      document.querySelector(`.play-layout [data-pad-unit="${cid}"]`) ||
      document.querySelector(`.play-layout [data-pad-cluster="${cid}"]`)
    );
  }

  function markClusterSplit(cid) {
    const root = findClusterRoot(cid);
    if (!root || cid === "stick") {
      if (cid === "stick" && root) root.setAttribute("data-pad-unit", "stick");
      return root;
    }

    root.classList.add("pad-cluster-split");
    root.setAttribute("data-pad-cluster", cid);
    root.removeAttribute("data-pad-unit");
    clearPosStyles(root);
    state.split.add(cid);
    return root;
  }

  function splitClusterFromDom(cid) {
    if (cid === "stick") return;
    const layout = layoutEl();
    const root = findClusterRoot(cid);
    if (!layout || !root) return;
    const lr = layout.getBoundingClientRect();

    // Measure while cluster still has its placed box (before expanding to full canvas)
    const measured = {};
    for (const action of CLUSTERS[cid] || []) {
      const btn = root.querySelector(`[data-action="${action}"]`);
      if (!btn) continue;
      const pos = centerPct(btn, lr);
      if (pos) measured[action] = pos;
    }

    markClusterSplit(cid);
    for (const action of CLUSTERS[cid] || []) {
      const btn = root.querySelector(`[data-action="${action}"]`);
      if (!btn) continue;
      btn.classList.add("pad-atom");
      btn.setAttribute("data-pad-unit", action);
      applyPos(btn, measured[action]);
    }
  }

  function applyHidden() {
    for (const action of Object.values(CLUSTERS).flat()) {
      const el = atomEl(action);
      if (!el) continue;
      const hide = state.hidden.has(action);
      if (hide) {
        el.setAttribute("data-pad-hidden", "1");
        el.classList.add("pad-hidden");
        if (action === "stick") el.hidden = true;
      } else {
        el.removeAttribute("data-pad-hidden");
        el.classList.remove("pad-hidden");
        // stick visibility still owned by left-input mode unless editing restore
        if (action === "stick" && !document.body.classList.contains("left-stick")) {
          /* leave controls.js ownership */
        }
      }
    }
  }

  function captureLayout() {
    const layout = layoutEl();
    if (!layout) return { items: {}, hidden: [], split: [] };
    const lr = layout.getBoundingClientRect();
    const items = {};
    const split = new Set(state.split);

    // Also detect split from DOM (in case state lagged)
    for (const cid of Object.keys(CLUSTERS)) {
      if (cid === "stick") continue;
      if (document.querySelector(`.play-layout [data-pad-cluster="${cid}"]`)) split.add(cid);
      // Any free atom implies its cluster is split
      for (const action of CLUSTERS[cid]) {
        const btn = atomEl(action);
        if (btn?.classList.contains("pad-atom")) split.add(cid);
      }
    }

    for (const [cid, atoms] of Object.entries(CLUSTERS)) {
      if (cid === "stick") {
        const stick = $("leftStick");
        if (
          stick &&
          !stick.hidden &&
          !stick.classList.contains("pad-hidden") &&
          stick.getAttribute("data-pad-hidden") !== "1"
        ) {
          const pos = readPos(stick, lr);
          if (pos) items.stick = pos;
        }
        continue;
      }

      if (split.has(cid)) {
        for (const action of atoms) {
          if (state.hidden.has(action)) continue;
          const btn = atomEl(action);
          if (!btn || btn.classList.contains("pad-hidden")) continue;
          const pos = readPos(btn, lr);
          if (pos) items[action] = pos;
        }
      } else {
        const root = findClusterRoot(cid);
        if (!root || root.hidden) continue;
        const pos = readPos(root, lr);
        if (pos) items[cid] = pos;
      }
    }

    state.split = split;
    return {
      items,
      hidden: [...state.hidden],
      split: [...split],
    };
  }

  function itemsLookAtomic(items) {
    if (!items) return false;
    return Object.keys(items).some((k) => ATOM_TO_CLUSTER[k] && k !== "stick" && !CLUSTERS[k]);
  }

  function applyLayoutData(data) {
    resetStructure();
    if (!data || !data.items) {
      setCustomActive(false);
      return;
    }

    setCustomActive(true);
    document.body.classList.add("pad-on");
    document.body.classList.remove("pad-off");

    state.hidden = new Set(Array.isArray(data.hidden) ? data.hidden : []);
    const items = data.items;
    const splitList = Array.isArray(data.split) ? data.split : [];

    // Infer split from atomic keys
    const needSplit = new Set(splitList);
    if (itemsLookAtomic(items)) {
      for (const key of Object.keys(items)) {
        const cid = ATOM_TO_CLUSTER[key];
        if (cid && cid !== "stick") needSplit.add(cid);
      }
    }

    // Apply cluster positions first (unsplit)
    for (const cid of Object.keys(CLUSTERS)) {
      if (needSplit.has(cid)) continue;
      if (items[cid]) {
        const root = findClusterRoot(cid);
        if (root) applyPos(root, items[cid]);
      }
    }

    // Split then apply atom positions
    for (const cid of needSplit) {
      if (cid === "stick") continue;
      const root = findClusterRoot(cid);
      if (!root) continue;

      if (items[cid] && !atomsHaveAny(items, CLUSTERS[cid])) {
        applyPos(root, items[cid]);
        splitClusterFromDom(cid);
      } else {
        markClusterSplit(cid);
        for (const action of CLUSTERS[cid] || []) {
          const btn = root.querySelector(`[data-action="${action}"]`);
          if (!btn) continue;
          btn.classList.add("pad-atom");
          btn.setAttribute("data-pad-unit", action);
          if (items[action]) applyPos(btn, items[action]);
        }
      }
    }

    if (items.stick) {
      const stick = $("leftStick");
      if (stick) {
        stick.setAttribute("data-pad-unit", "stick");
        applyPos(stick, items.stick);
      }
    }

    applyHidden();
    state.split = needSplit;
    if (state.editing) syncHideBadges();
  }

  function atomsHaveAny(items, atoms) {
    return atoms.some((a) => items[a]);
  }

  function setCustomActive(on) {
    document.body.classList.toggle("pad-custom", !!on);
    window.dispatchEvent(new CustomEvent("gr-pad-chrome", { detail: { custom: !!on } }));
  }

  function applyActiveSlot() {
    loadStore();
    const slot = state.activeSlot != null ? state.slots[state.activeSlot] : null;
    if (slot && slot.items) {
      applyLayoutData(slot);
      syncSlotButtons();
      return true;
    }
    resetStructure();
    setCustomActive(false);
    syncSlotButtons();
    return false;
  }

  function syncSlotButtons() {
    const tag = orientLabel();
    for (let i = 0; i < 3; i++) {
      const btn = $(`btnPadSlot${i + 1}`);
      if (!btn) continue;
      const filled = !!state.slots[i];
      const active = state.activeSlot === i;
      btn.textContent = filled
        ? active
          ? `${tag}${i + 1} ✓`
          : `${tag}${i + 1}`
        : `${tag}${i + 1} (空)`;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.classList.toggle("is-empty-slot", !filled);
    }
    const editBtn = $("btnPadEdit");
    if (editBtn) {
      editBtn.setAttribute("aria-pressed", state.editing ? "true" : "false");
      editBtn.textContent = state.editing ? `エディタ中(${tag})` : "配置エディタ";
    }
    for (let i = 0; i < 3; i++) {
      const saveBtn = $(`padEditSave${i + 1}`);
      if (saveBtn) saveBtn.textContent = `${tag}保存${i + 1}`;
    }
  }

  function removeHideBadges() {
    document.querySelectorAll(".pad-edit-hide").forEach((b) => b.remove());
  }

  function syncHideBadges() {
    removeHideBadges();
    if (!state.editing) return;
    const targets = [
      ...document.querySelectorAll(".play-layout .pad-btn[data-action]"),
      ...document.querySelectorAll(".play-layout [data-pad-unit=\"stick\"]"),
    ];
    for (const el of targets) {
      if (el.classList.contains("pad-hidden") || el.getAttribute("data-pad-hidden") === "1") continue;
      if (el.hidden) continue;
      const action = el.dataset.action || el.dataset.padUnit;
      if (!action) continue;
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "pad-edit-hide";
      badge.setAttribute("aria-label", "非表示");
      badge.textContent = "×";
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAction(action);
      });
      badge.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
      });
      el.appendChild(badge);
    }
  }

  function hideAction(action) {
    state.hidden.add(action);
    const el = atomEl(action);
    if (el) {
      el.setAttribute("data-pad-hidden", "1");
      el.classList.add("pad-hidden");
      el.classList.remove("is-dragging");
    }
    syncHideBadges();
    toast("非表示にしました");
  }

  function restoreHidden() {
    state.hidden.clear();
    applyHidden();
    // Re-show stick only if stick mode
    const stick = $("leftStick");
    if (stick && document.body.classList.contains("left-dpad")) {
      stick.hidden = true;
    }
    syncHideBadges();
    toast("非表示を戻しました");
  }

  function beginEditCapture() {
    setCustomActive(true);
    document.body.classList.add("pad-on");
    document.body.classList.remove("pad-off");
    const slot = state.activeSlot != null ? state.slots[state.activeSlot] : null;
    if (slot && slot.items) {
      applyLayoutData(slot);
      return;
    }
    resetStructure();
    setCustomActive(true);
    requestAnimationFrame(() => {
      const layout = layoutEl();
      if (!layout) return;
      const lr = layout.getBoundingClientRect();
      for (const cid of Object.keys(CLUSTERS)) {
        const root =
          cid === "dpad"
            ? $("dpad")
            : cid === "face"
              ? $("face")
              : cid === "stick"
                ? $("leftStick")
                : document.querySelector(`[data-pad-unit="${cid}"]`);
        if (!root || root.hidden) continue;
        const pos = centerPct(root, lr);
        if (pos) applyPos(root, pos);
      }
      syncHideBadges();
    });
  }

  function setEditing(on) {
    state.editing = !!on;
    document.body.classList.toggle("pad-edit", state.editing);
    const bar = $("padEditBar");
    if (bar) bar.hidden = !state.editing;

    if (state.editing) {
      beginEditCapture();
      const sheet = $("menuSheet");
      const menu = $("streamMenu");
      if (sheet) sheet.hidden = true;
      menu?.classList.remove("is-open");
      toast("まとめて移動 → 離すと個別配置 · ×で非表示");
      syncHideBadges();
    } else {
      removeHideBadges();
      if (state.activeSlot == null) {
        resetStructure();
        setCustomActive(false);
      } else {
        applyActiveSlot();
      }
    }
    syncSlotButtons();
  }

  function saveToSlot(index) {
    if (index < 0 || index > 2) return;
    if (!document.body.classList.contains("pad-custom")) setCustomActive(true);
    state.orient = currentOrient();
    const tag = orientLabel();
    const captured = captureLayout();
    if (!Object.keys(captured.items).length && !captured.hidden.length) {
      toast("保存できる位置がありません");
      return;
    }
    state.slots[index] = {
      name: `${tag}${index + 1}`,
      orient: state.orient,
      updatedAt: Date.now(),
      items: captured.items,
      hidden: captured.hidden,
      split: captured.split,
    };
    state.activeSlot = index;
    saveStore();
    // Keep current DOM — destructive re-apply was resetting ABXY/dpad to defaults
    syncSlotButtons();
    toast(`${tag}${index + 1} に保存しました`);
  }

  function loadSlot(index) {
    loadStore();
    const tag = orientLabel();
    if (!state.slots[index]) {
      toast(`${tag}${index + 1} は空です`);
      return;
    }
    state.activeSlot = index;
    saveStore();
    applyActiveSlot();
    toast(`${tag}${index + 1} を適用`);
  }

  function clearCustomLayout(opts) {
    const quiet = !!(opts && opts.quiet);
    state.orient = currentOrient();
    state.activeSlot = null;
    saveStore();
    setEditing(false);
    resetStructure();
    setCustomActive(false);
    syncSlotButtons();
    if (!quiet) toast(`${orientLabel()}を標準配置に戻しました`);
  }

  function handleOrientationSwitch() {
    const next = currentOrient();
    const prev = state.orient;
    // Persist in-progress edit into the orientation we were on
    if (state.editing && prev && prev !== next) {
      try {
        saveStore();
      } catch (_) {}
    } else if (prev && prev !== next) {
      // Keep activeSlot of previous orient already in store; just switch bucket
      try {
        saveStore();
      } catch (_) {}
    }
    loadStore();
    applyActiveSlot();
    syncSlotButtons();
    if (state.editing) {
      document.body.classList.add("pad-edit");
      const bar = $("padEditBar");
      if (bar) bar.hidden = false;
      if (state.activeSlot == null) beginEditCapture();
      else {
        const slot = state.slots[state.activeSlot];
        if (slot?.items) applyLayoutData(slot);
      }
      syncHideBadges();
      toast(`${orientLabel()}の配置に切り替え`);
    }
  }

  function resolveDragTarget(e) {
    const hide = e.target.closest?.(".pad-edit-hide");
    if (hide) return null;

    const atom = e.target.closest?.("[data-pad-unit].pad-atom, .pad-atom[data-pad-unit]");
    if (atom && !atom.classList.contains("pad-hidden")) return { el: atom, kind: "atom" };

    const stick = e.target.closest?.('[data-pad-unit="stick"]');
    if (stick && !stick.classList.contains("pad-hidden")) return { el: stick, kind: "stick" };

    const unit = e.target.closest?.("[data-pad-unit]");
    if (unit && !unit.classList.contains("pad-hidden") && !unit.hidden) {
      return { el: unit, kind: "cluster" };
    }
    return null;
  }

  function onPointerDown(e) {
    if (!state.editing) return;
    const hit = resolveDragTarget(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const layout = layoutEl();
    if (!layout) return;
    const lr = layout.getBoundingClientRect();
    const ur = hit.el.getBoundingClientRect();
    state.drag = {
      el: hit.el,
      kind: hit.kind,
      clusterId: hit.el.dataset.padUnit,
      pointerId: e.pointerId,
      ox: e.clientX - (ur.left + ur.width / 2),
      oy: e.clientY - (ur.top + ur.height / 2),
      lw: lr.width,
      lh: lr.height,
      lleft: lr.left,
      ltop: lr.top,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
    };
    hit.el.classList.add("is-dragging");
    hit.el.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    const d = state.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 4) d.moved = true;
    const cx = e.clientX - d.ox;
    const cy = e.clientY - d.oy;
    let x = ((cx - d.lleft) / d.lw) * 100;
    let y = ((cy - d.ltop) / d.lh) * 100;
    x = Math.min(96, Math.max(4, x));
    y = Math.min(96, Math.max(4, y));
    d.el.style.left = `${x}%`;
    d.el.style.top = `${y}%`;
    d.el.style.right = "auto";
    d.el.style.bottom = "auto";
    d.el.style.setProperty("--pad-x", `${x}%`);
    d.el.style.setProperty("--pad-y", `${y}%`);
    d.el.style.transform = "translate(-50%, -50%)";
  }

  function onPointerUp(e) {
    const d = state.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    d.el.classList.remove("is-dragging");

    // First placement of a cluster → explode to individual atoms
    if (d.kind === "cluster" && d.clusterId && CLUSTERS[d.clusterId] && d.clusterId !== "stick") {
      if (!state.split.has(d.clusterId)) {
        splitClusterFromDom(d.clusterId);
        syncHideBadges();
        if (d.moved) toast("個別に動かせます");
      }
    }

    state.drag = null;
  }

  function bindDrag() {
    const layout = layoutEl();
    if (!layout || layout.dataset.padLayoutBound === "1") return;
    layout.dataset.padLayoutBound = "1";
    layout.addEventListener("pointerdown", onPointerDown, true);
    layout.addEventListener("pointermove", onPointerMove, true);
    layout.addEventListener("pointerup", onPointerUp, true);
    layout.addEventListener("pointercancel", onPointerUp, true);
  }

  function bindUi() {
    $("btnPadEdit")?.addEventListener("click", () => {
      setEditing(!state.editing);
    });
    $("btnPadLayoutClear")?.addEventListener("click", () => clearCustomLayout());
    for (let i = 0; i < 3; i++) {
      $(`btnPadSlot${i + 1}`)?.addEventListener("click", () => {
        if (state.editing) saveToSlot(i);
        else loadSlot(i);
      });
    }
    $("padEditSave1")?.addEventListener("click", () => saveToSlot(0));
    $("padEditSave2")?.addEventListener("click", () => saveToSlot(1));
    $("padEditSave3")?.addEventListener("click", () => saveToSlot(2));
    $("padEditRestore")?.addEventListener("click", () => restoreHidden());
    $("padEditReset")?.addEventListener("click", () => {
      resetStructure();
      setCustomActive(false);
      requestAnimationFrame(() => {
        setCustomActive(true);
        requestAnimationFrame(() => {
          beginEditCapture();
          toast("現在の標準位置を取り込みました");
        });
      });
    });
    $("padEditDone")?.addEventListener("click", () => {
      if (state.activeSlot == null) {
        const empty = state.slots.findIndex((s) => !s);
        saveToSlot(empty >= 0 ? empty : 0);
      } else {
        saveToSlot(state.activeSlot);
      }
      setEditing(false);
    });
  }

  function init() {
    loadStore();
    bindDrag();
    bindUi();
    requestAnimationFrame(() => {
      applyActiveSlot();
      syncSlotButtons();
    });
    window.addEventListener("orientationchange", () => {
      setTimeout(handleOrientationSwitch, 140);
    });
    // Desktop / browser resize between portrait & landscape
    const mq = window.matchMedia("(orientation: portrait)");
    const onMq = () => setTimeout(handleOrientationSwitch, 80);
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
    else if (typeof mq.addListener === "function") mq.addListener(onMq);

    // Manual view-orient from pull menu (auto / 縦 / 横)
    window.addEventListener("gr-view-orient", () => {
      setTimeout(handleOrientationSwitch, 40);
    });

    window.addEventListener("gr-left-input", () => {
      if (state.activeSlot != null || state.editing) {
        requestAnimationFrame(() => {
          // Re-apply positions; keep hidden/split from active slot
          if (state.editing && state.activeSlot == null) {
            // editing fresh layout — just refresh badges
            syncHideBadges();
            return;
          }
          applyActiveSlot();
          if (state.editing) {
            document.body.classList.add("pad-edit");
            const bar = $("padEditBar");
            if (bar) bar.hidden = false;
            syncHideBadges();
          }
        });
      }
    });
  }

  window.PadLayout = {
    init,
    setEditing,
    applyActiveSlot,
    saveToSlot,
    loadSlot,
    clearCustomLayout,
    isEditing: () => state.editing,
  };
})();
