"""Commands from Malenia to her browser: open, read, type, click.

The agent puts a command into SQLite; the browser extension (which may talk to
a separate native-host process) claims it, performs it in Malenia's own work
tab and stores the result. Only pages on sites the user has granted to the
extension can be used — the extension enforces that.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any

ACTIONS = {"open", "read", "type", "click", "back"}
MAX_RESULT = 400_000
COMMAND_TTL = 90


def ensure_schema(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS browser_commands (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, created_unix REAL NOT NULL, claimed_unix REAL)""")


class BrowserCommands:
    def __init__(self, store):
        self.store = store
        with store._session() as db:
            ensure_schema(db)
        self.last_seen = 0.0

    # ---- agent side ---------------------------------------------------
    def run(self, action: str, args: dict, timeout: float = 45.0) -> dict:
        if action not in ACTIONS:
            raise ValueError("unknown_action")
        command_id = str(uuid.uuid4())
        now = time.time()
        with self.store._session() as db:
            db.execute("DELETE FROM browser_commands WHERE created_unix < ?", (now - 600,))
            db.execute("INSERT INTO browser_commands VALUES (?,?,?,?,?,?,?)",
                       (command_id, action, json.dumps(args, ensure_ascii=False), "pending", None, now, None))
        deadline = now + timeout
        while time.time() < deadline:
            time.sleep(0.15)
            with self.store._session() as db:
                row = db.execute("SELECT status, result, claimed_unix FROM browser_commands WHERE id = ?",
                                 (command_id,)).fetchone()
            if row is None:
                break
            if row["status"] in ("done", "failed"):
                with self.store._session() as db:
                    db.execute("DELETE FROM browser_commands WHERE id = ?", (command_id,))
                result = json.loads(row["result"] or "{}")
                return result if isinstance(result, dict) else {"error": "bad_result"}
            if row["status"] == "pending" and time.time() - now > 8:
                # Nobody picked it up: the extension is not connected.
                with self.store._session() as db:
                    db.execute("DELETE FROM browser_commands WHERE id = ? AND status = 'pending'", (command_id,))
                return {"error": "extension_not_connected"}
        with self.store._session() as db:
            db.execute("DELETE FROM browser_commands WHERE id = ?", (command_id,))
        return {"error": "browser_timeout"}

    def connected(self) -> bool:
        with self.store._session() as db:
            row = db.execute("SELECT value FROM browser_command_seen WHERE id = 1").fetchone() \
                if _has_table(db, "browser_command_seen") else None
        return bool(row and time.time() - row["value"] < 60)


def _has_table(db, name: str) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


# ---- extension side (used by native host and HTTP bridge) ------------------
def claim(store, wait: float = 0.0) -> dict | None:
    """Give the extension the next command, waiting up to `wait` seconds (long polling)."""
    deadline = time.time() + max(0.0, min(wait, 25.0))
    with store._session() as db:
        ensure_schema(db)
        db.execute("CREATE TABLE IF NOT EXISTS browser_command_seen (id INTEGER PRIMARY KEY, value REAL NOT NULL)")
        db.execute("INSERT OR REPLACE INTO browser_command_seen VALUES (1, ?)", (time.time(),))
        db.execute("DELETE FROM browser_commands WHERE status = 'pending' AND created_unix < ?",
                   (time.time() - COMMAND_TTL,))
    while True:
        with store._session() as db:
            row = db.execute("""SELECT id, action, args FROM browser_commands WHERE status = 'pending'
                                ORDER BY created_unix LIMIT 1""").fetchone()
            if row is not None and db.execute(
                    "UPDATE browser_commands SET status = 'claimed', claimed_unix = ? WHERE id = ? AND status = 'pending'",
                    (time.time(), row["id"])).rowcount:
                return {"id": row["id"], "action": row["action"], "args": json.loads(row["args"])}
        if time.time() >= deadline:
            return None
        time.sleep(0.25)


def finish(store, command_id: Any, result: Any) -> bool:
    if not isinstance(command_id, str) or len(command_id) != 36 or not isinstance(result, dict):
        return False
    raw = json.dumps(result, ensure_ascii=False)
    if len(raw) > MAX_RESULT:
        raw = json.dumps({"error": "page_too_large"})
    status = "failed" if result.get("error") else "done"
    with store._session() as db:
        ensure_schema(db)
        return db.execute("UPDATE browser_commands SET status = ?, result = ? WHERE id = ? AND status = 'claimed'",
                          (status, raw, command_id)).rowcount > 0
