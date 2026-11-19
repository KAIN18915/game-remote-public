"""Stand-ins for Windows-only host modules when the server runs elsewhere.

``stream_focus`` and ``display_res`` call Win32 (user32) at import time, so they
cannot load inside a Linux container. In that mode the library / catalog API
still works, and every host-only call reports itself as unavailable instead of
crashing the server.
"""
from __future__ import annotations

from typing import Any

UNAVAILABLE = {
    "ok": False,
    "available": False,
    "error": "host-only feature: run server.py natively on the Windows game host",
}


class _Unavailable:
    def __init__(self, name: str) -> None:
        self._name = name

    def get_mode(self) -> str:
        return "unavailable"

    def is_game_running(self) -> bool:
        return False

    def __getattr__(self, attr: str):
        def _call(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
            return dict(UNAVAILABLE, module=self._name, call=attr)

        return _call


def load(name: str):
    try:
        return __import__(name)
    except Exception:  # noqa: BLE001 - AttributeError: ctypes.windll on non-Windows
        return _Unavailable(name)
