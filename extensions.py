"""Minimal extension (plugin) interface for Game Remote.

An extension is a Python module that defines ``register(api: ExtensionAPI)``.
Load extensions by module name with the ``GAME_REMOTE_EXTENSIONS`` environment
variable (comma-separated), or by installing a package that declares an entry
point in the ``game_remote.extensions`` group.

What an extension can do (deliberately small):

* ``api.add_game_enricher(fn)``: ``fn(game: dict) -> dict | None``. Called for
  every game after the library is read. A returned dict is stored under
  ``game["ext"][<extension name>]``. Enrichers must be fast and offline; do
  network work in a route instead.
* ``api.add_router(router)``: mount a FastAPI ``APIRouter``. It is served under
  ``/api/ext/<extension name>``.
* ``api.config(key, default)``: read ``GAME_REMOTE_EXT_<NAME>_<KEY>`` from the
  environment, so secrets never live in code or in the repository.

Extensions never get write access to the Playnite database; they only see the
read-only game dicts the core already produced.
"""
from __future__ import annotations

import importlib
import logging
import os
import re
from dataclasses import dataclass, field
from importlib import metadata
from typing import Any, Callable, Optional

from fastapi import APIRouter, FastAPI

log = logging.getLogger("game_remote.extensions")

GameEnricher = Callable[[dict[str, Any]], Optional[dict[str, Any]]]
ENTRY_POINT_GROUP = "game_remote.extensions"


@dataclass
class ExtensionAPI:
    name: str
    _enrichers: list[GameEnricher] = field(default_factory=list)
    _routers: list[APIRouter] = field(default_factory=list)

    def add_game_enricher(self, fn: GameEnricher) -> None:
        self._enrichers.append(fn)

    def add_router(self, router: APIRouter) -> None:
        self._routers.append(router)

    def config(self, key: str, default: Optional[str] = None) -> Optional[str]:
        env = f"GAME_REMOTE_EXT_{_env_name(self.name)}_{_env_name(key)}"
        return os.environ.get(env, default)


def _env_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", s).upper().strip("_")


class ExtensionRegistry:
    def __init__(self) -> None:
        self.loaded: dict[str, ExtensionAPI] = {}
        self.errors: dict[str, str] = {}

    def _register(self, name: str, module: Any) -> None:
        register = getattr(module, "register", None)
        if not callable(register):
            self.errors[name] = "module has no register(api)"
            return
        ext_name = str(getattr(module, "EXTENSION_NAME", name.rsplit(".", 1)[-1]))
        api = ExtensionAPI(name=ext_name)
        try:
            register(api)
        except Exception as err:  # noqa: BLE001 - one bad extension must not stop the server
            self.errors[name] = f"register failed: {err}"
            log.exception("extension %s failed to register", name)
            return
        self.loaded[ext_name] = api

    def load_from_env(self) -> None:
        names = [n.strip() for n in os.environ.get("GAME_REMOTE_EXTENSIONS", "").split(",") if n.strip()]
        for name in names:
            try:
                self._register(name, importlib.import_module(name))
            except Exception as err:  # noqa: BLE001
                self.errors[name] = f"import failed: {err}"
        try:
            eps = metadata.entry_points(group=ENTRY_POINT_GROUP)
        except TypeError:  # Python < 3.10
            eps = metadata.entry_points().get(ENTRY_POINT_GROUP, [])  # type: ignore[attr-defined]
        for ep in eps:
            if ep.name in self.loaded or ep.value in names:
                continue
            try:
                self._register(ep.value, ep.load())
            except Exception as err:  # noqa: BLE001
                self.errors[ep.value] = f"entry point failed: {err}"

    def mount(self, app: FastAPI) -> None:
        for ext_name, api in self.loaded.items():
            for router in api._routers:
                app.include_router(router, prefix=f"/api/ext/{ext_name}", tags=[f"ext:{ext_name}"])

    def enrich(self, games: list[dict[str, Any]]) -> None:
        for ext_name, api in self.loaded.items():
            for fn in api._enrichers:
                for game in games:
                    try:
                        extra = fn(game)
                    except Exception:  # noqa: BLE001
                        continue
                    if extra:
                        game.setdefault("ext", {})[ext_name] = extra

    def status(self) -> dict[str, Any]:
        return {"loaded": sorted(self.loaded), "errors": dict(self.errors)}


registry = ExtensionRegistry()
