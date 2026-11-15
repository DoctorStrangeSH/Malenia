"""SQLite persistence for tasks and an append-only activity log."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SubmissionConflict(ValueError):
    pass


class TaskStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def _session(self) -> Iterator[sqlite3.Connection]:
        """Commit/rollback a database operation and always release its file handle.

        sqlite3.Connection's context manager does not close the connection. Explicit
        closure is essential on Windows, where an open handle prevents temporary
        database directories from being removed and can block app shutdown.
        """
        db = self._connect()
        try:
            with db:
                yield db
        finally:
            db.close()

    def _initialize(self) -> None:
        with self._session() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK(status IN ('pending', 'cancelled')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS task_submissions (
                    request_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id)
                );

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT,
                    event_type TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(id)
                );

                CREATE TABLE IF NOT EXISTS browser_audit_job (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    job_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','expired')),
                    created_at TEXT NOT NULL,
                    created_unix REAL NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS browser_audit_progress (
                    id INTEGER PRIMARY KEY CHECK (id=1),
                    job_id TEXT NOT NULL,
                    current_role TEXT,
                    completed_sources INTEGER NOT NULL DEFAULT 0,
                    attention_sources INTEGER NOT NULL DEFAULT 0,
                    failed_role TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS browser_audit_seed (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    job_id TEXT NOT NULL,
                    cargo_place TEXT NOT NULL,
                    inventory_date TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS browser_audit_seed_items (
                    job_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    cargo_place TEXT NOT NULL,
                    inventory_date TEXT NOT NULL,
                    PRIMARY KEY(job_id, position),
                    UNIQUE(job_id, cargo_place)
                );

                CREATE TABLE IF NOT EXISTS inventa_writeback (
                    job_id TEXT PRIMARY KEY,
                    context_json TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending',
                    written INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS inventa_batch_cursor (
                    source_hash TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    next_offset INTEGER NOT NULL,
                    total INTEGER NOT NULL,
                    pending_end INTEGER,
                    pending_job_id TEXT
                );

                CREATE TABLE IF NOT EXISTS browser_audit_summary (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    checked_at TEXT NOT NULL,
                    total INTEGER NOT NULL,
                    found INTEGER NOT NULL,
                    in_progress INTEGER NOT NULL,
                    manual_review INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS browser_tabs (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    shared_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS action_permissions (
                    id TEXT PRIMARY KEY,
                    binding TEXT NOT NULL,
                    capability TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN
                        ('pending', 'approved', 'denied', 'revoked', 'consumed', 'expired')),
                    expires_at REAL NOT NULL,
                    expires_monotonic REAL NOT NULL,
                    created_wall REAL NOT NULL,
                    created_monotonic REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_permissions_status_created
                    ON action_permissions(status, created_wall DESC);

                CREATE INDEX IF NOT EXISTS idx_browser_tabs_shared
                    ON browser_tabs(shared_at DESC);

                CREATE INDEX IF NOT EXISTS idx_tasks_created
                    ON tasks(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_events_created
                    ON events(created_at DESC);
                """
            )
            try:
                db.execute("ALTER TABLE browser_audit_job ADD COLUMN failure_reason TEXT")
            except sqlite3.OperationalError as error:
                if "duplicate column name" not in str(error):
                    raise
            for column, definition in (("asgard_state", "TEXT NOT NULL DEFAULT 'pending'"), ("asgard_written", "INTEGER NOT NULL DEFAULT 0")):
                if column not in {row[1] for row in db.execute("PRAGMA table_info(inventa_writeback)")}:
                    db.execute(f"ALTER TABLE inventa_writeback ADD COLUMN {column} {definition}")

    def cancel_browser_audit(self, reason: str = "cancelled", *, job_id: str | None = None) -> bool:
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("UPDATE browser_audit_job SET status='failed',failure_reason=?,updated_at=? "
                "WHERE id=1 AND status IN ('pending','running') AND (? IS NULL OR job_id=?)", (reason, _now(), job_id, job_id)).rowcount
            if changed:
                db.execute("UPDATE inventa_batch_cursor SET pending_job_id=NULL,pending_end=NULL")
                db.execute("DELETE FROM browser_audit_seed")
                db.execute("DELETE FROM browser_audit_seed_items")
                db.execute("DELETE FROM inventa_writeback")
            return bool(changed)

    def create_task(self, title: str, description: str = "", request_id: str | None = None) -> dict[str, Any]:
        task_id = str(uuid.uuid4())
        now = _now()
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            if request_id is not None:
                uuid.UUID(request_id)
                existing = db.execute("SELECT tasks.* FROM task_submissions "
                    "JOIN tasks ON tasks.id = task_submissions.task_id WHERE request_id = ?",
                    (request_id,)).fetchone()
                if existing is not None:
                    if existing["title"] != title or existing["description"] != description:
                        raise SubmissionConflict("Request already submitted with different content")
                    return dict(existing)
            db.execute(
                """INSERT INTO tasks
                   (id, title, description, status, created_at, updated_at)
                   VALUES (?, ?, ?, 'pending', ?, ?)""",
                (task_id, title, description, now, now),
            )
            if request_id is not None:
                db.execute("INSERT INTO task_submissions VALUES (?, ?)", (request_id, task_id))
            db.execute(
                """INSERT INTO events
                   (task_id, event_type, message, created_at)
                   VALUES (?, 'task.created', 'Task added to the local queue', ?)""",
                (task_id, now),
            )
        return self.get_task(task_id)

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._session() as db:
            row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return dict(row) if row else None

    def list_tasks(self, limit: int = 50) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        with self._session() as db:
            rows = db.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?",
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def cancel_task(self, task_id: str) -> dict[str, Any] | None:
        now = _now()
        with self._session() as db:
            row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                return None
            if row["status"] == "pending":
                db.execute(
                    "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?",
                    (now, task_id),
                )
                db.execute(
                    """INSERT INTO events
                       (task_id, event_type, message, created_at)
                       VALUES (?, 'task.cancelled', 'Pending task cancelled', ?)""",
                    (task_id, now),
                )
        return self.get_task(task_id)

    def list_events(self, limit: int = 50) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 200))
        with self._session() as db:
            rows = db.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (safe_limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def record_browser_tab(self, url: str, title: str) -> dict[str, Any]:
        """Persist a tab explicitly shared by the user through the browser extension."""
        tab_id = str(uuid.uuid4())
        now = _now()
        with self._session() as db:
            db.execute(
                "INSERT INTO browser_tabs (id, url, title, shared_at) VALUES (?, ?, ?, ?)",
                (tab_id, url, title, now),
            )
            db.execute(
                "DELETE FROM browser_tabs WHERE id NOT IN "
                "(SELECT id FROM browser_tabs ORDER BY shared_at DESC LIMIT 100)"
            )
            db.execute(
                """INSERT INTO events (task_id, event_type, message, created_at)
                   VALUES (NULL, 'browser.tab_shared',
                           'Пользователь поделился активной вкладкой', ?)""",
                (now,),
            )
        return {"id": tab_id, "url": url, "title": title, "shared_at": now}

    def delete_browser_tab(self, tab_id: str) -> bool:
        """Remove a user-shared tab record without closing the real browser tab."""
        if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 64:
            return False
        with self._session() as db:
            cursor = db.execute("DELETE FROM browser_tabs WHERE id = ?", (tab_id,))
            if cursor.rowcount:
                db.execute(
                    """INSERT INTO events (task_id, event_type, message, created_at)
                       VALUES (NULL, 'browser.tab_unshared',
                               'Пользователь удалил переданную вкладку из Malenia', ?)""",
                    (_now(),),
                )
                return True
        return False

    def list_browser_tabs(self, limit: int = 20) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        with self._session() as db:
            rows = db.execute(
                "SELECT * FROM browser_tabs ORDER BY shared_at DESC LIMIT ?",
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def record_browser_audit_summary(self, total: int, summary: dict[str, int]) -> dict[str, Any]:
        """Persist only bounded aggregate counts, never cargo IDs or site contents."""
        keys = {"found", "in_progress", "manual_review"}
        if (type(total) is not int or not 0 <= total <= 100
                or type(summary) is not dict or set(summary) != keys
                or any(type(summary[k]) is not int or not 0 <= summary[k] <= total for k in keys)
                or sum(summary.values()) != total):
            raise ValueError("invalid_audit_summary")
        checked_at = _now()
        with self._session() as db:
            db.execute(
                """INSERT INTO browser_audit_summary
                   (id, checked_at, total, found, in_progress, manual_review)
                   VALUES (1, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                   checked_at=excluded.checked_at, total=excluded.total,
                   found=excluded.found, in_progress=excluded.in_progress,
                   manual_review=excluded.manual_review""",
                (checked_at, total, summary["found"], summary["in_progress"],
                 summary["manual_review"]),
            )
        return {"checked_at": checked_at, "total": total,
                "summary": dict(summary), "read_only": True, "source": "browser_tables"}

    def latest_browser_audit_summary(self) -> dict[str, Any] | None:
        with self._session() as db:
            row = db.execute(
                "SELECT checked_at, total, found, in_progress, manual_review "
                "FROM browser_audit_summary WHERE id = 1"
            ).fetchone()
        if row is None:
            return None
        return {"checked_at": row["checked_at"], "total": row["total"],
                "summary": {"found": row["found"], "in_progress": row["in_progress"],
                            "manual_review": row["manual_review"]},
                "read_only": True, "source": "browser_tables"}

    def _expire_browser_audit(self, db: sqlite3.Connection) -> None:
        # Never leave a job indefinitely stuck after the extension crashes.
        now = time.time()
        db.execute(
            """UPDATE browser_audit_job SET status='expired', updated_at=?
               WHERE id=1 AND ((status='pending' AND created_unix < ?)
                  OR (status='running' AND created_unix < ?))""",
            (_now(), now - 120, now - 1800),
        )
        db.execute("DELETE FROM browser_audit_seed WHERE job_id NOT IN "
                   "(SELECT job_id FROM browser_audit_job WHERE status='pending')")
        db.execute("DELETE FROM browser_audit_seed_items WHERE job_id NOT IN "
                   "(SELECT job_id FROM browser_audit_job WHERE status='pending')")
        db.execute("DELETE FROM inventa_writeback WHERE job_id NOT IN "
                   "(SELECT job_id FROM browser_audit_job WHERE status IN ('pending','running'))")


    def browser_audit_active(self, job_id: str) -> bool:
        with self._session() as db:
            self._expire_browser_audit(db)
            return db.execute("SELECT 1 FROM browser_audit_job WHERE id=1 AND job_id=? AND status='running'", (job_id,)).fetchone() is not None

    def claim_inventa_writeback(self, job_id: str, *, asgard: bool = False) -> dict[str, Any]:
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire_browser_audit(db)
            state_col, count_col = ("asgard_state", "asgard_written") if asgard else ("state", "written")
            row = db.execute(f"SELECT w.context_json,w.{state_col} AS state,w.{count_col} AS written,w.state AS found_state FROM inventa_writeback w "
                "JOIN browser_audit_job j ON j.job_id=w.job_id WHERE w.job_id=? AND j.status='running'",
                (job_id,)).fetchone()
            if row is None or row["state"] == 'writing' or (asgard and row["found_state"] != 'applied'):
                raise ValueError("inventa_writeback_context_unavailable")
            if row["state"] == 'applied':
                return {"already_applied": True, "written": row["written"]}
            db.execute(f"UPDATE inventa_writeback SET {state_col}='writing' WHERE job_id=?", (job_id,))
            return {"context": json.loads(row["context_json"])}

    def complete_inventa_writeback(self, job_id: str, written: int | None, *, asgard: bool = False) -> bool:
        with self._session() as db:
            state_col, count_col = ("asgard_state", "asgard_written") if asgard else ("state", "written")
            return db.execute(f"UPDATE inventa_writeback SET {state_col}=?,{count_col}=? WHERE job_id=? AND {state_col}='writing' "
                "AND job_id IN (SELECT job_id FROM browser_audit_job WHERE status='running')",
                ('applied' if written is not None else 'pending', written or 0, job_id)).rowcount == 1

    def latest_browser_audit_job(self) -> dict[str, Any] | None:
        with self._session() as db:
            self._expire_browser_audit(db)
            row = db.execute(
                """SELECT j.job_id,j.status,j.created_at,j.updated_at,
                          p.current_role,p.completed_sources,p.attention_sources,p.failed_role,j.failure_reason
                   FROM browser_audit_job j LEFT JOIN browser_audit_progress p
                   ON p.id=1 AND p.job_id=j.job_id WHERE j.id=1"""
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["completed_sources"] = result["completed_sources"] or 0
        result["attention_sources"] = result["attention_sources"] or 0
        return result

    def inventa_batch_position(self, source_hash: str, fingerprint: str) -> int:
        """Keep only sheet hashes and a cursor, never source rows or cargo identifiers."""
        with self._session() as db:
            row = db.execute("SELECT fingerprint,next_offset FROM inventa_batch_cursor "
                             "WHERE source_hash=?", (source_hash,)).fetchone()
        if row and row["fingerprint"] == fingerprint:
            return row["next_offset"]
        return 0

    def reset_inventa_batch_cursor(self, source_hash: str) -> bool:
        """Explicit local reset, never alters Sheets, DataLens or Asgard."""
        if not isinstance(source_hash, str) or len(source_hash) != 64:
            raise ValueError("invalid_audit_cursor")
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire_browser_audit(db)
            active = db.execute("SELECT status FROM browser_audit_job WHERE id=1").fetchone()
            if active and active["status"] in {"pending", "running"}:
                raise SubmissionConflict("browser_audit_already_active")
            return bool(db.execute("DELETE FROM inventa_batch_cursor WHERE source_hash=?",
                                   (source_hash,)).rowcount)

    def request_browser_audit(self, first_order: dict[str, str] | None = None,
                              batch: list[dict[str, str]] | None = None,
                              batch_cursor: dict[str, Any] | None = None,
                              writeback_context: dict[str, Any] | None = None) -> dict[str, Any]:
        """Single bounded browser audit requested through the authenticated desktop API."""
        if first_order is not None and batch is not None:
            raise ValueError("invalid_audit_batch")
        if batch_cursor is not None:
            if (batch is None or not isinstance(batch_cursor, dict)
                    or set(batch_cursor) not in ({"source_hash", "fingerprint", "start", "total"}, {"source_hash", "fingerprint", "start", "total", "end"})
                    or any(not isinstance(batch_cursor[field], str) or
                           len(batch_cursor[field]) != 64 or
                           any(c not in "0123456789abcdef" for c in batch_cursor[field])
                           for field in ("source_hash", "fingerprint"))
                    or type(batch_cursor["start"]) is not int
                    or type(batch_cursor["total"]) is not int
                    or batch_cursor["start"] < 0
                    or batch_cursor["start"] + len(batch) > batch_cursor["total"]
                    or batch_cursor["total"] > 10000
                    or type(batch_cursor.get("end", batch_cursor["start"] + len(batch))) is not int
                    or not batch_cursor["start"] + len(batch) <= batch_cursor.get("end", batch_cursor["start"] + len(batch)) <= batch_cursor["total"]):
                raise ValueError("invalid_audit_cursor")
        if writeback_context is not None and (batch is None or not isinstance(writeback_context, dict)
                or len(json.dumps(writeback_context)) > 16000):
            raise ValueError("invalid_inventa_writeback_context")
        selected = batch if batch is not None else ([first_order] if first_order is not None else [])
        if batch is not None and not 1 <= len(batch) <= 20:
            raise ValueError("invalid_audit_batch")
        seen = set()
        for order in selected:
            import re
            from datetime import date
            cargo = order.get("cargo_place") if isinstance(order, dict) else None
            cutoff = order.get("inventory_date") if isinstance(order, dict) else None
            if (not isinstance(cargo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", cargo)
                    or cargo in seen or not isinstance(cutoff, str) or len(cutoff) != 10):
                raise ValueError("invalid_audit_batch")
            seen.add(cargo)
            try:
                if date.fromisoformat(cutoff).isoformat() != cutoff:
                    raise ValueError("invalid_audit_batch")
            except ValueError as exc:
                raise ValueError("invalid_audit_batch") from exc
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire_browser_audit(db)
            active = db.execute(
                "SELECT status FROM browser_audit_job WHERE id=1"
            ).fetchone()
            if active and active["status"] in {"pending", "running"}:
                raise SubmissionConflict("browser_audit_already_active")
            if batch_cursor is not None:
                current = db.execute(
                    "SELECT fingerprint,next_offset FROM inventa_batch_cursor WHERE source_hash=?",
                    (batch_cursor["source_hash"],)).fetchone()
                expected = (current["next_offset"] if current and
                            current["fingerprint"] == batch_cursor["fingerprint"] else 0)
                if batch_cursor["start"] != expected:
                    raise SubmissionConflict("inventa_batch_cursor_changed")
            now = _now()
            job_id = str(uuid.uuid4())
            db.execute("DELETE FROM browser_audit_seed WHERE id=1")
            db.execute("DELETE FROM browser_audit_seed_items")
            db.execute("DELETE FROM inventa_writeback")
            if writeback_context is not None:
                db.execute("INSERT INTO inventa_writeback(job_id,context_json) VALUES (?,?)",
                           (job_id, json.dumps(writeback_context, ensure_ascii=False)))
            db.execute(
                """INSERT INTO browser_audit_job
                   (id,job_id,status,created_at,created_unix,updated_at)
                   VALUES (1,?,'pending',?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                   job_id=excluded.job_id,status=excluded.status,
                   created_at=excluded.created_at,created_unix=excluded.created_unix,
                   updated_at=excluded.updated_at,failure_reason=NULL""",
                (job_id, now, time.time(), now),
            )
            db.execute(
                """INSERT INTO browser_audit_progress
                   (id,job_id,current_role,completed_sources,attention_sources,failed_role,updated_at)
                   VALUES (1,?,NULL,0,0,NULL,?)
                   ON CONFLICT(id) DO UPDATE SET
                   job_id=excluded.job_id,current_role=NULL,
                   completed_sources=0,attention_sources=0,failed_role=NULL,
                   updated_at=excluded.updated_at""",
                (job_id, now),
            )
            if first_order is not None:
                db.execute("INSERT INTO browser_audit_seed "
                           "(id,job_id,cargo_place,inventory_date) VALUES (1,?,?,?)",
                           (job_id, first_order["cargo_place"], first_order["inventory_date"]))
            elif batch is not None:
                db.executemany(
                    "INSERT INTO browser_audit_seed_items "
                    "(job_id,position,cargo_place,inventory_date) VALUES (?,?,?,?)",
                    [(job_id, position, item["cargo_place"], item["inventory_date"])
                     for position, item in enumerate(batch)])
            if batch_cursor is not None:
                db.execute(
                    """INSERT INTO inventa_batch_cursor
                       (source_hash,fingerprint,next_offset,total,pending_end,pending_job_id)
                       VALUES (?,?,?,?,?,?) ON CONFLICT(source_hash) DO UPDATE SET
                       fingerprint=excluded.fingerprint,
                       next_offset=excluded.next_offset,total=excluded.total,
                       pending_end=excluded.pending_end,pending_job_id=excluded.pending_job_id""",
                    (batch_cursor["source_hash"], batch_cursor["fingerprint"],
                     batch_cursor["start"], batch_cursor["total"],
                     batch_cursor.get("end", batch_cursor["start"] + len(batch)), job_id))
        return {"job_id": job_id, "status": "pending", "created_at": now,
                "updated_at": now}

    def claim_browser_audit(self) -> dict[str, Any] | None:
        """Native host may atomically claim a pending desktop-requested job once."""
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire_browser_audit(db)
            row = db.execute(
                "SELECT job_id,created_at FROM browser_audit_job "
                "WHERE id=1 AND status='pending'"
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE browser_audit_job SET status='running',updated_at=? WHERE id=1",
                (_now(),),
            )
            seed = db.execute("SELECT cargo_place,inventory_date FROM browser_audit_seed "
                              "WHERE id=1 AND job_id=?", (row["job_id"],)).fetchone()
            items = db.execute("SELECT cargo_place,inventory_date FROM browser_audit_seed_items "
                               "WHERE job_id=? ORDER BY position", (row["job_id"],)).fetchall()
            db.execute("DELETE FROM browser_audit_seed WHERE id=1")
            db.execute("DELETE FROM browser_audit_seed_items WHERE job_id=?", (row["job_id"],))
        result = {"job_id": row["job_id"], "status": "running"}
        with self._session() as db:
            context = db.execute("SELECT context_json FROM inventa_writeback WHERE job_id=?", (row["job_id"],)).fetchone()
            if context:
                result["writeback_required"] = True
                result["asgard_writeback_required"] = json.loads(context["context_json"]).get("asgard_required") is True
        if items:
            result["inventory"] = {"columns": ["cargo_place", "inventory_date"],
                                   "rows": [[item["cargo_place"], item["inventory_date"]]
                                            for item in items]}
        elif seed:
            result["inventory"] = {"columns": ["cargo_place", "inventory_date"],
                                   "rows": [[seed["cargo_place"], seed["inventory_date"]]]}
        return result

    def finish_browser_audit(self, job_id: str, succeeded: bool, failure_reason: str | None = None) -> bool:
        if (not isinstance(job_id, str) or len(job_id) != 36
                or not isinstance(succeeded, bool)
                or failure_reason not in {None,
                    "sources_not_configured", "browser_permission_missing", "execution_failed",
                    "invalid_inventory_search_keys", "unmapped_search_form", "invalid_search",
                    "unsafe_search_target", "unverified_search_result_identity", "unmapped_search_results",
                    "changed_search_schema", "too_many_search_rows", "virtualized_or_incomplete_grid",
                    "navigation_outside_allowed_origin", "search_origin_mismatch", "unexpected_document",
                    "empty_page", "unmapped_paginated_table", "pagination_cycle",
                    "pagination_limit", "changed_table_schema", "too_many_rows",
                    "native_host_rejected", "page_timeout", "tab_closed",
                    "unsupported_search_form", "dynamic_search_ui", "unsupported_dynamic_search",
                    "dynamic_search_no_result_update", "dynamic_search_unchanged_table", "search_field_missing",
                    "search_field_ambiguous", "search_filters_not_empty", "search_button_missing",
                    "search_button_ambiguous", "search_navigation_ambiguous", "search_results_unconfirmed",
                    "site_or_browser_error", "inventa_writeback_required", "inventa_writeback_failed",
                    "inventa_writeback_source_changed", "inventa_writeback_formula_protected",
                    "inventa_writeback_reauthorization_required", "inventa_writeback_permission_denied",
                    "inventa_writeback_verification_failed",
                }):
            return False
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire_browser_audit(db)
            pending_write = db.execute("SELECT state,asgard_state,context_json FROM inventa_writeback WHERE job_id=?", (job_id,)).fetchone()
            if succeeded and pending_write and (pending_write["state"] != 'applied' or (json.loads(pending_write["context_json"]).get("asgard_required") and pending_write["asgard_state"] != 'applied')):
                succeeded, failure_reason = False, 'inventa_writeback_required'
            cursor = db.execute(
                """UPDATE browser_audit_job SET status=?,updated_at=?,failure_reason=?
                   WHERE id=1 AND job_id=? AND status='running'""",
                ("completed" if succeeded else "failed", _now(), None if succeeded else failure_reason, job_id),
            )
            if cursor.rowcount:
                db.execute(
                    """UPDATE inventa_batch_cursor
                       SET next_offset=CASE WHEN ? THEN pending_end ELSE next_offset END,
                           pending_end=NULL,pending_job_id=NULL
                       WHERE pending_job_id=?""",
                    (1 if succeeded else 0, job_id))
            if cursor.rowcount:
                db.execute("DELETE FROM inventa_writeback WHERE job_id=?", (job_id,))
            return cursor.rowcount == 1

    def update_browser_audit_progress(
        self, job_id: str, current_role: str | None, completed_sources: int,
        attention_sources: int, failed_role: str | None,
    ) -> bool:
        """Accept only coarse progress from the active claimed job.

        No URLs, codes, source rows, snippets or browser exceptions are stored.
        """
        roles = {"inventory", "datalens", "asgard"}
        if (not isinstance(job_id, str) or len(job_id) != 36
                or current_role not in roles | {None}
                or failed_role not in roles | {None}
                or type(completed_sources) is not int or
                type(attention_sources) is not int or
                not 0 <= attention_sources <= completed_sources <= 3):
            return False
        with self._session() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire_browser_audit(db)
            active = db.execute(
                "SELECT job_id,status FROM browser_audit_job WHERE id=1"
            ).fetchone()
            if active is None or active["job_id"] != job_id or active["status"] != "running":
                return False
            prior = db.execute(
                "SELECT completed_sources,attention_sources FROM browser_audit_progress "
                "WHERE id=1 AND job_id=?", (job_id,),
            ).fetchone()
            if prior is None or completed_sources < prior["completed_sources"] or (
                attention_sources < prior["attention_sources"]):
                return False
            db.execute(
                """UPDATE browser_audit_progress
                   SET current_role=?,completed_sources=?,attention_sources=?,
                       failed_role=?,updated_at=?
                   WHERE id=1 AND job_id=?""",
                (current_role, completed_sources, attention_sources,
                 failed_role, _now(), job_id),
            )
        return True
