"""Host-side input injector with default + per-game key mappings."""
from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any, Optional

try:
    from pynput.keyboard import Controller as KeyController, Key, KeyCode
    from pynput.mouse import Button, Controller as MouseController
except Exception:  # pragma: no cover - no pynput, or no desktop session (container)
    KeyController = None  # type: ignore
    MouseController = None  # type: ignore
    Key = None  # type: ignore
    KeyCode = None  # type: ignore
    Button = None  # type: ignore

ROOT = Path(__file__).resolve().parent
MAPPINGS_PATH = ROOT / "config" / "input_mappings.json"

DEFAULT_ACTIONS = [
    "up", "down", "left", "right",
    "a", "b", "x", "y",
    "l1", "r1", "l2", "r2",
    "l3", "r3",
    "start", "select",
    "touchpad",
]

DEFAULT_MAPPING = {
    "up": {"type": "key", "code": "up"},
    "down": {"type": "key", "code": "down"},
    "left": {"type": "key", "code": "left"},
    "right": {"type": "key", "code": "right"},
    "a": {"type": "key", "code": "enter"},
    "b": {"type": "key", "code": "esc"},
    "x": {"type": "key", "code": "z"},
    "y": {"type": "key", "code": "x"},
    "l1": {"type": "key", "code": "q"},
    "r1": {"type": "key", "code": "e"},
    "l2": {"type": "key", "code": "1"},
    "r2": {"type": "key", "code": "3"},
    "l3": {"type": "key", "code": "shift"},
    "r3": {"type": "key", "code": "ctrl"},
    "start": {"type": "key", "code": "enter"},
    "select": {"type": "key", "code": "tab"},
    "touchpad": {"type": "mouse", "code": "left"},
}

_SPECIAL = {}
if Key is not None:
    _SPECIAL = {
        "up": Key.up,
        "down": Key.down,
        "left": Key.left,
        "right": Key.right,
        "enter": Key.enter,
        "return": Key.enter,
        "esc": Key.esc,
        "escape": Key.esc,
        "tab": Key.tab,
        "space": Key.space,
        "shift": Key.shift,
        "ctrl": Key.ctrl,
        "alt": Key.alt,
        "backspace": Key.backspace,
        "delete": Key.delete,
        "home": Key.home,
        "end": Key.end,
        "pageup": Key.page_up,
        "pagedown": Key.page_down,
        "f1": Key.f1, "f2": Key.f2, "f3": Key.f3, "f4": Key.f4,
        "f5": Key.f5, "f6": Key.f6, "f7": Key.f7, "f8": Key.f8,
        "f9": Key.f9, "f10": Key.f10, "f11": Key.f11, "f12": Key.f12,
    }

_lock = threading.Lock()
_pressed: set[str] = set()
_active_game_id: Optional[str] = None
_kb = KeyController() if KeyController else None
_mouse = MouseController() if MouseController else None


def default_mappings() -> dict[str, Any]:
    return {
        "version": 2,
        "actions": list(DEFAULT_ACTIONS),
        "mapping": deepcopy(DEFAULT_MAPPING),
        "gameOverrides": {},
        "activeGameId": None,
    }


def _normalize(data: dict[str, Any]) -> dict[str, Any]:
    base = default_mappings()
    mapping = deepcopy(base["mapping"])
    mapping.update(data.get("mapping") or {})

    overrides_in = data.get("gameOverrides") or data.get("game_overrides") or {}
    overrides: dict[str, Any] = {}
    for gid, entry in overrides_in.items():
        if not gid:
            continue
        if isinstance(entry, dict) and "mapping" in entry:
            ov_map = dict(entry.get("mapping") or {})
            name = entry.get("name")
        elif isinstance(entry, dict):
            # legacy: bare mapping object
            ov_map = dict(entry)
            name = None
        else:
            continue
        # keep only known actions / valid binds
        clean_map = {}
        for action, bind in ov_map.items():
            if action in DEFAULT_ACTIONS and isinstance(bind, dict) and bind.get("code"):
                clean_map[action] = {
                    "type": bind.get("type") or "key",
                    "code": str(bind.get("code")),
                }
        overrides[str(gid)] = {"name": name, "mapping": clean_map}

    active = data.get("activeGameId") or data.get("active_game_id")
    if active is not None:
        active = str(active) or None

    return {
        "version": 2,
        "actions": list(DEFAULT_ACTIONS),
        "mapping": mapping,
        "gameOverrides": overrides,
        "activeGameId": active,
    }


def load_mappings() -> dict[str, Any]:
    MAPPINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not MAPPINGS_PATH.exists():
        data = default_mappings()
        save_mappings(data)
        return data
    with open(MAPPINGS_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    data = _normalize(raw)
    # keep runtime active game if set and file has none
    global _active_game_id
    if _active_game_id:
        data["activeGameId"] = _active_game_id
    elif data.get("activeGameId"):
        _active_game_id = data["activeGameId"]
    return data


def save_mappings(data: dict[str, Any]) -> dict[str, Any]:
    MAPPINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    clean = _normalize(data)
    # persist active game from runtime if missing
    global _active_game_id
    if _active_game_id and not clean.get("activeGameId"):
        clean["activeGameId"] = _active_game_id
    with open(MAPPINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(clean, f, indent=2, ensure_ascii=False)
    return clean


def set_active_game(game_id: Optional[str], name: Optional[str] = None) -> dict[str, Any]:
    global _active_game_id
    data = load_mappings()
    gid = str(game_id) if game_id else None
    _active_game_id = gid
    data["activeGameId"] = gid
    if gid and name:
        entry = data["gameOverrides"].setdefault(gid, {"name": name, "mapping": {}})
        if name:
            entry["name"] = name
    return save_mappings(data)


def effective_mapping(game_id: Optional[str] = None) -> dict[str, Any]:
    """Merge default mapping with per-game overrides."""
    data = load_mappings()
    gid = game_id if game_id is not None else data.get("activeGameId") or _active_game_id
    merged = deepcopy(data["mapping"])
    override_actions: list[str] = []
    game_name = None
    if gid and gid in data["gameOverrides"]:
        entry = data["gameOverrides"][gid]
        game_name = entry.get("name")
        for action, bind in (entry.get("mapping") or {}).items():
            merged[action] = bind
            override_actions.append(action)
    return {
        "gameId": gid,
        "gameName": game_name,
        "mapping": merged,
        "overrideActions": override_actions,
        "isOverride": bool(override_actions),
    }


def get_mappings_view(game_id: Optional[str] = None) -> dict[str, Any]:
    data = load_mappings()
    eff = effective_mapping(game_id)
    return {
        **data,
        "effective": eff,
        "editingGameId": game_id if game_id is not None else data.get("activeGameId"),
    }


def update_default_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    data = load_mappings()
    data["mapping"] = mapping
    return save_mappings(data)


def update_game_override(
    game_id: str,
    mapping: dict[str, Any],
    name: Optional[str] = None,
    replace: bool = True,
) -> dict[str, Any]:
    data = load_mappings()
    gid = str(game_id)
    entry = data["gameOverrides"].get(gid) or {"name": name, "mapping": {}}
    if name:
        entry["name"] = name
    if replace:
        # only store diffs from default? Store full override map as provided
        # Empty codes mean "remove override for this action"
        clean = {}
        defaults = data["mapping"]
        for action, bind in (mapping or {}).items():
            if action not in DEFAULT_ACTIONS:
                continue
            if not isinstance(bind, dict):
                continue
            code = str(bind.get("code") or "").strip()
            if not code:
                continue
            # store only if different from default, OR always store explicit overrides
            typ = bind.get("type") or "key"
            default_bind = defaults.get(action) or {}
            if default_bind.get("type") != typ or str(default_bind.get("code")) != code:
                clean[action] = {"type": typ, "code": code}
            else:
                # same as default — skip (no exception needed)
                pass
        entry["mapping"] = clean
    else:
        entry["mapping"] = {**(entry.get("mapping") or {}), **mapping}
    if entry["mapping"]:
        data["gameOverrides"][gid] = entry
    elif gid in data["gameOverrides"]:
        # keep name stub or remove
        del data["gameOverrides"][gid]
    return save_mappings(data)


def clear_game_override(game_id: str) -> dict[str, Any]:
    data = load_mappings()
    data["gameOverrides"].pop(str(game_id), None)
    return save_mappings(data)


def _resolve_key(code: str):
    if not code:
        return None
    c = code.lower().strip()
    if c in _SPECIAL:
        return _SPECIAL[c]
    if len(c) == 1:
        return KeyCode.from_char(c)
    return KeyCode.from_char(c[0]) if c else None


def _resolve_mouse(code: str):
    if Button is None:
        return None
    c = (code or "left").lower()
    if c in ("left", "lmb"):
        return Button.left
    if c in ("right", "rmb"):
        return Button.right
    if c in ("middle", "mmb"):
        return Button.middle
    return Button.left


def inject(action: str, pressed: bool, game_id: Optional[str] = None) -> dict[str, Any]:
    if _kb is None:
        return {"ok": False, "error": "pynput not installed"}

    eff = effective_mapping(game_id)
    bind = (eff.get("mapping") or {}).get(action)
    if not bind:
        return {"ok": False, "error": f"no mapping for {action}"}

    kind = bind.get("type") or "key"
    code = str(bind.get("code") or "")
    token = f"{kind}:{code}"

    with _lock:
        if pressed:
            if token in _pressed:
                return {"ok": True, "duplicate": True, "effective": eff}
            _pressed.add(token)
        else:
            if token not in _pressed:
                return {"ok": True, "duplicate": True, "effective": eff}
            _pressed.discard(token)

        try:
            if kind == "key":
                key = _resolve_key(code)
                if key is None:
                    return {"ok": False, "error": f"bad key {code}"}
                if pressed:
                    _kb.press(key)
                else:
                    _kb.release(key)
            elif kind == "mouse":
                btn = _resolve_mouse(code)
                if pressed:
                    _mouse.press(btn)
                else:
                    _mouse.release(btn)
            else:
                return {"ok": False, "error": f"unknown type {kind}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    return {
        "ok": True,
        "action": action,
        "pressed": pressed,
        "bind": bind,
        "effective": {"gameId": eff.get("gameId"), "overrideActions": eff.get("overrideActions")},
    }


def release_all() -> None:
    data = load_mappings()
    maps = effective_mapping().get("mapping") or data.get("mapping") or {}
    for action in list(maps.keys()):
        inject(action, False)
