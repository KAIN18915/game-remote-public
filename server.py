"""Game Remote — Playnite library + launcher + input bridge (DB read-only)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import input_bridge
import host_pad
import host_stubs
from extensions import registry as extensions

# Windows-only modules (Win32 window/display control). In a Linux container
# they load as stubs that report "host-only feature".
stream_focus = host_stubs.load("stream_focus")
display_res = host_stubs.load("display_res")
IS_WINDOWS_HOST = os.name == "nt"
from paths import candidate_paths, remap_path, resolve_existing_dir

ROOT = Path(__file__).resolve().parent
PLAYNITE_LIBRARY = Path(os.environ.get(
    "PLAYNITE_LIBRARY",
    os.path.expandvars(r"%APPDATA%\Playnite\library"),
))
CACHE_DIR = ROOT / "cache"
# PlayniteReader (C# + LiteDB) turns Playnite's games.db into JSON.
READER_EXE = Path(os.environ.get(
    "PLAYNITE_READER",
    str(ROOT / "tools" / "PlayniteReader" / "bin" / "Release" / "net8.0" / "PlayniteReader.exe"),
))
PLAYNITE_EXE = Path(os.environ.get(
    "PLAYNITE_EXE",
    os.path.expandvars(r"%LOCALAPPDATA%\Playnite\Playnite.DesktopApp.exe"),
))
FILES_DIR = PLAYNITE_LIBRARY / "files"
MOONLIGHT_WEB_URL = os.environ.get("MOONLIGHT_WEB_URL", "")
MOONLIGHT_WEB_PORT = int(os.environ.get("MOONLIGHT_WEB_PORT", "8080"))
ACCESS_TOKEN = os.environ.get("GAME_REMOTE_TOKEN", "")
HOST_BIND = os.environ.get("GAME_REMOTE_HOST", "0.0.0.0")
PORT = int(os.environ.get("GAME_REMOTE_PORT", "8765"))
STREAM_OPEN_DELAY_MS = int(os.environ.get("STREAM_OPEN_DELAY_MS", "300"))
CODE_REV = "20260903x"

_cache_lock = threading.Lock()
_games_cache: Optional[dict[str, Any]] = None
_cache_mtime: float = 0.0
_cache_ttl = 300.0
_GAMES_JSON = CACHE_DIR / "games.json"
_moonlight_up_cache: tuple[float, bool] = (0.0, False)
_library_source = "unknown"


def _moonlight_up_fast() -> bool:
    """Cached port probe — health must stay cheap under frequent client polls."""
    global _moonlight_up_cache
    now = time.monotonic()
    ts, cached = _moonlight_up_cache
    if now - ts < 8.0:
        return cached
    up = False
    try:
        import urllib.request

        with urllib.request.urlopen(
            f"http://127.0.0.1:{MOONLIGHT_WEB_PORT}/",
            timeout=0.35,
        ) as resp:
            up = 200 <= int(getattr(resp, "status", 200) or 200) < 500
    except Exception:  # noqa: BLE001
        up = False
    _moonlight_up_cache = (now, up)
    return up


app = FastAPI(title="Game Remote", version="2.0.0")

# Endpoints that drive the Windows game host itself (launch, quit, window and
# display control, key injection). In container mode they answer 501.
_HOST_ONLY_PREFIXES = (
    "/api/launch",
    "/api/quit-game",
    "/api/stream-mode",
    "/api/display",
    "/api/input/inject",
    "/api/input/release-all",
    "/api/input/pad-state",
)


@app.middleware("http")
async def _host_only_guard(request: Request, call_next):
    if not IS_WINDOWS_HOST and request.url.path.startswith(_HOST_ONLY_PREFIXES):
        from fastapi.responses import JSONResponse

        return JSONResponse(dict(host_stubs.UNAVAILABLE), status_code=501)
    return await call_next(request)


extensions.load_from_env()
extensions.mount(app)


def _check_token(token: Optional[str]) -> None:
    if not ACCESS_TOKEN:
        return
    if token != ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="invalid token")


def stream_url_for_request(request: Request) -> str:
    if MOONLIGHT_WEB_URL:
        return MOONLIGHT_WEB_URL.rstrip("/")
    proto = (
        request.headers.get("x-forwarded-proto")
        or request.url.scheme
        or "http"
    ).split(",")[0].strip()
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
        or "127.0.0.1"
    ).split(",")[0].strip()
    if ":" in host and not host.startswith("["):
        hostname = host.rsplit(":", 1)[0]
    elif host.startswith("[") and "]:" in host:
        hostname = host[: host.rfind("]:") + 1]
    else:
        hostname = host
    return f"{proto}://{hostname}:{MOONLIGHT_WEB_PORT}"


def _cache_games_ok() -> bool:
    dest = CACHE_DIR / "games.db"
    try:
        return dest.is_file() and dest.stat().st_size > 1000
    except OSError:
        return False


def _copy_one_db(src: Path, dest_name: str) -> None:
    last_err: Optional[OSError] = None
    dest = CACHE_DIR / dest_name
    for attempt in range(3):
        tmp = CACHE_DIR / (dest_name + ".tmp")
        try:
            with open(src, "rb") as rf, open(tmp, "wb") as wf:
                shutil.copyfileobj(rf, wf, length=1024 * 1024)
            os.replace(tmp, dest)
            return
        except OSError as err:
            last_err = err
            try:
                tmp.unlink(missing_ok=True)  # type: ignore[call-arg]
            except TypeError:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass
            time.sleep(0.25 * (attempt + 1))
    if last_err:
        raise last_err


def snapshot_library(force: bool = False) -> Path:
    """Copy Playnite *.db into cache. If the library drive fails to read, keep serving the last good cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    src_games = PLAYNITE_LIBRARY / "games.db"
    dest_games = CACHE_DIR / "games.db"
    try:
        src_exists = src_games.exists()
        src_mtime = src_games.stat().st_mtime if src_exists else 0.0
    except OSError:
        if _cache_games_ok():
            return CACHE_DIR
        raise

    if not src_exists:
        if _cache_games_ok():
            return CACHE_DIR
        raise FileNotFoundError(f"Playnite games.db not found: {src_games}")

    dest_mtime = dest_games.stat().st_mtime if dest_games.exists() else 0.0
    need = force or (not dest_games.exists()) or (src_mtime > dest_mtime + 1)
    if not need:
        return CACHE_DIR

    try:
        with _cache_lock:
            dest_mtime = dest_games.stat().st_mtime if dest_games.exists() else 0.0
            if force or (not dest_games.exists()) or (src_mtime > dest_mtime + 1):
                for db in PLAYNITE_LIBRARY.glob("*.db"):
                    _copy_one_db(db, db.name)
                meta = PLAYNITE_LIBRARY / "database.json"
                if meta.exists():
                    shutil.copy2(meta, CACHE_DIR / "database.json")
    except OSError:
        if _cache_games_ok():
            return CACHE_DIR
        raise
    return CACHE_DIR


def _read_games_json_cache() -> Optional[dict[str, Any]]:
    try:
        if not _GAMES_JSON.is_file() or _GAMES_JSON.stat().st_size < 100:
            return None
        data = json.loads(_GAMES_JSON.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("games"), list):
            return data
    except (OSError, json.JSONDecodeError):
        return None
    return None


def _write_games_json_cache(data: dict[str, Any]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_DIR / "games.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _GAMES_JSON)
    except OSError:
        pass


def load_games(query: str = "", force_refresh: bool = False) -> dict[str, Any]:
    global _games_cache, _cache_mtime, _library_source
    now = time.time()
    if (
        not force_refresh
        and _games_cache is not None
        and (now - _cache_mtime) < _cache_ttl
        and not query
    ):
        return _games_cache

    stale = _games_cache if _games_cache is not None else _read_games_json_cache()
    try:
        lib_cache = snapshot_library(force=force_refresh)
        if not READER_EXE.exists():
            raise FileNotFoundError(f"PlayniteReader missing: {READER_EXE}")

        cmd = [str(READER_EXE), str(lib_cache)]
        if query:
            cmd.append(query)

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr or f"reader exit {proc.returncode}")

        data = json.loads(proc.stdout)
        extensions.enrich(data.get("games") or [])
        _library_source = "reader"
        if not query:
            _games_cache = data
            _cache_mtime = now
            _write_games_json_cache(data)
        return data
    except Exception:
        if query:
            raise
        if stale:
            _games_cache = stale
            _cache_mtime = now
            _library_source = "stale-cache"
            return stale
        raise


def _remap_path(path: str) -> str:
    return remap_path(path)


def _resolve_install_dir(game: dict[str, Any]) -> str:
    raw = (game.get("installDirectory") or "").rstrip("\\/")
    if not raw:
        return ""
    return resolve_existing_dir(raw)


def _expand_playnite_vars(template: Optional[str], game: dict[str, Any], install: Optional[str] = None) -> str:
    """Resolve Playnite path tokens like {InstallDir}."""
    text = template or ""
    install_dir = (install if install is not None else _resolve_install_dir(game)).rstrip("\\/")
    playnite_dir = str(PLAYNITE_EXE.parent) if PLAYNITE_EXE.exists() else ""
    replacements = {
        "{InstallDir}": install_dir,
        "{PlayniteDir}": playnite_dir,
        "{WorkingDir}": install_dir,
        "{EmulatorDir}": "",
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return _remap_path(text)


def _current_windows_session_id() -> Optional[int]:
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        sid = wintypes.DWORD()
        if ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(sid)):
            return int(sid.value)
    except Exception:  # noqa: BLE001
        return None
    return None


def _ps_single_quoted(value: str) -> str:
    """PowerShell single-quoted string (literal path-safe; no \\u escapes)."""
    return "'" + value.replace("'", "''") + "'"


def _launch_windows_gui(exe: Path, cwd: str, cmd: list[str]) -> str:
    """Start a GUI game on the interactive desktop.

    Prefer direct ShellExecute when this server already runs in an interactive
    session (schtasks /IT). Fall back to a one-shot scheduled task when we are
    stuck in Session 0.
    """
    import uuid
    from datetime import datetime, timedelta

    args = cmd[1:]
    arg_line = subprocess.list2cmdline(args) if args else ""
    exe_s = str(exe)
    cwd_s = str(cwd)

    sid = _current_windows_session_id()
    if sid is not None and sid != 0:
        try:
            import ctypes

            rc = int(
                ctypes.windll.shell32.ShellExecuteW(
                    None, "open", exe_s, arg_line or None, cwd_s, 1
                )
            )
            if rc > 32:
                return f"shell-direct:{rc}"
        except Exception as e:  # noqa: BLE001
            # Continue to schtasks fallback
            _ = e

    tools = ROOT / "tools"
    tools.mkdir(parents=True, exist_ok=True)
    task = f"GameRemoteLaunch-{uuid.uuid4().hex[:10]}"
    ps1 = tools / f"_{task}.ps1"
    bat = tools / f"_{task}.bat"

    lines = [
        "$ErrorActionPreference = 'Stop'",
        "$p = New-Object System.Diagnostics.ProcessStartInfo",
        f"$p.FileName = {_ps_single_quoted(exe_s)}",
        f"$p.WorkingDirectory = {_ps_single_quoted(cwd_s)}",
        "$p.UseShellExecute = $true",
    ]
    if arg_line:
        lines.append(f"$p.Arguments = {_ps_single_quoted(arg_line)}")
    lines.append("[void][System.Diagnostics.Process]::Start($p)")
    ps1.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8-sig")

    bat.write_text(
        "@echo off\r\n"
        f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{ps1}"\r\n',
        encoding="utf-8",
    )

    st = (datetime.now() + timedelta(minutes=2)).strftime("%H:%M")
    create = subprocess.run(
        [
            "schtasks",
            "/Create",
            "/TN",
            task,
            "/TR",
            str(bat),
            "/SC",
            "ONCE",
            "/ST",
            st,
            "/F",
            "/IT",
            "/RL",
            "LIMITED",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if create.returncode != 0:
        try:
            import ctypes

            rc = ctypes.windll.shell32.ShellExecuteW(
                None, "open", exe_s, arg_line or None, cwd_s, 1
            )
            return f"shell-fallback:{rc}:{create.stderr.strip() or create.returncode}"
        except Exception as e:  # noqa: BLE001
            return f"launch-fail:{e}"

    run = subprocess.run(
        ["schtasks", "/Run", "/TN", task],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    def _cleanup() -> None:
        subprocess.run(["schtasks", "/Delete", "/TN", task, "/F"], capture_output=True)
        for p in (bat, ps1):
            try:
                p.unlink(missing_ok=True)  # type: ignore[call-arg]
            except TypeError:
                if p.exists():
                    p.unlink()
            except Exception:  # noqa: BLE001
                pass

    threading.Timer(30.0, _cleanup).start()
    if run.returncode != 0:
        return f"schtasks-run-fail:{run.stderr.strip() or run.returncode}"
    return "schtasks-it"


def _primary_screen_size() -> tuple[int, int]:
    """Interactive desktop size. Avoid Session-0 junk metrics (often 1024x768)."""
    if os.name != "nt":
        return (1920, 1080)
    fallback = (1920, 1080)
    try:
        import ctypes

        user32 = ctypes.windll.user32
        w = int(user32.GetSystemMetrics(0))  # SM_CXSCREEN
        h = int(user32.GetSystemMetrics(1))  # SM_CYSCREEN
        # Session 0 / broken desktop often reports tiny sizes; don't force those on Unity
        if w >= 1280 and h >= 720:
            return (w, h)
        # Try ENUM_CURRENT_SETTINGS on primary display
        class DEVMODE(ctypes.Structure):
            _fields_ = [
                ("dmDeviceName", ctypes.c_wchar * 32),
                ("dmSpecVersion", ctypes.c_ushort),
                ("dmDriverVersion", ctypes.c_ushort),
                ("dmSize", ctypes.c_ushort),
                ("dmDriverExtra", ctypes.c_ushort),
                ("dmFields", ctypes.c_uint),
                ("dmOrientation", ctypes.c_short),
                ("dmPaperSize", ctypes.c_short),
                ("dmPaperLength", ctypes.c_short),
                ("dmPaperWidth", ctypes.c_short),
                ("dmScale", ctypes.c_short),
                ("dmCopies", ctypes.c_short),
                ("dmDefaultSource", ctypes.c_short),
                ("dmPrintQuality", ctypes.c_short),
                ("dmColor", ctypes.c_short),
                ("dmDuplex", ctypes.c_short),
                ("dmYResolution", ctypes.c_short),
                ("dmTTOption", ctypes.c_short),
                ("dmCollate", ctypes.c_short),
                ("dmFormName", ctypes.c_wchar * 32),
                ("dmLogPixels", ctypes.c_ushort),
                ("dmBitsPerPel", ctypes.c_uint),
                ("dmPelsWidth", ctypes.c_uint),
                ("dmPelsHeight", ctypes.c_uint),
                ("dmDisplayFlags", ctypes.c_uint),
                ("dmDisplayFrequency", ctypes.c_uint),
            ]

        dm = DEVMODE()
        dm.dmSize = ctypes.sizeof(DEVMODE)
        ENUM_CURRENT_SETTINGS = -1
        if user32.EnumDisplaySettingsW(None, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
            ew, eh = int(dm.dmPelsWidth), int(dm.dmPelsHeight)
            if ew >= 1280 and eh >= 720:
                return (ew, eh)
        if w >= 640 and h >= 480:
            # Prefer fallback over known-bad session sizes for game launch args
            sid = _current_windows_session_id()
            if sid == 0:
                return fallback
            return (w, h)
    except Exception:  # noqa: BLE001
        pass
    return fallback


def _looks_like_unity(exe: Path) -> bool:
    stem = exe.stem
    parent = exe.parent
    return (parent / f"{stem}_Data").is_dir() or (parent / "Game_Data").is_dir()


def _looks_like_nwjs(exe: Path) -> bool:
    """RPG Maker MV/MZ (NW.js) and similar Chromium shells."""
    parent = exe.parent
    return (parent / "nw.dll").is_file() or (
        (parent / "package.json").is_file() and (parent / "www").is_dir()
    )


def _kill_same_exe(exe: Path) -> None:
    """Stop prior instances so RPG Maker / NW.js aren't stuck invisible."""
    if os.name != "nt":
        return
    name = exe.name
    try:
        subprocess.run(
            ["taskkill", "/F", "/IM", name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:  # noqa: BLE001
        pass


def _resolve_launch_exe(game: dict[str, Any]) -> Optional[Path]:
    """Resolve File playAction exe path without launching."""
    install = _resolve_install_dir(game)
    for action in game.get("playActions") or []:
        if action.get("isPlay") is False:
            continue
        atype = action.get("type") or "File"
        if str(atype) not in ("File", "0", "file"):
            continue
        path = _expand_playnite_vars(action.get("path"), game, install)
        if not path:
            continue
        exe = Path(path)
        if not exe.is_absolute():
            exe = Path(install) / path if install else exe
        try:
            present = exe.is_file()
        except OSError:
            present = False
        if not present:
            found = None
            for candidate in candidate_paths(str(exe)):
                remapped = Path(candidate)
                try:
                    if remapped.is_file():
                        found = remapped
                        break
                except OSError:
                    continue
            if not found:
                continue
            exe = found
        return exe
    return None


def _ensure_last_exe_from_active() -> None:
    """Keep tracked exe aligned with activeGameId (survives server restart)."""
    gid = (input_bridge.effective_mapping() or {}).get("gameId")
    if not gid:
        return
    try:
        data = load_games()
        game = next((g for g in data.get("games", []) if g.get("id") == gid), None)
        if not game:
            return
        direct = _resolve_launch_exe(game)
        if not direct:
            return
        current = stream_focus.status().get("last_exe")
        if current:
            try:
                if Path(current).name.lower() == direct.name.lower():
                    return
            except OSError:
                pass
        stream_focus.set_last_launch(direct)
    except Exception:  # noqa: BLE001
        pass


def _launch_direct(game: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Launch via Playnite File playAction (does not need a live Playnite instance)."""
    install = _resolve_install_dir(game)
    for action in game.get("playActions") or []:
        if action.get("isPlay") is False:
            continue
        atype = action.get("type") or "File"
        if str(atype) not in ("File", "0", "file"):
            continue
        path = _expand_playnite_vars(action.get("path"), game, install)
        if not path:
            continue
        # Relative paths are relative to InstallDir
        exe = Path(path)
        if not exe.is_absolute():
            exe = Path(install) / path if install else exe
        try:
            present = exe.is_file()
        except OSError:
            present = False
        if not present:
            found = None
            for candidate in candidate_paths(str(exe)):
                remapped = Path(candidate)
                try:
                    if remapped.is_file():
                        found = remapped
                        break
                except OSError:
                    continue
            if not found:
                continue
            exe = found
        work_raw = _expand_playnite_vars(action.get("workingDir"), game, install)
        cwd = work_raw if work_raw and Path(work_raw).is_dir() else str(exe.parent)
        import shlex

        cmd: list[str] = [str(exe)]
        args = action.get("arguments")
        if args:
            try:
                cmd.extend(shlex.split(str(args), posix=False))
            except ValueError:
                cmd.append(str(args))

        extra_args: list[str] = []
        # Do not inject Unity -screen-* args: many titles then start with no visible
        # window (esp. Illusion / older Unity). Stream cover is handled separately.
        force_win = (os.environ.get("GAME_REMOTE_UNITY_WINDOW") or "").strip() in (
            "1",
            "true",
            "yes",
        )
        if force_win and _looks_like_unity(exe):
            sw, sh = _primary_screen_size()
            extra_args = [
                "-screen-width",
                str(sw),
                "-screen-height",
                str(sh),
                "-screen-fullscreen",
                "0",
            ]

        if extra_args:
            cmd.extend(extra_args)

        # RPG Maker / NW.js often leave invisible zombie instances
        if _looks_like_nwjs(exe) or _looks_like_unity(exe):
            _kill_same_exe(exe)
            time.sleep(0.35)

        if os.name == "nt":
            how = _launch_windows_gui(exe, cwd, cmd)
        else:
            subprocess.Popen(
                cmd,
                cwd=cwd,
                shell=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            how = "posix"

        return {
            "method": "direct",
            "launcher": how,
            "path": str(exe),
            "cwd": cwd,
            "arguments": args,
            "extra_args": extra_args,
            "installDirectory": install,
            "server_session": _current_windows_session_id(),
            "screen": list(_primary_screen_size()),
        }
    return None


def launch_game(game: dict[str, Any]) -> dict[str, Any]:
    """Start game. Prefer direct exe launch; Playnite IPC is unreliable with multi-instance."""
    game_id = str(game.get("id") or "")
    methods: list[str] = []

    direct = _launch_direct(game)
    if direct:
        methods.append("direct")
        return {"methods": methods, **direct}

    # Fallback: URI only (do NOT spawn Playnite.DesktopApp --start — it opens a new
    # process that immediately exits with "another instance already running").
    uri = f"playnite://playnite/start/{game_id}"
    try:
        os.startfile(uri)  # type: ignore[attr-defined]
        methods.append("uri")
    except Exception as e:  # noqa: BLE001
        methods.append(f"uri-fail:{e}")

    return {"uri": uri, "methods": methods, "method": methods[-1] if methods else "none"}


class LaunchRequest(BaseModel):
    id: str
    token: Optional[str] = None
    open_stream: bool = True


class LaunchResponse(BaseModel):
    ok: bool
    message: str
    stream_url: str
    playnite: dict[str, Any]
    stream_delay_ms: int = STREAM_OPEN_DELAY_MS


class MappingsUpdate(BaseModel):
    # scope: "default" | "game"
    scope: str = "default"
    mapping: dict[str, Any] = Field(default_factory=dict)
    game_id: Optional[str] = None
    game_name: Optional[str] = None


class InjectRequest(BaseModel):
    action: str
    pressed: bool = True
    game_id: Optional[str] = None


class ActiveGameRequest(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None


class StreamModeRequest(BaseModel):
    mode: str  # desktop | game
    token: Optional[str] = None


class QuitGameRequest(BaseModel):
    token: Optional[str] = None
    force: bool = True
    game_id: Optional[str] = None


class DisplayResRequest(BaseModel):
    width: int = Field(..., ge=640, le=7680)
    height: int = Field(..., ge=480, le=4320)
    token: Optional[str] = None
    save_backup: bool = True


class DisplayRestoreRequest(BaseModel):
    token: Optional[str] = None


@app.get("/api/now-playing")
def now_playing():
    """Currently tracked game (set on launch, cleared on quit)."""
    _ensure_last_exe_from_active()
    eff = input_bridge.effective_mapping()
    gid = eff.get("gameId")
    name = eff.get("gameName")
    if not gid:
        return {
            "playing": False,
            "game_id": None,
            "name": None,
            "alive": False,
        }

    alive = False
    try:
        alive = bool(stream_focus.is_game_running())
    except Exception:  # noqa: BLE001
        alive = False

    return {
        "playing": True,
        "game_id": gid,
        "name": name,
        "alive": alive,
    }


@app.get("/api/health")
def health(request: Request):
    # Keep this cheap: watchdog polls every minute. Avoid EnumWindows / process scans.
    eff = input_bridge.effective_mapping()
    moonlight_up = _moonlight_up_fast()
    return {
        "status": "ok",
        "library": str(PLAYNITE_LIBRARY),
        "readonly": True,
        "moonlight_web": stream_url_for_request(request),
        "moonlight_web_port": MOONLIGHT_WEB_PORT,
        "moonlight_up": moonlight_up,
        "access_host": request.headers.get("host"),
        "input_bridge": input_bridge.KeyController is not None,
        "stream_delay_ms": STREAM_OPEN_DELAY_MS,
        "active_game_id": eff.get("gameId"),
        "active_game_name": eff.get("gameName"),
        "mapping_override": eff.get("isOverride"),
        "server_session": _current_windows_session_id(),
        "stream_mode": {
            "mode": stream_focus.get_mode(),
            "last_exe": stream_focus.status().get("last_exe"),
            "capability": "game-cover",
        },
        "now_playing": {
            "playing": bool(eff.get("gameId")),
            "game_id": eff.get("gameId"),
            "name": eff.get("gameName"),
            # Deliberately omit live process scan here (see /api/now-playing).
            "alive": None,
        },
        "library_source": _library_source,
        "library_cache": _cache_games_ok(),
        "code_rev": CODE_REV,
        "host_features": IS_WINDOWS_HOST,
        "extensions": extensions.status(),
    }


@app.get("/api/stream-mode")
def get_stream_mode(token: Optional[str] = None):
    _check_token(token)
    return stream_focus.status()


@app.post("/api/stream-mode")
def set_stream_mode(body: StreamModeRequest):
    _check_token(body.token)
    try:
        return stream_focus.apply_mode(body.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/quit-game")
def quit_game(body: QuitGameRequest):
    _check_token(body.token)
    # If we lost last_exe (server restart), resolve from game_id / active mapping.
    if not stream_focus.status().get("last_exe"):
        gid = body.game_id or (input_bridge.effective_mapping() or {}).get("gameId")
        if gid:
            data = load_games()
            game = next((g for g in data.get("games", []) if g.get("id") == gid), None)
            if game:
                direct = _resolve_launch_exe(game)
                if direct:
                    stream_focus.set_last_launch(direct)
    result = stream_focus.quit_game(force=body.force)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error") or "no active game")
    input_bridge.set_active_game(None, None)
    return result


@app.get("/api/display")
def get_display(token: Optional[str] = None):
    _check_token(token)
    return display_res.status()


@app.post("/api/display")
def set_display(body: DisplayResRequest):
    _check_token(body.token)
    result = display_res.set_resolution(
        body.width,
        body.height,
        save_backup=body.save_backup,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "display change failed")
    return result


@app.post("/api/display/restore")
def restore_display(body: DisplayRestoreRequest):
    _check_token(body.token)
    result = display_res.restore()
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "display restore failed")
    return result


@app.get("/api/games")
def list_games(
    q: str = Query("", max_length=200),
    installed: Optional[bool] = None,
    refresh: bool = False,
    token: Optional[str] = None,
):
    _check_token(token)
    try:
        data = load_games(query=q, force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    games = data.get("games") or []
    if installed is not None:
        games = [g for g in games if bool(g.get("isInstalled")) == installed]
    games = [g for g in games if not g.get("hidden")]
    slim: list[dict[str, Any]] = []
    for game in games:
        item = dict(game)
        desc = str(item.get("description") or "")
        if len(desc) > 400:
            item["description"] = desc[:400]
            item["descriptionTruncated"] = True
        item.pop("notes", None)
        slim.append(item)

    return {
        "count": len(slim),
        "games": slim,
        "lookups": data.get("lookups") or {},
        "source": str(PLAYNITE_LIBRARY),
        "readonly": True,
        "library_source": _library_source,
    }


@app.get("/api/games/{game_id}")
def get_game(game_id: str, token: Optional[str] = None):
    _check_token(token)
    data = load_games()
    game = next((g for g in data.get("games", []) if g.get("id") == game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="game not found")
    return game


@app.get("/api/cover")
def cover(path: str = Query(..., max_length=400)):
    rel = path.replace("/", "\\").lstrip("\\")
    if ".." in rel.split("\\"):
        raise HTTPException(status_code=400, detail="invalid path")
    full = (FILES_DIR / rel).resolve()
    try:
        full.relative_to(FILES_DIR.resolve())
    except ValueError as e:
        raise HTTPException(status_code=400, detail="path escape") from e
    try:
        if not full.is_file():
            raise HTTPException(status_code=404, detail="not found")
    except OSError as e:
        raise HTTPException(status_code=503, detail=f"cover unreadable: {e}") from e
    return FileResponse(full)


@app.post("/api/launch", response_model=LaunchResponse)
def launch(req: LaunchRequest, request: Request):
    _check_token(req.token)
    data = load_games()
    game = next((g for g in data.get("games", []) if g.get("id") == req.id), None)
    if not game:
        raise HTTPException(status_code=404, detail="game not found")

    result = launch_game(game)
    if not result.get("methods") or (
        result.get("method") not in ("direct", "uri")
        and "direct" not in result.get("methods", [])
        and "uri" not in result.get("methods", [])
    ):
        raise HTTPException(
            status_code=500,
            detail=f"could not launch game: {result}",
        )
    input_bridge.set_active_game(req.id, game.get("name"))
    exe_path = result.get("path")
    if exe_path:
        stream_focus.set_last_launch_for_game(exe_path, req.id)
        # Re-apply game cover after the window appears (client may also call).
        if stream_focus.get_mode() == "game":

            def _late_cover() -> None:
                try:
                    stream_focus.apply_mode("game")
                except Exception:  # noqa: BLE001
                    pass

            threading.Timer(1.2, _late_cover).start()
            threading.Timer(3.0, _late_cover).start()
    return LaunchResponse(
        ok=True,
        message=f"{game.get('name')} を起動しました",
        stream_url=stream_url_for_request(request),
        playnite=result,
        stream_delay_ms=STREAM_OPEN_DELAY_MS,
    )


@app.post("/api/launch-playnite")
def launch_playnite(request: Request, token: Optional[str] = None):
    _check_token(token)
    if not PLAYNITE_EXE.exists():
        raise HTTPException(status_code=500, detail="Playnite not found")
    subprocess.Popen(
        [str(PLAYNITE_EXE), "--startfullscreen", "--nolibupdate"],
        cwd=str(PLAYNITE_EXE.parent),
        shell=False,
    )
    return {"ok": True, "stream_url": stream_url_for_request(request)}


@app.get("/api/input/mappings")
def get_mappings(game_id: Optional[str] = None):
    return input_bridge.get_mappings_view(game_id)


@app.put("/api/input/mappings")
def put_mappings(body: MappingsUpdate):
    scope = (body.scope or "default").lower()
    if scope == "game":
        if not body.game_id:
            raise HTTPException(status_code=400, detail="game_id required for game scope")
        return input_bridge.update_game_override(
            body.game_id,
            body.mapping,
            name=body.game_name,
            replace=True,
        )
    return input_bridge.update_default_mapping(body.mapping)


@app.delete("/api/input/mappings/game/{game_id}")
def delete_game_mapping(game_id: str):
    return input_bridge.clear_game_override(game_id)


@app.post("/api/input/active-game")
def set_active_game(body: ActiveGameRequest):
    return input_bridge.set_active_game(body.id, body.name)


@app.post("/api/input/inject")
def inject(body: InjectRequest):
    return input_bridge.inject(body.action, body.pressed, body.game_id)


@app.post("/api/input/release-all")
def release_all():
    input_bridge.release_all()
    return {"ok": True}


@app.get("/api/input/pad-state")
def pad_state():
    """Host XInput snapshot — used by library UI when browser Gamepad API is empty."""
    return host_pad.read_pad_state()


@app.websocket("/ws/input")
async def ws_input(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"ok": False, "error": "bad json"})
                continue
            op = msg.get("op") or "inject"
            if op == "inject":
                result = input_bridge.inject(
                    str(msg.get("action") or ""),
                    bool(msg.get("pressed")),
                    msg.get("game_id"),
                )
                await ws.send_json(result)
            elif op == "set_game":
                data = input_bridge.set_active_game(msg.get("id"), msg.get("name"))
                await ws.send_json({"ok": True, "data": data})
            elif op == "release_all":
                input_bridge.release_all()
                await ws.send_json({"ok": True})
            elif op == "ping":
                await ws.send_json({"ok": True, "pong": True})
            else:
                await ws.send_json({"ok": False, "error": "unknown op"})
    except WebSocketDisconnect:
        input_bridge.release_all()


web_dir = ROOT / "web"
ASSET_VER = CODE_REV


def _html_with_asset_ver(path: Path) -> HTMLResponse:
    html = path.read_text(encoding="utf-8")
    html = html.replace("/static/", f"/static/")
    # Cache-bust local assets so ratio / play CSS updates land without hard-refresh guesswork
    for name in ("styles.css", "play.css", "app.js", "play.js", "controls.js", "pad-layout.js"):
        html = html.replace(f"/static/{name}", f"/static/{name}?v={ASSET_VER}")
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-store"},
    )


if web_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(web_dir)), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    index_path = web_dir / "index.html"
    if index_path.is_file():
        return _html_with_asset_ver(index_path)
    return HTMLResponse("<h1>Game Remote</h1>")


@app.get("/play", response_class=HTMLResponse)
def play():
    """Stream shell: Moonlight in iframe + on-screen pad overlay."""
    play_path = web_dir / "play.html"
    if play_path.is_file():
        return _html_with_asset_ver(play_path)
    return HTMLResponse("<h1>play.html missing</h1>", status_code=404)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host=HOST_BIND, port=PORT, reload=False)
