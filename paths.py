"""Playnite install-path remaps.

Playnite stores absolute install paths. When the library has moved between
drives or shares (e.g. a mapped network drive vs. a local disk), launch and
existence checks must try every known alias before giving up.

Public-repo note: the original file hard-coded the author's own drive letters
and share names. Here the remap table is read from the
``GAME_REMOTE_PATH_REMAPS`` environment variable (JSON list of
``[old_prefix, new_prefix]`` pairs) so no personal paths are committed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _load_remaps() -> list[tuple[str, str]]:
    raw = os.environ.get("GAME_REMOTE_PATH_REMAPS", "")
    if not raw:
        return []
    try:
        pairs = [(str(a), str(b)) for a, b in json.loads(raw)]
    except (ValueError, TypeError):
        return []
    # Longest prefix first.
    return sorted(pairs, key=lambda p: len(p[0]), reverse=True)


PREFIX_REMAPS: list[tuple[str, str]] = _load_remaps()


def remap_path(path: str, remaps: list[tuple[str, str]] | None = None) -> str:
    if not path:
        return path
    for old, new in (PREFIX_REMAPS if remaps is None else remaps):
        if path.lower().startswith(old.lower()):
            return new + path[len(old) :]
    return path


def candidate_paths(path: str, remaps: list[tuple[str, str]] | None = None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def add(item: str) -> None:
        if item and item not in seen:
            seen.add(item)
            out.append(item)

    add(path)
    add(remap_path(path, remaps))
    add(remap_path(path.replace("/", "\\"), remaps))
    return out


def resolve_existing_dir(path: str) -> str:
    ordered = candidate_paths(path)
    for candidate in ordered:
        try:
            if Path(candidate).is_dir():
                return candidate
        except OSError:
            continue
    return ordered[0] if ordered else ""
