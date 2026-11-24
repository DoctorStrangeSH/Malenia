"""Malenia's knowledge base: the user's Markdown notes (Obsidian vault or a
GitHub repository such as Malenia_Knowledge_Base), indexed for retrieval.

Documents are split by headings into sections and searched with SQLite FTS5
(prefix matching works reasonably for Russian word forms). Relevant sections
are given to the model automatically, and the model can open whole documents
with tools, so instructions are understood in context rather than replayed.
"""
from __future__ import annotations

import io
import math
import re
from array import array
import threading
import time
import zipfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from .store import TaskStore, _now

MAX_DOC = 400_000
MAX_DOCS = 3000
CHUNK = 1800
REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
SKIP_DIRS = {".git", ".obsidian", ".trash", "node_modules", ".github"}


class KnowledgeBaseError(Exception):
    pass


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not match:
        return {}, text
    meta = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and re.fullmatch(r"[A-Za-z_][\w-]*", key.strip()):
            meta[key.strip()] = value.strip().strip('"').strip("'")
    return meta, text[match.end():]


def split_sections(text: str, title: str) -> list[tuple[str, str]]:
    """[(heading path, content)] with long sections cut on paragraph borders."""
    sections: list[tuple[str, str]] = []
    path: list[str] = []
    buffer: list[str] = []
    in_code = False

    def flush():
        content = "\n".join(buffer).strip()
        buffer.clear()
        if not content:
            return
        heading = " › ".join([title] + path) if path else title
        while len(content) > CHUNK:
            cut = content.rfind("\n\n", 0, CHUNK)
            cut = cut if cut > CHUNK // 3 else CHUNK
            sections.append((heading, content[:cut].strip()))
            content = content[cut:].strip()
        if content:
            sections.append((heading, content))

    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
        heading = None if in_code else re.match(r"^(#{1,4})\s+(.+?)\s*#*$", line)
        if heading:
            flush()
            level = len(heading.group(1))
            # "#" is the document title; "##" starts path[0], "###" path[1]...
            del path[max(0, level - 2):]
            if level > 1:
                path.append(heading.group(2).strip())
        else:
            buffer.append(line)
    flush()
    return sections


# Work identifiers say a lot about which procedure applies.
ID_HINTS = [
    (re.compile(r"\blaas-?\d", re.I), "laas логистические"),
    (re.compile(r"\blo-?\d", re.I), "lo логистические маршрут"),
    (re.compile(r"\b(voz|pvz|fsn)_", re.I), "возвратные обратный поток коробки"),
    (re.compile(r"(?<![\w-])\d{10,12}\b"), "прямой цифровой заказ"),
]


def _fts_query(text: str) -> str:
    text = text + " " + " ".join(hint for pattern, hint in ID_HINTS if pattern.search(text))
    words = [w for w in re.findall(r"[\w-]{2,}", text.casefold()) if not w.isdigit() or len(w) >= 4]
    words = [part for w in words for part in w.split("-") if len(part) >= 2]
    terms = []
    for word in dict.fromkeys(words):
        word = word.replace('"', "")
        stem = word[:6] if len(word) > 7 and not re.search(r"\d", word) else word
        terms.append(f'"{stem}"*')
    return " OR ".join(terms[:24])


class KnowledgeVault:
    def __init__(self, store: TaskStore, settings, secrets=None, opener=None, embedder=None):
        # embedder: object with embedding_model() -> str | None and embed(model, texts) -> vectors
        self.embedder = embedder
        self.store = store
        self.settings = settings
        self.secrets = secrets
        self.opener = opener or build_opener()
        self._lock = threading.Lock()
        self._sync_thread: threading.Thread | None = None
        self.status: dict[str, Any] = {"state": "idle", "error": None}
        with store._session() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS kb_docs (
                    path TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT, status TEXT,
                    tags TEXT, body TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS kb_vectors (chunk INTEGER PRIMARY KEY, vector BLOB NOT NULL);
                CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING fts5(
                    path UNINDEXED, heading, content, tokenize='unicode61 remove_diacritics 2');
            """)

    # ---- configuration --------------------------------------------------
    def config(self) -> dict:
        value = self.settings.get("kb.config", {})
        return value if isinstance(value, dict) else {}

    def configure(self, payload: dict) -> dict:
        config = self.config()
        if "folder" in payload:
            folder = (payload.get("folder") or "").strip()
            if folder and not Path(folder).expanduser().is_dir():
                raise KnowledgeBaseError("Папка не найдена")
            config["folder"] = str(Path(folder).expanduser()) if folder else ""
        if "repo" in payload:
            repo = (payload.get("repo") or "").strip()
            repo = re.sub(r"^https?://github\.com/", "", repo).strip("/").removesuffix(".git")
            if repo and not REPO.fullmatch(repo):
                raise KnowledgeBaseError("Укажите репозиторий в виде owner/name или ссылкой GitHub")
            config["repo"] = repo
        if "branch" in payload:
            branch = (payload.get("branch") or "").strip()
            if branch and not re.fullmatch(r"[\w./-]{1,100}", branch):
                raise KnowledgeBaseError("Некорректная ветка")
            config["branch"] = branch
        if "token" in payload and self.secrets is not None:
            token = (payload.get("token") or "").strip()
            if token:
                if not re.fullmatch(r"[A-Za-z0-9_]{20,255}", token):
                    raise KnowledgeBaseError("Некорректный токен GitHub")
                self.secrets.set("kb.github", token)
            else:
                try:
                    self.secrets.delete("kb.github")
                except Exception:
                    pass
        self.settings.set("kb.config", config)
        return self.describe()

    def enable_auto_sync(self) -> None:
        self.start_background_sync()

    def describe(self) -> dict:
        config = self.config()
        with self.store._session() as db:
            docs = db.execute("SELECT COUNT(*) FROM kb_docs").fetchone()[0]
            chunks = db.execute("SELECT COUNT(*) FROM kb_chunks").fetchone()[0]
            items = [dict(r) for r in db.execute(
                "SELECT path, title, type, status FROM kb_docs ORDER BY path LIMIT 300")]
        has_token = False
        if self.secrets is not None:
            try:
                has_token = bool(self.secrets.get("kb.github"))
            except Exception:
                has_token = False
        with self.store._session() as db:
            vectors = db.execute("SELECT COUNT(*) FROM kb_vectors").fetchone()[0]
        return {"semantic": bool(self.settings.get("kb.embed_model")) and vectors > 0,
                "embed_model": self.settings.get("kb.embed_model"), "folder": config.get("folder", ""), "repo": config.get("repo", ""), "branch": config.get("branch", ""),
                "has_token": has_token, "documents": docs, "sections": chunks, "items": items,
                "last_sync": self.settings.get("kb.last_sync"), "status": dict(self.status)}

    # ---- sync -----------------------------------------------------------
    def _collect_folder(self, folder: Path) -> dict[str, str]:
        files: dict[str, str] = {}
        root = folder.resolve()
        for path in sorted(root.rglob("*.md")):
            if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
                continue
            if path.is_symlink() or path.stat().st_size > MAX_DOC:
                continue
            files[path.relative_to(root).as_posix()] = path.read_text("utf-8", errors="replace")
            if len(files) >= MAX_DOCS:
                break
        return files

    def _collect_github(self, repo: str, branch: str) -> dict[str, str]:
        url = f"https://api.github.com/repos/{repo}/zipball" + (f"/{branch}" if branch else "")
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "Malenia-KB"}
        token = self.secrets.get("kb.github") if self.secrets is not None else None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with self.opener.open(Request(url, headers=headers), timeout=60) as response:
                raw = response.read(60 * 1024 * 1024 + 1)
        except HTTPError as error:
            if error.code in (401, 403, 404):
                raise KnowledgeBaseError("Нет доступа к репозиторию. Для приватного репозитория нужен токен GitHub с правом чтения (Contents: Read).") from None
            raise KnowledgeBaseError(f"GitHub ответил ошибкой {error.code}") from None
        except (URLError, OSError):
            raise KnowledgeBaseError("Нет связи с GitHub") from None
        if len(raw) > 60 * 1024 * 1024:
            raise KnowledgeBaseError("Репозиторий слишком большой")
        files: dict[str, str] = {}
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for info in archive.infolist():
                parts = info.filename.split("/", 1)
                if len(parts) < 2 or info.is_dir() or not parts[1].lower().endswith(".md"):
                    continue
                if any(part in SKIP_DIRS for part in parts[1].split("/")) or info.file_size > MAX_DOC:
                    continue
                files[parts[1]] = archive.read(info).decode("utf-8", errors="replace")
                if len(files) >= MAX_DOCS:
                    break
        return files

    def sync(self) -> dict:
        if not self._lock.acquire(blocking=False):
            raise KnowledgeBaseError("Синхронизация уже идёт")
        try:
            self.status = {"state": "syncing", "error": None}
            config = self.config()
            files: dict[str, str] = {}
            if config.get("folder"):
                folder = Path(config["folder"])
                if not folder.is_dir():
                    raise KnowledgeBaseError("Папка базы знаний не найдена")
                files.update(self._collect_folder(folder))
            if config.get("repo"):
                files.update({k: v for k, v in self._collect_github(config["repo"], config.get("branch", "")).items() if k not in files})
            if not config.get("folder") and not config.get("repo"):
                raise KnowledgeBaseError("Укажите папку или репозиторий базы знаний")
            self._index(files)
            self._embed_all()
            self.settings.set("kb.last_sync", _now())
            self.status = {"state": "done", "error": None}
            return self.describe()
        except KnowledgeBaseError as error:
            from . import diagnostics
            diagnostics.record("kb_sync_failed", str(error))
            self.status = {"state": "failed", "error": str(error)}
            raise
        except Exception as error:  # keep the agent running whatever the content is
            self.status = {"state": "failed", "error": "Не удалось прочитать базу знаний"}
            raise KnowledgeBaseError("Не удалось прочитать базу знаний") from error
        finally:
            self._lock.release()

    def _index(self, files: dict[str, str]) -> None:
        with self.store._session() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM kb_docs")
            db.execute("DELETE FROM kb_chunks")
            db.execute("DELETE FROM kb_vectors")
            for path, text in files.items():
                meta, body = _frontmatter(text)
                first = re.search(r"^#\s+(.+)$", body, re.M)
                title = meta.get("title") or (first.group(1).strip() if first else Path(path).stem)
                db.execute("INSERT INTO kb_docs VALUES (?,?,?,?,?,?,?)",
                           (path, title[:200], meta.get("type"), meta.get("status"), meta.get("tags"), body, _now()))
                for heading, content in split_sections(body, title):
                    db.execute("INSERT INTO kb_chunks(path, heading, content) VALUES (?,?,?)", (path, heading, content))

    # ---- updating instructions ("Дополни инструкцию") -------------------
    def update_document(self, path: str, text: str, section: str | None = None, mode: str = "append") -> dict:
        """Add to (or replace) a section of a document and save it to the source (GitHub or folder)."""
        text = (text or "").strip()
        if not text or len(text) > 20000:
            raise KnowledgeBaseError("Пустой или слишком длинный текст")
        if mode not in ("append", "replace"):
            raise KnowledgeBaseError("Неизвестный режим изменения")
        if not re.fullmatch(r"[^\0]{1,300}\.md", path or "") or ".." in path or path.startswith("/"):
            raise KnowledgeBaseError("Некорректный путь документа")
        config = self.config()
        if config.get("repo"):
            original, sha = self._github_file(config["repo"], config.get("branch", ""), path)
        elif config.get("folder"):
            file = (Path(config["folder"]) / path).resolve()
            if not str(file).startswith(str(Path(config["folder"]).resolve())):
                raise KnowledgeBaseError("Некорректный путь документа")
            original, sha = (file.read_text("utf-8") if file.exists() else ""), None
        else:
            raise KnowledgeBaseError("База знаний не подключена")
        updated = _edit_markdown(original, text, section, mode)
        message = f"Маления: {'дополнение' if mode == 'append' else 'правка'} — {Path(path).stem}" + (f" › {section}" if section else "")
        if config.get("repo"):
            self._github_put(config["repo"], config.get("branch", ""), path, updated, sha, message)
        else:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(updated, "utf-8")
        try:
            self.sync()
        except KnowledgeBaseError:
            pass
        return {"path": path, "section": section, "saved": True}

    def _github_headers(self) -> dict:
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "Malenia-KB",
                   "Content-Type": "application/json"}
        token = self.secrets.get("kb.github") if self.secrets is not None else None
        if not token:
            raise KnowledgeBaseError("Для записи в базу нужен токен GitHub с правом Contents: Read and write")
        headers["Authorization"] = f"Bearer {token}"
        return headers

    def _github_file(self, repo: str, branch: str, path: str) -> tuple[str, str | None]:
        import base64
        import json as _json
        from urllib.parse import quote
        url = f"https://api.github.com/repos/{repo}/contents/{quote(path)}" + (f"?ref={quote(branch)}" if branch else "")
        try:
            with self.opener.open(Request(url, headers=self._github_headers()), timeout=30) as response:
                data = _json.loads(response.read(5 * 1024 * 1024))
        except HTTPError as error:
            if error.code == 404:
                return "", None
            raise KnowledgeBaseError("GitHub не дал прочитать документ") from None
        except (URLError, OSError):
            raise KnowledgeBaseError("Нет связи с GitHub") from None
        return base64.b64decode(data.get("content") or "").decode("utf-8", "replace"), data.get("sha")

    def _github_put(self, repo: str, branch: str, path: str, content: str, sha: str | None, message: str) -> None:
        import base64
        import json as _json
        from urllib.parse import quote
        body = {"message": message, "content": base64.b64encode(content.encode("utf-8")).decode()}
        if sha:
            body["sha"] = sha
        if branch:
            body["branch"] = branch
        request = Request(f"https://api.github.com/repos/{repo}/contents/{quote(path)}",
                          data=_json.dumps(body).encode(), headers=self._github_headers(), method="PUT")
        try:
            with self.opener.open(request, timeout=30) as response:
                response.read(1024 * 1024)
        except HTTPError as error:
            if error.code in (401, 403, 404):
                raise KnowledgeBaseError("Токен GitHub не разрешает запись. Нужен fine-grained токен с правом "
                                         "Contents: Read and write для репозитория базы.") from None
            if error.code == 409:
                raise KnowledgeBaseError("Документ изменился одновременно — повторите") from None
            raise KnowledgeBaseError(f"GitHub ответил ошибкой {error.code}") from None
        except (URLError, OSError):
            raise KnowledgeBaseError("Нет связи с GitHub") from None

    # ---- meaning-based search (embeddings) ------------------------------
    def _embed_model(self) -> str | None:
        if self.embedder is None:
            return None
        try:
            return self.embedder.embedding_model()
        except Exception:
            return None

    def _embed_all(self) -> None:
        model = self._embed_model()
        self.settings.set("kb.embed_model", model)
        if not model:
            return
        with self.store._session() as db:
            rows = [(r[0], r[1], r[2]) for r in db.execute("SELECT rowid, heading, content FROM kb_chunks")]
        try:
            for start in range(0, len(rows), 32):
                batch = rows[start:start + 32]
                vectors = self.embedder.embed(model, [f"{h}\n{c}"[:2000] for _, h, c in batch])
                with self.store._session() as db:
                    db.executemany("INSERT OR REPLACE INTO kb_vectors VALUES (?, ?)",
                                   [(rowid, _pack(vector)) for (rowid, _, _), vector in zip(batch, vectors)])
                self.status = {"state": "syncing", "error": None, "embedded": start + len(batch), "total": len(rows)}
        except Exception:
            # Meaning search is a bonus: keyword search keeps working.
            self.settings.set("kb.embed_model", None)

    def _semantic(self, query: str, limit: int, scope: str | None) -> list[tuple[int, float]]:
        model = self.settings.get("kb.embed_model")
        if not model or self.embedder is None:
            return []
        try:
            target = _normalise(self.embedder.embed(model, [query[:2000]])[0])
        except Exception:
            return []
        with self.store._session() as db:
            rows = db.execute("""SELECT v.chunk, v.vector FROM kb_vectors v JOIN kb_chunks c ON c.rowid = v.chunk
                                 WHERE (? = '' OR c.path LIKE ?)""", (scope or "", (scope or "") + "%")).fetchall()
        scored = []
        for chunk, blob in rows:
            vector = array("f")
            vector.frombytes(blob)
            if len(vector) == len(target):
                scored.append((chunk, sum(a * b for a, b in zip(target, vector))))
        scored.sort(key=lambda item: -item[1])
        return scored[:limit]

    def start_background_sync(self, interval: int = 1800) -> None:
        """Keep a configured knowledge base fresh while the app runs."""
        config = self.config()
        if self._sync_thread is not None or not (config.get("repo") or config.get("folder")):
            return

        def loop():
            while True:
                config = self.config()
                if config.get("repo") or config.get("folder"):
                    try:
                        self.sync()
                    except KnowledgeBaseError:
                        pass
                time.sleep(interval)
        self._sync_thread = threading.Thread(target=loop, name="malenia-kb-sync", daemon=True)
        self._sync_thread.start()

    # ---- retrieval ------------------------------------------------------
    def search(self, query: str, limit: int = 5, scope: str | None = None) -> list[dict]:
        fts = _fts_query(query or "")
        if not fts:
            return []
        with self.store._session() as db:
            try:
                rows = db.execute(
                    """SELECT c.rowid AS chunk, c.path, c.heading, c.content, d.type, bm25(kb_chunks, 0, 2.0, 1.0) AS score
                       FROM kb_chunks c JOIN kb_docs d ON d.path = c.path
                       WHERE kb_chunks MATCH ? AND (? = '' OR c.path LIKE ?) ORDER BY score LIMIT ?""",
                    (fts, scope or "", (scope or "") + "%", limit * 3)).fetchall()
            except Exception:
                rows = []
        keyword = [dict(r) for r in rows]
        for item in keyword:
            item["score"] -= 1.5 if (item["type"] or "").startswith("operational") else 0
        keyword.sort(key=lambda item: item["score"])
        meaning = self._semantic(query, limit * 3, scope)
        if not meaning:
            return [{k: item[k] for k in ("path", "heading", "content", "score")} for item in keyword[:limit]]
        # Reciprocal rank fusion of keyword and meaning results.
        fused: dict[int, float] = {}
        for rank, item in enumerate(keyword):
            fused[item["chunk"]] = fused.get(item["chunk"], 0) + 1 / (60 + rank)
        for rank, (chunk, _) in enumerate(meaning):
            fused[chunk] = fused.get(chunk, 0) + 1 / (60 + rank)
        best = sorted(fused, key=lambda chunk: -fused[chunk])[:limit]
        known = {item["chunk"]: item for item in keyword}
        results = []
        with self.store._session() as db:
            for chunk in best:
                item = known.get(chunk)
                if item is None:
                    row = db.execute("SELECT path, heading, content FROM kb_chunks WHERE rowid = ?", (chunk,)).fetchone()
                    if row is None:
                        continue
                    item = dict(row)
                results.append({"path": item["path"], "heading": item["heading"], "content": item["content"],
                                "score": -fused[chunk]})
        return results

    def document(self, path: str, section: str | None = None) -> dict:
        with self.store._session() as db:
            row = db.execute("SELECT path, title, body FROM kb_docs WHERE path = ?", (path,)).fetchone()
            if row is None:
                row = db.execute("SELECT path, title, body FROM kb_docs WHERE title LIKE ? OR path LIKE ? LIMIT 1",
                                 (f"%{path}%", f"%{path}%")).fetchone()
        if row is None:
            raise KnowledgeBaseError("Документ не найден")
        body = row["body"]
        if section:
            parts = [content for heading, content in split_sections(body, row["title"]) if section.casefold() in heading.casefold()]
            body = "\n\n".join(parts) if parts else body
        return {"path": row["path"], "title": row["title"], "content": body[:30000], "truncated": len(body) > 30000}

    def context_for(self, query: str, budget: int = 5000, scope: str | None = None) -> list[dict]:
        chosen, used = [], 0
        found = self.search(query, 6, scope) if scope else []
        for item in found + [i for i in self.search(query, 6) if i["path"] not in {f["path"] for f in found}]:
            if used + len(item["content"]) > budget:
                continue
            chosen.append(item)
            used += len(item["content"])
        return chosen


def _normalise(vector) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


def _pack(vector) -> bytes:
    return array("f", _normalise(vector)).tobytes()


def _edit_markdown(original: str, text: str, section: str | None, mode: str) -> str:
    """Append to / replace the body of the section whose heading contains `section`."""
    if not original.strip():
        return (f"## {section}\n\n" if section else "") + text + "\n"
    lines = original.splitlines()
    if section:
        start = None
        level = 0
        for index, line in enumerate(lines):
            match = re.match(r"^(#{1,6})\s+(.*)$", line)
            if match and section.casefold() in match.group(2).casefold():
                start, level = index, len(match.group(1))
                break
        if start is not None:
            end = len(lines)
            for index in range(start + 1, len(lines)):
                match = re.match(r"^(#{1,6})\s+", lines[index])
                if match and len(match.group(1)) <= level:
                    end = index
                    break
            body_end = end
            while body_end > start + 1 and not lines[body_end - 1].strip():
                body_end -= 1
            if mode == "replace":
                new = lines[:start + 1] + [""] + text.splitlines() + [""] + lines[end:]
            else:
                new = lines[:body_end] + [""] + text.splitlines() + [""] + lines[end:]
            return "\n".join(new).rstrip() + "\n"
        return original.rstrip() + f"\n\n## {section}\n\n{text}\n"
    return original.rstrip() + "\n\n" + text + "\n"
