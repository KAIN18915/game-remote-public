"""Read host gamepads for library UI navigation.

Browser Gamepad API often stays empty until a gesture, or is blocked by Steam.
We poll the PC directly:
  1) XInput (Xbox pads / DualSense in Xbox mode / Steam Input Xbox)
  2) winmm joyGetPosEx (many DirectInput / DualSense native pads)
"""
from __future__ import annotations

import ctypes
import os
import time
from ctypes import wintypes
from typing import Any, Optional

# ---- XInput ----
XINPUT_GAMEPAD_DPAD_UP = 0x0001
XINPUT_GAMEPAD_DPAD_DOWN = 0x0002
XINPUT_GAMEPAD_DPAD_LEFT = 0x0004
XINPUT_GAMEPAD_DPAD_RIGHT = 0x0008
XINPUT_GAMEPAD_START = 0x0010
XINPUT_GAMEPAD_BACK = 0x0020
XINPUT_GAMEPAD_LEFT_THUMB = 0x0040
XINPUT_GAMEPAD_RIGHT_THUMB = 0x0080
XINPUT_GAMEPAD_LEFT_SHOULDER = 0x0100
XINPUT_GAMEPAD_RIGHT_SHOULDER = 0x0200
XINPUT_GAMEPAD_A = 0x1000
XINPUT_GAMEPAD_B = 0x2000
XINPUT_GAMEPAD_X = 0x4000
XINPUT_GAMEPAD_Y = 0x8000

ERROR_SUCCESS = 0
_STICK_DEAD = 12000  # of ±32767
_MM_DEAD = 8000  # of 0..65535 around center 32767


class XINPUT_GAMEPAD(ctypes.Structure):
    _fields_ = [
        ("wButtons", wintypes.WORD),
        ("bLeftTrigger", wintypes.BYTE),
        ("bRightTrigger", wintypes.BYTE),
        ("sThumbLX", wintypes.SHORT),
        ("sThumbLY", wintypes.SHORT),
        ("sThumbRX", wintypes.SHORT),
        ("sThumbRY", wintypes.SHORT),
    ]


class XINPUT_STATE(ctypes.Structure):
    _fields_ = [
        ("dwPacketNumber", wintypes.DWORD),
        ("Gamepad", XINPUT_GAMEPAD),
    ]


class JOYINFOEX(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("dwXpos", wintypes.DWORD),
        ("dwYpos", wintypes.DWORD),
        ("dwZpos", wintypes.DWORD),
        ("dwRpos", wintypes.DWORD),
        ("dwUpos", wintypes.DWORD),
        ("dwVpos", wintypes.DWORD),
        ("dwButtons", wintypes.DWORD),
        ("dwButtonNumber", wintypes.DWORD),
        ("dwPOV", wintypes.DWORD),
        ("dwReserved1", wintypes.DWORD),
        ("dwReserved2", wintypes.DWORD),
    ]


JOY_RETURNALL = 0x00FF
JOYERR_NOERROR = 0

_xinput = None
_xinput_name: Optional[str] = None


def _load_xinput():
    global _xinput, _xinput_name
    if _xinput is not None or _xinput_name == "":
        return _xinput
    if os.name != "nt":
        _xinput_name = ""
        return None
    for name in ("xinput1_4", "xinput1_3", "xinput9_1_0", "xinput1_2", "xinput1_1"):
        try:
            dll = getattr(ctypes.windll, name)
            st = XINPUT_STATE()
            dll.XInputGetState(0, ctypes.byref(st))
            _xinput = dll
            _xinput_name = name
            return dll
        except Exception:  # noqa: BLE001
            continue
    _xinput_name = ""
    return None


def _axis_xi(v: int, dead: int = _STICK_DEAD) -> float:
    if abs(v) < dead:
        return 0.0
    return max(-1.0, min(1.0, v / 32767.0))


def _axis_mm(pos: int, dead: int = _MM_DEAD) -> float:
    # 0..65535, center ~32767
    c = int(pos) - 32767
    if abs(c) < dead:
        return 0.0
    return max(-1.0, min(1.0, c / 32767.0))


def _digital_axes(lx: float, ly: float, dpad: dict[str, bool]) -> dict[str, Any]:
    dead = 0.38
    return {
        "left": lx < -dead or dpad.get("left", False),
        "right": lx > dead or dpad.get("right", False),
        "up": ly < -dead or dpad.get("up", False),
        "down": ly > dead or dpad.get("down", False),
        "lx": lx,
        "ly": ly,
    }


def _pack_xinput(index: int, st: XINPUT_STATE) -> dict[str, Any]:
    g = st.Gamepad
    b = int(g.wButtons)
    lx = _axis_xi(int(g.sThumbLX))
    ly = _axis_xi(-int(g.sThumbLY))  # match browser: up = negative
    buttons = {
        "a": bool(b & XINPUT_GAMEPAD_A),
        "b": bool(b & XINPUT_GAMEPAD_B),
        "x": bool(b & XINPUT_GAMEPAD_X),
        "y": bool(b & XINPUT_GAMEPAD_Y),
        "l1": bool(b & XINPUT_GAMEPAD_LEFT_SHOULDER),
        "r1": bool(b & XINPUT_GAMEPAD_RIGHT_SHOULDER),
        "l2": int(g.bLeftTrigger) > 30,
        "r2": int(g.bRightTrigger) > 30,
        "select": bool(b & XINPUT_GAMEPAD_BACK),
        "start": bool(b & XINPUT_GAMEPAD_START),
        "l3": bool(b & XINPUT_GAMEPAD_LEFT_THUMB),
        "r3": bool(b & XINPUT_GAMEPAD_RIGHT_THUMB),
        "up": bool(b & XINPUT_GAMEPAD_DPAD_UP),
        "down": bool(b & XINPUT_GAMEPAD_DPAD_DOWN),
        "left": bool(b & XINPUT_GAMEPAD_DPAD_LEFT),
        "right": bool(b & XINPUT_GAMEPAD_DPAD_RIGHT),
    }
    return {
        "index": index,
        "id": f"XInput#{index}",
        "backend": "xinput",
        "packet": int(st.dwPacketNumber),
        "buttons": buttons,
        "axes": _digital_axes(lx, ly, buttons),
    }


def _pov_dirs(pov: int) -> dict[str, bool]:
    # winmm POV: 0..35900 (hundredths of degrees), or 0xFFFFFFFF when neutral
    if pov == 0xFFFFFFFF or pov < 0 or pov > 35900:
        return {"up": False, "down": False, "left": False, "right": False}
    deg = (pov / 100.0) % 360.0
    # Allow diagonals
    return {
        "up": deg >= 315 or deg <= 45,
        "right": 45 <= deg <= 135,
        "down": 135 <= deg <= 225,
        "left": 225 <= deg <= 315,
    }


def _pack_winmm(index: int, info: JOYINFOEX) -> dict[str, Any]:
    """Best-effort button map for DualSense / generic pads via winmm."""
    raw = int(info.dwButtons)
    # Common DualSense / XInput-via-DInput ordering (1-based bits):
    # bit0=□/X, bit1=✕/A, bit2=○/B, bit3=△/Y — varies by driver.
    # Prefer a layout that treats bit1 as confirm (A/✕) which matches many DS mappings,
    # and also OR bit0 as confirm so either face-bottom/left works.
    b0 = bool(raw & (1 << 0))
    b1 = bool(raw & (1 << 1))
    b2 = bool(raw & (1 << 2))
    b3 = bool(raw & (1 << 3))
    b4 = bool(raw & (1 << 4))
    b5 = bool(raw & (1 << 5))
    b8 = bool(raw & (1 << 8))
    b9 = bool(raw & (1 << 9))

    pov = _pov_dirs(int(info.dwPOV))
    lx = _axis_mm(int(info.dwXpos))
    ly = _axis_mm(int(info.dwYpos))

    # DualSense HID via winmm often: 0=Square, 1=Cross, 2=Circle, 3=Triangle
    buttons = {
        "a": b1,  # Cross / A
        "b": b2,  # Circle / B
        "x": b0,  # Square / X
        "y": b3,  # Triangle / Y
        "l1": b4,
        "r1": b5,
        "l2": False,
        "r2": False,
        "select": b8,
        "start": b9,
        "l3": bool(raw & (1 << 10)),
        "r3": bool(raw & (1 << 11)),
        "up": pov["up"],
        "down": pov["down"],
        "left": pov["left"],
        "right": pov["right"],
    }
    return {
        "index": index,
        "id": f"WinMM#{index}",
        "backend": "winmm",
        "packet": int(info.dwButtonNumber) ^ int(info.dwXpos) ^ int(info.dwYpos) ^ int(info.dwButtons),
        "buttons": buttons,
        "axes": _digital_axes(lx, ly, buttons),
        "rawButtons": raw,
    }


def _read_xinput_pads() -> list[dict[str, Any]]:
    dll = _load_xinput()
    if not dll:
        return []
    pads: list[dict[str, Any]] = []
    for i in range(4):
        st = XINPUT_STATE()
        try:
            res = int(dll.XInputGetState(i, ctypes.byref(st)))
        except Exception:  # noqa: BLE001
            continue
        if res == ERROR_SUCCESS:
            pads.append(_pack_xinput(i, st))
    return pads


_live_winmm: set[int] = set()


def _winmm_proves_real(info: JOYINFOEX) -> bool:
    """Phantom winmm slots often report success with centered sticks and POV=0 (not -1)."""
    if int(info.dwButtons):
        return True
    if abs(int(info.dwXpos) - 32767) > _MM_DEAD or abs(int(info.dwYpos) - 32767) > _MM_DEAD:
        return True
    if abs(int(info.dwZpos) - 32767) > _MM_DEAD or abs(int(info.dwRpos) - 32767) > _MM_DEAD:
        return True
    pov = int(info.dwPOV)
    # Centered is 0xFFFFFFFF. POV==0 means "up" but is also the ghost default — ignore alone.
    if pov != 0xFFFFFFFF and pov != 0 and 0 < pov <= 35900:
        return True
    return False


def _read_winmm_pads() -> list[dict[str, Any]]:
    global _live_winmm
    if os.name != "nt":
        return []
    try:
        winmm = ctypes.windll.winmm
    except Exception:  # noqa: BLE001
        return []
    pads: list[dict[str, Any]] = []
    try:
        n = int(winmm.joyGetNumDevs())
    except Exception:  # noqa: BLE001
        return []
    for i in range(min(n, 16)):
        info = JOYINFOEX()
        info.dwSize = ctypes.sizeof(JOYINFOEX)
        info.dwFlags = JOY_RETURNALL
        try:
            res = int(winmm.joyGetPosEx(i, ctypes.byref(info)))
        except Exception:  # noqa: BLE001
            continue
        if res != JOYERR_NOERROR:
            _live_winmm.discard(i)
            continue
        if _winmm_proves_real(info):
            _live_winmm.add(i)
        if i not in _live_winmm:
            continue
        pads.append(_pack_winmm(i, info))
    return pads


def read_pad_state() -> dict[str, Any]:
    """Snapshot of connected host pads. Prefer XInput; fall back to winmm."""
    xi = _read_xinput_pads()
    if xi:
        return {
            "ok": True,
            "available": True,
            "connected": True,
            "pads": xi,
            "backend": _xinput_name or "xinput",
            "ts": time.time(),
        }

    mm = _read_winmm_pads()
    return {
        "ok": True,
        "available": os.name == "nt",
        "connected": bool(mm),
        "pads": mm,
        "backend": "winmm" if mm else (_xinput_name or None),
        "ts": time.time(),
    }
