"""Change / restore the primary display mode (Windows).

Sunshine captures the desktop; stream encode size alone cannot add detail
above the host OS resolution. Matching the host mode to the requested stream
size is the reliable fix for this stack.
"""
from __future__ import annotations

import ctypes
import json
import threading
from ctypes import wintypes
from pathlib import Path
from typing import Any, Optional

user32 = ctypes.windll.user32

ENUM_CURRENT_SETTINGS = -1
CDS_UPDATEREGISTRY = 0x00000001
CDS_TEST = 0x00000002
DISP_CHANGE_SUCCESSFUL = 0
DM_PELSWIDTH = 0x00080000
DM_PELSHEIGHT = 0x00100000
DM_DISPLAYFREQUENCY = 0x00400000
DM_BITSPERPEL = 0x00040000

_STATE_PATH = Path(__file__).resolve().parent / "display-mode-backup.json"
_lock = threading.Lock()


class DEVMODEW(ctypes.Structure):
    _fields_ = [
        ("dmDeviceName", wintypes.WCHAR * 32),
        ("dmSpecVersion", wintypes.WORD),
        ("dmDriverVersion", wintypes.WORD),
        ("dmSize", wintypes.WORD),
        ("dmDriverExtra", wintypes.WORD),
        ("dmFields", wintypes.DWORD),
        ("dmPositionX", ctypes.c_long),
        ("dmPositionY", ctypes.c_long),
        ("dmDisplayOrientation", wintypes.DWORD),
        ("dmDisplayFixedOutput", wintypes.DWORD),
        ("dmColor", wintypes.SHORT),
        ("dmDuplex", wintypes.SHORT),
        ("dmYResolution", wintypes.SHORT),
        ("dmTTOption", wintypes.SHORT),
        ("dmCollate", wintypes.SHORT),
        ("dmFormName", wintypes.WCHAR * 32),
        ("dmLogPixels", wintypes.WORD),
        ("dmBitsPerPel", wintypes.DWORD),
        ("dmPelsWidth", wintypes.DWORD),
        ("dmPelsHeight", wintypes.DWORD),
        ("dmDisplayFlags", wintypes.DWORD),
        ("dmDisplayFrequency", wintypes.DWORD),
        ("dmICMMethod", wintypes.DWORD),
        ("dmICMIntent", wintypes.DWORD),
        ("dmMediaType", wintypes.DWORD),
        ("dmDitherType", wintypes.DWORD),
        ("dmReserved1", wintypes.DWORD),
        ("dmReserved2", wintypes.DWORD),
        ("dmPanningWidth", wintypes.DWORD),
        ("dmPanningHeight", wintypes.DWORD),
    ]


def _current_mode() -> Optional[dict[str, int]]:
    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    if not user32.EnumDisplaySettingsW(None, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
        return None
    return {
        "width": int(dm.dmPelsWidth),
        "height": int(dm.dmPelsHeight),
        "refresh": int(dm.dmDisplayFrequency or 60),
        "bpp": int(dm.dmBitsPerPel or 32),
    }


def list_modes(max_count: int = 120) -> list[dict[str, int]]:
    out: list[dict[str, int]] = []
    seen: set[tuple[int, int, int]] = set()
    i = 0
    while True:
        dm = DEVMODEW()
        dm.dmSize = ctypes.sizeof(DEVMODEW)
        if not user32.EnumDisplaySettingsW(None, i, ctypes.byref(dm)):
            break
        key = (int(dm.dmPelsWidth), int(dm.dmPelsHeight), int(dm.dmDisplayFrequency or 0))
        if key not in seen and key[0] >= 800 and key[1] >= 600:
            seen.add(key)
            out.append({"width": key[0], "height": key[1], "refresh": key[2]})
        i += 1
        if i > 400 or len(out) >= max_count:
            break
    out.sort(key=lambda m: (m["width"] * m["height"], m["refresh"]))
    return out


def _find_best_mode(width: int, height: int) -> Optional[DEVMODEW]:
    """Exact match preferred; else same aspect with closest area; else closest area."""
    best: Optional[tuple[float, DEVMODEW]] = None
    target_ar = width / max(height, 1)
    i = 0
    while True:
        dm = DEVMODEW()
        dm.dmSize = ctypes.sizeof(DEVMODEW)
        if not user32.EnumDisplaySettingsW(None, i, ctypes.byref(dm)):
            break
        w, h = int(dm.dmPelsWidth), int(dm.dmPelsHeight)
        if w < 800 or h < 600:
            i += 1
            continue
        if w == width and h == height:
            # Prefer higher refresh among exact matches
            score = -float(dm.dmDisplayFrequency or 0)
            if best is None or score < best[0]:
                best = (score, dm)
        i += 1
        if i > 400:
            break
    if best:
        return best[1]

    # Fallback: closest resolution
    best2: Optional[tuple[float, DEVMODEW]] = None
    i = 0
    while True:
        dm = DEVMODEW()
        dm.dmSize = ctypes.sizeof(DEVMODEW)
        if not user32.EnumDisplaySettingsW(None, i, ctypes.byref(dm)):
            break
        w, h = int(dm.dmPelsWidth), int(dm.dmPelsHeight)
        if w < 800 or h < 600:
            i += 1
            continue
        ar = w / max(h, 1)
        area_delta = abs(w * h - width * height) / max(width * height, 1)
        ar_delta = abs(ar - target_ar)
        score = area_delta + ar_delta * 2
        if best2 is None or score < best2[0]:
            best2 = (score, dm)
        i += 1
        if i > 400:
            break
    return best2[1] if best2 else None


def _apply_mode(dm: DEVMODEW) -> int:
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_BITSPERPEL
    # Test first
    test = user32.ChangeDisplaySettingsW(ctypes.byref(dm), CDS_TEST)
    if test != DISP_CHANGE_SUCCESSFUL:
        return int(test)
    return int(user32.ChangeDisplaySettingsW(ctypes.byref(dm), CDS_UPDATEREGISTRY))


def _save_backup(mode: dict[str, int]) -> None:
    try:
        _STATE_PATH.write_text(json.dumps(mode), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _load_backup() -> Optional[dict[str, int]]:
    try:
        if not _STATE_PATH.is_file():
            return None
        data = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("width") and data.get("height"):
            return {
                "width": int(data["width"]),
                "height": int(data["height"]),
                "refresh": int(data.get("refresh") or 60),
                "bpp": int(data.get("bpp") or 32),
            }
    except Exception:  # noqa: BLE001
        return None
    return None


def _clear_backup() -> None:
    try:
        _STATE_PATH.unlink(missing_ok=True)
    except TypeError:
        if _STATE_PATH.exists():
            _STATE_PATH.unlink()
    except Exception:  # noqa: BLE001
        pass


def status() -> dict[str, Any]:
    cur = _current_mode() or {"width": 0, "height": 0, "refresh": 0}
    backup = _load_backup()
    return {
        "current": cur,
        "backup": backup,
        "modes": list_modes(80),
    }


def set_resolution(width: int, height: int, *, save_backup: bool = True) -> dict[str, Any]:
    """Set primary display close to width x height. Remembers prior mode once."""
    width, height = int(width), int(height)
    if width < 640 or height < 480:
        return {"ok": False, "error": "invalid size"}

    with _lock:
        cur = _current_mode()
        if not cur:
            return {"ok": False, "error": "cannot read current mode"}

        if cur["width"] == width and cur["height"] == height:
            return {
                "ok": True,
                "changed": False,
                "current": cur,
                "requested": {"width": width, "height": height},
                "note": "already at requested size",
            }

        dm = _find_best_mode(width, height)
        if not dm:
            return {"ok": False, "error": "no compatible display mode", "current": cur}

        if save_backup and not _load_backup():
            _save_backup(cur)

        rc = _apply_mode(dm)
        new = _current_mode()
        ok = rc == DISP_CHANGE_SUCCESSFUL
        return {
            "ok": ok,
            "changed": ok,
            "cds_result": rc,
            "requested": {"width": width, "height": height},
            "applied": {
                "width": int(dm.dmPelsWidth),
                "height": int(dm.dmPelsHeight),
                "refresh": int(dm.dmDisplayFrequency or 0),
            },
            "current": new,
            "backup": _load_backup(),
            "error": None if ok else f"ChangeDisplaySettings failed ({rc})",
        }


def restore() -> dict[str, Any]:
    """Restore the mode saved before the first stream-driven change."""
    with _lock:
        backup = _load_backup()
        if not backup:
            cur = _current_mode()
            return {"ok": True, "changed": False, "current": cur, "note": "no backup"}

        dm = _find_best_mode(backup["width"], backup["height"])
        if not dm:
            return {"ok": False, "error": "backup mode unavailable", "backup": backup}

        # Prefer matching refresh if possible
        i = 0
        while True:
            cand = DEVMODEW()
            cand.dmSize = ctypes.sizeof(DEVMODEW)
            if not user32.EnumDisplaySettingsW(None, i, ctypes.byref(cand)):
                break
            if (
                int(cand.dmPelsWidth) == backup["width"]
                and int(cand.dmPelsHeight) == backup["height"]
                and int(cand.dmDisplayFrequency or 0) == int(backup.get("refresh") or 0)
            ):
                dm = cand
                break
            i += 1
            if i > 400:
                break

        rc = _apply_mode(dm)
        ok = rc == DISP_CHANGE_SUCCESSFUL
        if ok:
            _clear_backup()
        return {
            "ok": ok,
            "changed": ok,
            "cds_result": rc,
            "restored": backup,
            "current": _current_mode(),
            "error": None if ok else f"ChangeDisplaySettings failed ({rc})",
        }
