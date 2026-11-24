"""A small in-memory journal of problems for the "Report a problem" button.

Only error codes, short messages and stack traces of Malenia's own code are
kept — never message texts, keys or file contents.
"""
from __future__ import annotations

import platform
import re
import sys
import threading
import traceback
from collections import deque
from datetime import datetime

_EVENTS: deque = deque(maxlen=80)
_LOCK = threading.Lock()
SECRET = re.compile(r"(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}|github_pat_[A-Za-z0-9_]{10,}|ghp_[A-Za-z0-9]{10,}|Bearer\s+\S+|Basic\s+\S+)")


def scrub(text: str) -> str:
    return SECRET.sub("[скрыто]", text or "")


def record(kind: str, detail: str = "", error: BaseException | None = None) -> None:
    item = {"time": datetime.now().isoformat(timespec="seconds"), "kind": kind, "detail": scrub(str(detail))[:500]}
    if error is not None:
        item["trace"] = scrub("".join(traceback.format_exception(type(error), error, error.__traceback__))[-3000:])
    with _LOCK:
        _EVENTS.append(item)


def recent() -> list[dict]:
    with _LOCK:
        return list(_EVENTS)


def environment() -> dict:
    return {"os": platform.platform(), "python": sys.version.split()[0], "machine": platform.machine()}
