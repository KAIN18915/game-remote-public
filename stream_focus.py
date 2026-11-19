"""Focus / crop stream appearance by managing the game HWND on the capture display.

Stock Sunshine streams a full display (not an arbitrary HWND). \"Game\" mode makes
the launched game cover that display borderlessly so the stream looks game-only.
\"Desktop\" mode restores the previous window chrome/bounds when we have them.
"""
from __future__ import annotations

import ctypes
import threading
from ctypes import wintypes
from pathlib import Path
from typing import Any, Optional

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZE = 0x20000000
WS_MAXIMIZE = 0x01000000
WS_SYSMENU = 0x00080000
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040
SWP_NOZORDER = 0x0004
HWND_TOP = 0
SW_RESTORE = 9
SW_SHOW = 5
GW_OWNER = 4

if ctypes.sizeof(ctypes.c_void_p) == 8:
    _get_window_long = user32.GetWindowLongPtrW
    _set_window_long = user32.SetWindowLongPtrW
else:
    _get_window_long = user32.GetWindowLongW
    _set_window_long = user32.SetWindowLongW

_lock = threading.Lock()
_mode: str = "game"  # desktop | game (default: cover capture display with game)
_last_exe: Optional[Path] = None
_saved: dict[int, dict[str, Any]] = {}
_alive_cache: tuple[float, bool] = (0.0, False)  # (monotonic_ts, value)
_ALIVE_TTL_S = 1.0
_STATE_PATH = Path(__file__).resolve().parent / "last-launch.json"


def _load_persisted_exe() -> None:
    """Restore last exe after server restart so alive/quit keep working."""
    global _last_exe
    try:
        if not _STATE_PATH.is_file():
            return
        import json

        data = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
        raw = (data or {}).get("exe")
        if raw:
            _last_exe = Path(raw)
    except Exception:  # noqa: BLE001
        pass


def _persist_exe(exe: Optional[Path]) -> None:
    try:
        import json

        if exe:
            _STATE_PATH.write_text(
                json.dumps({"exe": str(exe)}, ensure_ascii=False),
                encoding="utf-8",
            )
        elif _STATE_PATH.is_file():
            _STATE_PATH.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


_load_persisted_exe()


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


def set_last_launch(exe: Path | str | None) -> None:
    global _last_exe, _alive_cache
    with _lock:
        _last_exe = Path(exe) if exe else None
        _alive_cache = (0.0, False)
        _persist_exe(_last_exe)


def set_last_launch_for_game(exe: Path | str | None, game_id: Optional[str] = None) -> None:
    """Like set_last_launch, but also stores game_id for restart validation."""
    global _last_exe, _alive_cache
    with _lock:
        _last_exe = Path(exe) if exe else None
        _alive_cache = (0.0, False)
        try:
            import json

            if _last_exe:
                _STATE_PATH.write_text(
                    json.dumps(
                        {"exe": str(_last_exe), "gameId": game_id},
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
            elif _STATE_PATH.is_file():
                _STATE_PATH.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


def get_last_exe() -> Optional[Path]:
    with _lock:
        return _last_exe


def is_game_running(exe: Path | str | None = None) -> bool:
    """True if the tracked (or given) game process appears to be running."""
    import time

    global _alive_cache
    explicit = Path(exe) if exe else None
    with _lock:
        target = explicit or _last_exe
        if not explicit:
            now = time.monotonic()
            ts, cached = _alive_cache
            if now - ts < _ALIVE_TTL_S:
                return cached
    if not target:
        return False
    # Fast path: visible top-level windows only (avoid full tasklist on every poll)
    target_name = target.name.lower()
    try:
        target_str = str(target.resolve() if target.exists() else target).lower()
    except OSError:
        target_str = str(target).lower()
    alive = False
    for _hwnd, pid, _title in _enum_top_windows():
        path = _exe_path_for_pid(pid)
        if not path:
            continue
        p = path.lower()
        if p == target_str or p.endswith("\\" + target_name) or Path(path).name.lower() == target_name:
            alive = True
            break
    if not explicit:
        with _lock:
            _alive_cache = (time.monotonic(), alive)
    return alive


def get_mode() -> str:
    return _mode


def _primary_rect() -> tuple[int, int, int, int]:
    # Origin + size of primary monitor (what Sunshine usually captures)
    w = int(user32.GetSystemMetrics(0))
    h = int(user32.GetSystemMetrics(1))
    return (0, 0, w, h)


def _pid_image_paths() -> dict[int, str]:
    """Map PID -> executable path (best effort via CreateToolhelp32 / QueryFullProcessImageName)."""
    out: dict[int, str] = {}
    # Use psutil-free approach: EnumProcesses is heavy; instead EnumWindows and
    # QueryFullProcessImageName per unique PID we care about later.
    return out


def _exe_path_for_pid(pid: int) -> Optional[str]:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        # QueryFullProcessImageNameW
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        kernel32.CloseHandle(handle)
    return None


def _enum_top_windows() -> list[tuple[int, int, str]]:
    """Return (hwnd, pid, title) for visible top-level windows."""
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    found: list[tuple[int, int, str]] = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        if user32.GetWindow(hwnd, GW_OWNER):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        length = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if length:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value
        found.append((int(hwnd), int(pid.value), title))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def _match_game_hwnds(exe: Optional[Path]) -> list[int]:
    if not exe:
        return []
    target = exe.resolve() if exe.exists() else exe
    target_name = target.name.lower()
    target_str = str(target).lower()
    hwnds: list[int] = []
    for hwnd, pid, title in _enum_top_windows():
        path = _exe_path_for_pid(pid)
        if not path:
            continue
        p = path.lower()
        if p == target_str or p.endswith("\\" + target_name) or Path(path).name.lower() == target_name:
            # Prefer windows with some size
            rect = RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                if w >= 200 and h >= 150:
                    hwnds.append(hwnd)
    return hwnds


def _save_window(hwnd: int) -> None:
    if hwnd in _saved:
        return
    style = int(_get_window_long(hwnd, GWL_STYLE))
    exstyle = int(_get_window_long(hwnd, GWL_EXSTYLE))
    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    _saved[hwnd] = {
        "style": style,
        "exstyle": exstyle,
        "left": rect.left,
        "top": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def _apply_game_cover(hwnd: int) -> None:
    _save_window(hwnd)
    user32.ShowWindow(hwnd, SW_RESTORE)
    # Borderless popup covering primary display
    style = int(_get_window_long(hwnd, GWL_STYLE))
    style &= ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZE | WS_MAXIMIZE)
    style |= WS_POPUP | WS_VISIBLE
    _set_window_long(hwnd, GWL_STYLE, style)
    x, y, w, h = _primary_rect()
    user32.SetWindowPos(hwnd, HWND_TOP, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW)
    user32.SetForegroundWindow(hwnd)


def _restore_window(hwnd: int) -> None:
    info = _saved.get(hwnd)
    if not info:
        return
    if not user32.IsWindow(hwnd):
        _saved.pop(hwnd, None)
        return
    _set_window_long(hwnd, GWL_STYLE, info["style"])
    _set_window_long(hwnd, GWL_EXSTYLE, info["exstyle"])
    user32.SetWindowPos(
        hwnd,
        HWND_TOP,
        info["left"],
        info["top"],
        info["width"],
        info["height"],
        SWP_FRAMECHANGED | SWP_SHOWWINDOW,
    )
    user32.ShowWindow(hwnd, SW_SHOW)


def apply_mode(mode: str, exe: Optional[Path] = None) -> dict[str, Any]:
    """Switch between desktop (normal windows) and game (cover capture display)."""
    global _mode
    mode = (mode or "desktop").lower().strip()
    if mode not in ("desktop", "game"):
        raise ValueError("mode must be desktop or game")

    with _lock:
        use_exe = exe or _last_exe
        if mode == "desktop":
            for hwnd in list(_saved.keys()):
                _restore_window(hwnd)
            _mode = "desktop"
            return {
                "mode": _mode,
                "restored": len(_saved),
                "exe": str(use_exe) if use_exe else None,
                "note": "display",
            }

        # game mode
        hwnds = _match_game_hwnds(use_exe)
        if not hwnds:
            _mode = "game"
            return {
                "mode": _mode,
                "ok": False,
                "hwnds": [],
                "exe": str(use_exe) if use_exe else None,
                "error": "game window not found",
            }
        for hwnd in hwnds:
            _apply_game_cover(hwnd)
        _mode = "game"
        return {
            "mode": _mode,
            "ok": True,
            "hwnds": hwnds,
            "exe": str(use_exe) if use_exe else None,
            "display": list(_primary_rect()),
            "note": "game-cover",
        }


def status() -> dict[str, Any]:
    return {
        "mode": _mode,
        "last_exe": str(_last_exe) if _last_exe else None,
        "saved_windows": len(_saved),
        "capability": "game-cover",
        # True window capture needs a Sunshine fork; we cover the capture display instead.
        "true_window_capture": False,
    }


def _pids_for_exe(exe: Optional[Path]) -> list[int]:
    if not exe:
        return []
    target = exe.resolve() if exe.exists() else exe
    target_name = target.name.lower()
    target_str = str(target).lower()
    pids: set[int] = set()
    for _hwnd, pid, _title in _enum_top_windows():
        path = _exe_path_for_pid(pid)
        if not path:
            continue
        p = path.lower()
        if p == target_str or p.endswith("\\" + target_name) or Path(path).name.lower() == target_name:
            pids.add(pid)
    # Also scan via tasklist matching image name (covers processes without visible windows)
    try:
        import subprocess

        r = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        for line in (r.stdout or "").splitlines():
            # "name.exe","1234",...
            parts = [x.strip().strip('"') for x in line.split(",")]
            if len(parts) < 2:
                continue
            if parts[0].lower() != target_name:
                continue
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass
    except Exception:  # noqa: BLE001
        pass
    return sorted(pids)


def quit_game(force: bool = True) -> dict[str, Any]:
    """Close the last launched game (WM_CLOSE then optional taskkill)."""
    global _last_exe
    WM_CLOSE = 0x0010
    with _lock:
        exe = _last_exe
        if not exe:
            return {"ok": False, "error": "no active game", "exe": None}

        hwnds = _match_game_hwnds(exe)
        for hwnd in hwnds:
            try:
                user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
            except Exception:  # noqa: BLE001
                pass
            _saved.pop(hwnd, None)

        killed: list[int] = []
        if force:
            import subprocess
            import time

            time.sleep(0.4)
            for pid in _pids_for_exe(exe):
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid), "/T"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                killed.append(pid)
            # Fallback by image name
            if not killed:
                subprocess.run(
                    ["taskkill", "/F", "/IM", exe.name, "/T"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )

        _last_exe = None
        _persist_exe(None)
        return {
            "ok": True,
            "exe": str(exe),
            "closed_hwnds": hwnds,
            "killed_pids": killed,
        }
