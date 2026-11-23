"""Small persistent key/value settings and secret storage for the assistant."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from .store import TaskStore, _now


class SettingsStore:
    """JSON values in SQLite. Never use this for API keys or tokens."""

    def __init__(self, store: TaskStore):
        self.store = store
        with store._session() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)""")

    def get(self, key: str, default: Any = None) -> Any:
        with self.store._session() as db:
            row = db.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except ValueError:
            return default

    def set(self, key: str, value: Any) -> None:
        with self.store._session() as db:
            db.execute("""INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
                       (key, json.dumps(value, ensure_ascii=False), _now()))


class FileSecretStore:
    """Fallback for Linux/macOS servers: a user-only file next to the database.

    Windows always uses Credential Manager (see secret_store.py).
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _read(self) -> dict[str, str]:
        try:
            value = json.loads(self.path.read_text("utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(temporary, self.path)

    def get(self, name: str) -> str | None:
        with self._lock:
            value = self._read().get(name)
        return value if isinstance(value, str) else None

    def set(self, name: str, secret: str) -> None:
        if not isinstance(secret, str) or not secret or len(secret) > 2048:
            raise ValueError("invalid_secret")
        with self._lock:
            data = self._read()
            data[name] = secret
            self._write(data)

    def delete(self, name: str) -> bool:
        with self._lock:
            data = self._read()
            existed = data.pop(name, None) is not None
            self._write(data)
        return existed


class MemorySecretStore:
    """In-memory secrets for tests."""

    def __init__(self):
        self.values: dict[str, str] = {}

    def get(self, name):
        return self.values.get(name)

    def set(self, name, secret):
        self.values[name] = secret

    def delete(self, name):
        return self.values.pop(name, None) is not None


def default_secret_store():
    if os.name == "nt":
        from .secret_store import WindowsCredentialStore
        return WindowsCredentialStore()
    from .config import data_directory
    return FileSecretStore(data_directory() / "secrets.json")
