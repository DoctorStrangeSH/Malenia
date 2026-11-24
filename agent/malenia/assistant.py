"""General-purpose assistant: conversations, tools and self-learning memory.

Self-learning here means the assistant gets better *for this user* without
retraining model weights:
  * it extracts durable facts and preferences from conversations (memories);
  * the model can save something explicitly with the `remember` tool;
  * thumbs up/down re-rank the memories and instructions that were used, and a
    correction after a thumbs-down becomes a "lesson" applied next time.
Everything is stored locally and is visible/deletable in the UI.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime
from typing import Any

from . import diagnostics
from .attachments import AttachmentError, prepare as prepare_attachments
from .knowledge import KnowledgeBase, KnowledgeError, words
from .providers import Cancelled, ModelRouter, ProviderError
from .store import TaskStore, _now
from .web import PublicSearch, WebError

MAX_MESSAGE = 16000
MAX_ROUNDS = 40       # tool rounds per answer (browsing needs several steps)
COMPRESS_AFTER = 30   # messages beyond the last summary before summarising again
KEEP_RECENT = 20      # recent messages always sent in full
COMPRESS_PROMPT = ("Ты ведёшь краткое содержание длинного разговора пользователя с ассистентом Маленией. "
                   "Обнови содержание с учётом новых сообщений: цели и задачи пользователя, принятые решения, важные "
                   "факты, числа, имена, договорённости и что осталось сделать. Пиши по-русски, сжато, списком, "
                   "до 1500 символов. Не выдумывай.")
MAX_MEMORIES = 500
MEMORY_KINDS = {"fact", "preference", "lesson"}

SYSTEM_PROMPT = """Ты — Маления, персональная ИИ-помощница пользователя. О себе говоришь в женском роде.
Помогаешь пользователю с любыми задачами: работа, учёба, тексты, письма, планирование, код, расчёты, советы, быт.
Отвечай на языке пользователя (по умолчанию по-русски), по делу, структурированно, без воды. Используй Markdown, когда это помогает.
Если для ответа нужны свежие данные (новости, цены, курсы, расписания, факты после твоего обучения) — используй инструмент web_search.
Если пользователь сообщает о себе что-то долговременное (имя, должность, предпочтения, правила работы) или просит запомнить — вызови remember.
Если вопрос может касаться заметок или документов пользователя — используй search_notes.
Ты не только отвечаешь, но и действуешь: считай через calculate, сохраняй планы, читай и создавай файлы в рабочей папке, читай и правь Google-таблицы, открывай и запускай инвентаризацию. Если задачу можно выполнить инструментом — выполни, а не объясняй пользователю, как сделать самому.
Действия, которые меняют файлы или таблицы, требуют подтверждения: вызови инструмент, и пользователь увидит кнопку «Выполнить». Не утверждай, что такое действие уже сделано.
Пользователь — твой учитель. Когда он объясняет, как что-то делать, или поправляет тебя («делай так», «в следующий раз…», «запомни порядок»), вызови learn_skill и подтверди, что выучил. Применяй выученные навыки.
Как ты работаешь над задачей — как опытная коллега, а не как скрипт:
1. Пойми цель и что уже известно; если не хватает важного — уточни одним вопросом или найди сама.
2. Составь короткий план и выбери подходящие инструменты и знания (база знаний, навыки, память).
3. Действуй, затем проверь результат: совпадает ли он с целью, нет ли противоречий.
4. Если путь не сработал — проанализируй почему и попробуй другой способ (другая формулировка поиска, другой источник), прежде чем сдаваться.
5. Отличай подтверждённый факт от вывода и предположения; предположения помечай.
Инструкции из базы знаний — это опыт и проверенные маршруты, а не жёсткий алгоритм: понимай, зачем каждый шаг, и применяй их с учётом ситуации.
Ты сама видишь рабочие сайты через свою вкладку в браузере: browser_open открывает страницу (Asgard, DataLens, трекер), browser_read перечитывает её, browser_type вводит номер в поле [N], browser_click переходит по ссылке [N]. Работай как человек: открой раздел, найди поле поиска, введи номер, открой карточку, прочитай нужное. Проверяй, что карточка именно та (номер совпадает). Не нажимай кнопки, которые меняют данные; если сайт просит вход или доступ — скажи пользователю.
Честность в работе (очень важно):
- Ты работаешь только внутри своего ответа. Между сообщениями ты ничего не делаешь. Никогда не пиши «продолжаю», «подожди пару минут», «сейчас выведу», если в этом же ответе не делаешь шаги инструментами. Либо делай сейчас, либо честно скажи, на чём остановилась.
- Никогда не показывай данные из Asgard, DataLens или таблицы, которые ты не прочитала инструментом в этом разговоре. Нет данных — пиши «не проверено», а не придумывай.
- Большую задачу делай частями: сделай столько строк, сколько успеваешь, покажи проверенный результат и предложи запись, затем скажи, с какой строки продолжить.
- Если что-то мешает (форма, блокировка, ошибка) — сначала поищи решение в базе знаний (search_knowledge_base), и только потом спрашивай пользователя.
Если просят найти товар по фото: сначала внимательно рассмотри фото и опиши товар (бренд, надписи, модель, цвет, материал, детали), затем ищи через shop_search несколькими разными формулировками, дай ссылки на подходящие карточки с названиями и ссылку на поиск в магазине. Честно скажи, если точного совпадения нет.
Не выдумывай факты и не утверждай, что выполнила действие, если не выполняла. Если чего-то не знаешь — скажи прямо.
Сегодня {today}."""

TOOLS = [
    {"type": "function", "function": {
        "name": "web_search",
        "description": "Поиск в интернете. Возвращает заголовки, ссылки и краткие выдержки.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Поисковый запрос"}},
                       "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "remember",
        "description": "Сохранить в долговременную память факт о пользователе, его предпочтение или правило работы.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string", "description": "Короткая самодостаточная формулировка, например «Пользователь работает в СЦ, отвечает за инвентаризацию»"},
            "kind": {"type": "string", "enum": ["fact", "preference", "lesson"]}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "search_notes",
        "description": "Поиск по заметкам и документам пользователя, сохранённым в Малении.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
]

REFLECTION_PROMPT = """Ты модуль памяти ассистента. Прочитай последний обмен репликами и извлеки ТОЛЬКО долговременные сведения о пользователе, которые пригодятся в будущих разговорах: имя, работа, обязанности, используемые системы, стиль ответов, который он предпочитает, постоянные правила.
Не сохраняй разовые запросы, содержание задачи, номера заказов, пароли, ключи, телефоны, адреса и прочие персональные данные третьих лиц.
Уже известно:
{known}
Верни JSON: {{"memories": [{{"content": "...", "kind": "fact|preference"}}]}}. Если нечего сохранить — {{"memories": []}}."""

PERSONAL_SIGNALS = re.compile(
    r"\b(я|мне|меня|мой|моя|моё|мои|мы|нам|наш|наша|наши|у нас|зовут|работаю|предпочита|люблю|"
    r"не люблю|всегда|никогда|обычно|запомни|отвечай|пиши|называй|i|my|me|we|our)\b", re.I)
SECRET_PATTERN = re.compile(r"(парол|password|token|токен|api[ _-]?key|ключ api|\b\d{16}\b|sk-[a-z0-9]{10,})", re.I)


class AssistantError(Exception):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)


def stems(text: str) -> set[str]:
    """Crude Russian-friendly stemming: compare word beginnings."""
    return {w[:6] if len(w) > 6 else w for w in words(text)}


def _similar(a: str, b: str) -> bool:
    wa, wb = stems(a), stems(b)
    if not wa or not wb:
        return a.strip().casefold() == b.strip().casefold()
    return len(wa & wb) / len(wa | wb) >= 0.6


STEP_LABELS = {
    "web_search": ("Ищу в интернете", "query"),
    "remember": ("Запоминаю", "content"),
    "search_notes": ("Ищу в заметках", "query"),
    "search_knowledge_base": ("Ищу в базе знаний", "query"),
    "read_knowledge_document": ("Читаю документ", "path"),
    "shop_search": ("Ищу в магазине", "query"),
    "calculate": ("Считаю", "expression"),
    "create_plan": ("Составляю план", "title"),
    "list_plans": ("Смотрю планы", None),
    "learn_skill": ("Запоминаю навык", "title"),
    "list_files": ("Смотрю файлы", None),
    "read_file": ("Читаю файл", "path"),
    "write_file": ("Готовлю файл", "path"),
    "read_google_sheet": ("Читаю таблицу", None),
    "update_google_sheet": ("Готовлю изменения в таблице", None),
    "browser_tabs": ("Смотрю вкладки браузера", None),
    "open_inventory": ("Открываю инвентаризацию", None),
    "browser_open": ("Открываю страницу", "url"),
    "browser_read": ("Читаю страницу", "focus"),
    "browser_type": ("Ввожу в поле", "text"),
    "browser_click": ("Нажимаю", "ref"),
    "browser_back": ("Возвращаюсь назад", None),
}


def step_label(name: str, args: dict) -> str:
    label, key = STEP_LABELS.get(name, ("Выполняю «" + name + "»", None))
    detail = str(args.get(key) or "").strip() if key and isinstance(args, dict) else ""
    if name == "shop_search" and isinstance(args, dict) and args.get("shop"):
        label = f"Ищу на {args['shop']}"
    return f"{label}: {detail[:80]}" if detail else label


PROMISE = re.compile(r"(продолжаю|продолжу|подожди|подождите|сейчас (выведу|подготовлю|сделаю|начну|проверю)|начинаю (обработку|поиск|первую)|перехожу к|в процессе перебора|я работаю)", re.I)
TABLE = re.compile(r"^\s*\|.*\|\s*$", re.M)


def _needs_nudge(answer: str, steps: list[dict]) -> str | None:
    """Catch 'I am working on it' without work, and system data shown without looking."""
    used_browser = any(str(step.get("tool", "")).startswith("browser_") for step in steps)
    if PROMISE.search(answer) and len(answer) < 4000:
        return ("(Проверка от приложения) Ты написала, что продолжаешь работу, но в этом ответе не сделала ни одного "
                "действия. Между сообщениями ты не работаешь. Сделай следующий шаг прямо сейчас инструментами, "
                "или честно напиши, на чём остановилась и почему.")
    if TABLE.search(answer) and re.search(r"asgard|datalens|найден[оа]? в", answer, re.I) and not used_browser:
        return ("(Проверка от приложения) В ответе таблица с данными из рабочих систем, но в этом ответе ты их не "
                "открывала. Если эти данные не прочитаны инструментами в этом разговоре — не выдумывай: проверь через "
                "browser_open/browser_read или пометь строки «не проверено».")
    return None


def _shrink_tool_outputs(messages: list[dict], budget: int = 45000) -> None:
    """Long browsing sessions: keep the latest page snapshots, fold older ones."""
    tool_indexes = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    total = sum(len(str(m.get("content") or "")) for m in messages)
    for index in tool_indexes[:-2]:
        if total <= budget:
            break
        content = str(messages[index]["content"])
        if len(content) > 600:
            messages[index]["content"] = content[:500] + "\n…(старый результат сокращён)"
            total -= len(content) - len(messages[index]["content"])


class Run:
    """One answer being produced in the background, observed by polling."""

    def __init__(self):
        self.id = str(uuid.uuid4())
        self.events: list[dict] = []
        self.cancel = threading.Event()
        self.done = False
        self.result: dict | None = None
        self.error: dict | None = None
        self.text = ""
        self.created = time.time()
        self.lock = threading.Lock()

    def emit(self, kind: str, **data) -> None:
        with self.lock:
            if kind == "delta":
                self.text += data.get("text", "")
                last = self.events[-1] if self.events else None
                # Merge small pieces so polling returns few, larger events.
                if last is not None and last["type"] == "delta" and last.get("_open"):
                    last["text"] += data.get("text", "")
                    return
                self.events.append({"type": "delta", "text": data.get("text", ""), "_open": True})
                return
            if kind == "reset":
                self.text = ""
            for event in self.events:
                event.pop("_open", None)
            self.events.append({"type": kind, **data})

    def poll(self, after: int) -> dict:
        with self.lock:
            events = [{k: v for k, v in e.items() if k != "_open"} for e in self.events[after:]]
            for event in self.events:
                event.pop("_open", None)
            return {"run_id": self.id, "events": events, "next": len(self.events), "done": self.done,
                    "result": self.result, "error": self.error}


class Assistant:
    def __init__(self, store: TaskStore, router: ModelRouter, knowledge: KnowledgeBase | None = None,
                 skills=None, web: PublicSearch | None = None, background: bool = True, toolbox=None):
        self.toolbox = toolbox
        self.store = store
        self.router = router
        self.knowledge = knowledge
        self.skills = skills
        self.web = web or PublicSearch()
        self.background = background
        with store._session() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
                    content TEXT NOT NULL, created_at TEXT NOT NULL, provider TEXT, model TEXT,
                    feedback INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}');
                CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages(conversation_id, created_at);
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
                    kb_scope TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL,
                    source TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, last_used_at TEXT);
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(conversations)")}
            if "project_id" not in columns:
                db.execute("ALTER TABLE conversations ADD COLUMN project_id TEXT")
            if "pinned" not in columns:
                db.execute("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            if "summary" not in columns:
                db.execute("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
                db.execute("ALTER TABLE conversations ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0")

    # ---- conversations --------------------------------------------------
    def list_conversations(self, limit: int = 200, query: str | None = None, project_id: str | None = None) -> list[dict]:
        sql = "SELECT c.id, c.title, c.created_at, c.updated_at, c.project_id, c.pinned FROM conversations c"
        where, params = [], []
        if project_id:
            where.append("c.project_id = ?")
            params.append(project_id)
        if query and query.strip():
            pattern = "%" + query.strip()[:100].replace("%", "").replace("_", "") + "%"
            where.append("(c.title LIKE ? OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))")
            params += [pattern, pattern]
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?"
        with self.store._session() as db:
            rows = [dict(r) for r in db.execute(sql, (*params, limit))]
            if query and query.strip():
                for row in rows:
                    hit = db.execute("SELECT content FROM chat_messages WHERE conversation_id = ? AND content LIKE ? LIMIT 1",
                                     (row["id"], pattern)).fetchone()
                    if hit:
                        text = hit["content"]
                        at = text.casefold().find(query.strip().casefold())
                        row["snippet"] = ("…" if at > 40 else "") + text[max(0, at - 40):at + 80].replace("\n", " ")
        for row in rows:
            row["pinned"] = bool(row["pinned"])
        return rows

    def update_conversation(self, conversation_id: str, payload: dict) -> bool:
        changes, params = [], []
        if "title" in payload:
            title = re.sub(r"\s+", " ", str(payload.get("title") or "")).strip()[:120]
            if not title:
                raise AssistantError("invalid_title")
            changes.append("title = ?"); params.append(title)
        if "pinned" in payload:
            changes.append("pinned = ?"); params.append(1 if payload.get("pinned") else 0)
        if "project_id" in payload:
            project = payload.get("project_id") or None
            if project is not None and self.get_project(project) is None:
                raise AssistantError("project_not_found", 404)
            changes.append("project_id = ?"); params.append(project)
        if not changes:
            raise AssistantError("invalid_request")
        with self.store._session() as db:
            return db.execute(f"UPDATE conversations SET {', '.join(changes)} WHERE id = ?",
                              (*params, conversation_id)).rowcount > 0

    # ---- projects -------------------------------------------------------
    def list_projects(self) -> list[dict]:
        with self.store._session() as db:
            return [dict(r) for r in db.execute(
                """SELECT p.*, (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversations
                   FROM projects p ORDER BY p.updated_at DESC""")]

    def get_project(self, project_id: str) -> dict | None:
        with self.store._session() as db:
            row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row) if row else None

    def save_project(self, payload: dict, project_id: str | None = None) -> dict:
        if not isinstance(payload, dict):
            raise AssistantError("invalid_project")
        name = re.sub(r"\s+", " ", str(payload.get("name") or "")).strip()[:80]
        instructions = str(payload.get("instructions") or "").strip()[:8000]
        scope = str(payload.get("kb_scope") or "").strip().strip("/")[:200]
        if not name:
            raise AssistantError("invalid_project")
        now = _now()
        with self.store._session() as db:
            if project_id:
                if not db.execute("UPDATE projects SET name = ?, instructions = ?, kb_scope = ?, updated_at = ? WHERE id = ?",
                                  (name, instructions, scope, now, project_id)).rowcount:
                    raise AssistantError("project_not_found", 404)
            else:
                project_id = str(uuid.uuid4())
                db.execute("INSERT INTO projects VALUES (?,?,?,?,?,?)", (project_id, name, instructions, scope, now, now))
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> bool:
        with self.store._session() as db:
            db.execute("UPDATE conversations SET project_id = NULL WHERE project_id = ?", (project_id,))
            return db.execute("DELETE FROM projects WHERE id = ?", (project_id,)).rowcount > 0

    def get_conversation(self, conversation_id: str) -> dict | None:
        with self.store._session() as db:
            row = db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row is None:
                return None
            messages = [self._message(dict(m)) for m in db.execute(
                "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                (conversation_id,))]
        if self.toolbox is not None:
            for message in messages:
                if message["meta"].get("actions"):
                    message["meta"]["actions"] = self.toolbox.for_message(message["id"])
        return {**dict(row), "messages": messages}

    @staticmethod
    def _message(row: dict) -> dict:
        try:
            row["meta"] = json.loads(row.get("meta") or "{}")
        except ValueError:
            row["meta"] = {}
        return row

    def delete_conversation(self, conversation_id: str) -> bool:
        with self.store._session() as db:
            db.execute("DELETE FROM chat_messages WHERE conversation_id = ?", (conversation_id,))
            return db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,)).rowcount > 0

    def rename_conversation(self, conversation_id: str, title: str) -> bool:
        return self.update_conversation(conversation_id, {"title": title})

    @staticmethod
    def _truncate(db, conversation_id: str, pivot, inclusive: bool) -> None:
        """Delete messages after (or from) the pivot message, e.g. to edit or regenerate."""
        op = ">=" if inclusive else ">"
        db.execute(f"""DELETE FROM chat_messages WHERE conversation_id = ? AND
                       (created_at > ? OR (created_at = ? AND rowid {op} ?))""",
                   (conversation_id, pivot["created_at"], pivot["created_at"], pivot["rowid"]))
        if inclusive:
            db.execute("DELETE FROM chat_messages WHERE id = ?", (pivot["id"],))

    def _add_message(self, db, conversation_id, role, content, provider=None, model=None, meta=None) -> dict:
        row = {"id": str(uuid.uuid4()), "conversation_id": conversation_id, "role": role, "content": content,
               "created_at": _now(), "provider": provider, "model": model, "feedback": 0,
               "meta": json.dumps(meta or {}, ensure_ascii=False)}
        db.execute("""INSERT INTO chat_messages(id, conversation_id, role, content, created_at, provider, model, feedback, meta)
                      VALUES (:id,:conversation_id,:role,:content,:created_at,:provider,:model,:feedback,:meta)""", row)
        db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (row["created_at"], conversation_id))
        return self._message(dict(row))

    # ---- memories -------------------------------------------------------
    def list_memories(self) -> list[dict]:
        with self.store._session() as db:
            return [dict(r) for r in db.execute(
                "SELECT * FROM memories ORDER BY kind = 'lesson' DESC, score DESC, created_at DESC")]

    def add_memory(self, content: str, kind: str = "fact", source: str = "user") -> dict | None:
        if not isinstance(content, str):
            raise AssistantError("invalid_memory")
        content = re.sub(r"\s+", " ", content).strip()
        if not 3 <= len(content) <= 500 or kind not in MEMORY_KINDS:
            raise AssistantError("invalid_memory")
        if SECRET_PATTERN.search(content):
            return None
        with self.store._session() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = [dict(r) for r in db.execute("SELECT id, content FROM memories")]
            for item in existing:
                if _similar(item["content"], content):
                    db.execute("UPDATE memories SET content = ?, score = score + 1 WHERE id = ?",
                               (content, item["id"]))
                    return None
            if len(existing) >= MAX_MEMORIES:
                db.execute("""DELETE FROM memories WHERE id = (SELECT id FROM memories WHERE kind != 'lesson'
                              ORDER BY score ASC, uses ASC, created_at ASC LIMIT 1)""")
            row = {"id": str(uuid.uuid4()), "content": content, "kind": kind, "source": source,
                   "score": 1 if source == "user" else 0, "uses": 0, "created_at": _now(), "last_used_at": None}
            db.execute("""INSERT INTO memories VALUES (:id,:content,:kind,:source,:score,:uses,:created_at,:last_used_at)""", row)
        return row

    def update_memory(self, memory_id: str, content: str) -> bool:
        content = re.sub(r"\s+", " ", content or "").strip()
        if not 3 <= len(content) <= 500:
            raise AssistantError("invalid_memory")
        with self.store._session() as db:
            return db.execute("UPDATE memories SET content = ? WHERE id = ?", (content, memory_id)).rowcount > 0

    def delete_memory(self, memory_id: str) -> bool:
        with self.store._session() as db:
            return db.execute("DELETE FROM memories WHERE id = ?", (memory_id,)).rowcount > 0

    def relevant_memories(self, query: str, budget: int = 3000) -> list[dict]:
        query_words = stems(query)
        ranked = []
        for memory in self.list_memories():
            overlap = len(query_words & stems(memory["content"]))
            always = memory["kind"] in ("lesson", "preference")
            priority = (2 if always else 0) + overlap * 3 + max(-3, min(5, memory["score"])) + min(memory["uses"], 20) / 10
            if always or overlap or memory["score"] > 1:
                ranked.append((priority, memory))
        ranked.sort(key=lambda item: -item[0])
        chosen, used = [], 0
        for _, memory in ranked:
            if used + len(memory["content"]) > budget:
                continue
            chosen.append(memory)
            used += len(memory["content"])
        return chosen

    # ---- runs (streaming answers) -------------------------------------
    _runs: dict[str, Run]

    def start_run(self, payload: dict) -> dict:
        """Validate, then answer in a background thread; the UI polls events."""
        self._validate(payload)
        runs = self.__dict__.setdefault("_runs", {})
        now = time.time()
        for run_id in [k for k, r in runs.items() if r.done and now - r.created > 600]:
            runs.pop(run_id, None)
        run = Run()
        runs[run.id] = run

        def work():
            try:
                run.result = self.chat(payload, run=run)
            except AssistantError as error:
                diagnostics.record("chat_error", error.code)
                run.error = {"error": error.code, "status": error.status}
            except Exception as error:  # never leave the UI waiting forever
                diagnostics.record("chat_crash", type(error).__name__, error)
                run.error = {"error": "internal_error", "status": 500}
            finally:
                run.done = True

        if self.background:
            threading.Thread(target=work, name="malenia-run", daemon=True).start()
        else:
            work()
        return {"run_id": run.id}

    def poll_run(self, run_id: str, after: int = 0) -> dict | None:
        run = self.__dict__.get("_runs", {}).get(run_id)
        return run.poll(max(0, after)) if run else None

    def cancel_run(self, run_id: str) -> bool:
        run = self.__dict__.get("_runs", {}).get(run_id)
        if run is None:
            return False
        run.cancel.set()
        return True

    @staticmethod
    def _validate(payload: dict) -> None:
        if not isinstance(payload, dict):
            raise AssistantError("invalid_chat_request")
        if payload.get("regenerate"):
            if not isinstance(payload.get("conversation_id"), str):
                raise AssistantError("invalid_chat_request")
            return
        text = payload.get("message")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_MESSAGE:
            raise AssistantError("invalid_message")

    # ---- chat -----------------------------------------------------------
    def chat(self, payload: dict, run: Run | None = None) -> dict:
        self._validate(payload)
        emit = run.emit if run is not None else (lambda *a, **k: None)
        regenerate = bool(payload.get("regenerate"))
        text = payload.get("message") if not regenerate else ""
        private = bool(payload.get("private", False))
        allow_web = payload.get("use_web")
        config = self.router.config()
        allow_web = config.get("auto_web", True) if allow_web is None else bool(allow_web)
        instruction = payload.get("instruction")
        if instruction is not None and (not isinstance(instruction, str) or len(instruction) > 4000):
            raise AssistantError("invalid_instruction")
        try:
            file_text, images, files_meta = prepare_attachments(payload.get("attachments"))
        except AttachmentError as error:
            raise AssistantError(str(error)) from None
        model_text = text.strip() + file_text

        conversation_id = payload.get("conversation_id")
        with self.store._session() as db:
            if conversation_id:
                if not db.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                    raise AssistantError("conversation_not_found", 404)
                edit_id = payload.get("edit_message_id")
                if regenerate:
                    last = db.execute("""SELECT rowid, * FROM chat_messages WHERE conversation_id = ? AND role = 'user'
                                         ORDER BY created_at DESC, rowid DESC LIMIT 1""", (conversation_id,)).fetchone()
                    if last is None:
                        raise AssistantError("nothing_to_regenerate")
                    self._truncate(db, conversation_id, last, inclusive=False)
                    user_message = self._message(dict(last))
                    user_message.pop("rowid", None)
                    text = user_message["content"]
                    model_text = user_message["meta"].get("model_content") or text
                elif edit_id:
                    edited = db.execute("SELECT rowid, * FROM chat_messages WHERE id = ? AND conversation_id = ? AND role = 'user'",
                                        (edit_id, conversation_id)).fetchone()
                    if edited is None:
                        raise AssistantError("message_not_found", 404)
                    self._truncate(db, conversation_id, edited, inclusive=True)
            else:
                conversation_id = str(uuid.uuid4())
                title = re.sub(r"\s+", " ", text).strip()[:60]
                project_id = payload.get("project_id") if isinstance(payload.get("project_id"), str) else None
                if project_id and not db.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
                    project_id = None
                db.execute("INSERT INTO conversations (id, title, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?)",
                           (conversation_id, title, _now(), _now(), project_id))
            history = []
            for row in db.execute(
                    "SELECT role, content, meta FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30",
                    (conversation_id,)):
                try:
                    stored = json.loads(row["meta"] or "{}").get("model_content")
                except ValueError:
                    stored = None
                history.append({"role": row["role"], "content": stored or row["content"]})
            history.reverse()
            total = db.execute("SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?", (conversation_id,)).fetchone()[0]
            summary_row = db.execute("SELECT summary, summary_upto FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            summary = (summary_row["summary"] or "") if summary_row else ""
            summary_upto = (summary_row["summary_upto"] or 0) if summary_row else 0
            if regenerate:
                history = history[:-1]  # the repeated question itself
            else:
                user_meta = {"attachments": files_meta} if files_meta else {}
                if file_text:
                    user_meta["model_content"] = model_text
                user_message = self._add_message(db, conversation_id, "user", text.strip(), meta=user_meta)
        emit("started", conversation_id=conversation_id, user_message=user_message)

        memories = self.relevant_memories(text)
        system = SYSTEM_PROMPT.format(today=datetime.now().strftime("%d.%m.%Y, %A"))
        if memories:
            system += "\n\nЧто ты знаешь о пользователе (учитывай, но не пересказывай без повода):\n" + "\n".join(
                f"- [{m['kind']}] {m['content']}" for m in memories)
        with self.store._session() as db:
            row = db.execute("""SELECT p.name, p.instructions, p.kb_scope FROM conversations c
                                JOIN projects p ON p.id = c.project_id WHERE c.id = ?""", (conversation_id,)).fetchone()
        project = dict(row) if row else None
        if project:
            system += f"\n\nЭтот разговор — в проекте «{project['name']}»."
            if project["instructions"]:
                system += " Инструкции проекта (следуй им во всех ответах этого проекта):\n" + project["instructions"]
        if self.toolbox is not None and getattr(self.toolbox, "browser", None) is not None:
            try:
                tabs = self.store.list_browser_tabs(8)
            except Exception:
                tabs = []
            if tabs:
                system += "\n\nРабочие вкладки пользователя (адреса для browser_open):\n" + "\n".join(
                    f"- {t['title'][:80]} — {t['url'][:200]}" for t in tabs)
        vault = getattr(self.toolbox, "vault", None) if self.toolbox is not None else None
        knowledge_used = vault.context_for(text, scope=(project or {}).get("kb_scope") or None) if vault is not None else []
        if knowledge_used:
            system += ("\n\nФрагменты из базы знаний пользователя, которые могут относиться к задаче. Это опыт и проверенные "
                       "маршруты: пойми их смысл и применяй с учётом ситуации; если фрагмента мало — открой документ через "
                       "read_knowledge_document:\n" + "\n\n".join(
                           f"[{item['path']} › {item['heading']}]\n{item['content']}" for item in knowledge_used))
        skills = []
        if self.skills is not None:
            try:
                skills = self.skills.matching(text)
            except Exception:
                skills = []
        if skills:
            system += "\n\nУтверждённые пользователем инструкции для похожих задач (это порядок работы, а не факты):\n" + \
                json.dumps(skills, ensure_ascii=False)
        if instruction:
            system += "\n\nВ этом сообщении пользователь попросил следовать инструкции:\n" + instruction.strip()
        if summary and total > len(history) + 1:
            system += ("\n\nКраткое содержание начала этого разговора (старые сообщения не показаны целиком):\n" + summary)

        budget = 12000 if private else 120000
        kept, used = [], len(model_text)
        for message in reversed(history):
            if used + len(message["content"]) > budget:
                break
            kept.insert(0, {"role": message["role"], "content": message["content"]})
            used += len(message["content"])
        user_content: Any = model_text
        if images:
            user_content = [{"type": "text", "text": model_text}] + images
        messages = [{"role": "system", "content": system}] + kept + [{"role": "user", "content": user_content}]

        tools = [t for t in TOOLS if allow_web or t["function"]["name"] != "web_search"]
        if self.toolbox is not None:
            tools += self.toolbox.specs()
        sources: list[dict] = []
        learned: list[dict] = []
        actions: list[dict] = []
        skills_learned: list[dict] = []
        result = None
        steps: list[dict] = []
        nudges = 0
        stopped = False
        stream = {"on_delta": (lambda piece: emit("delta", text=piece)), "cancel": run.cancel} if run is not None else {}
        try:
            for round_index in range(MAX_ROUNDS + 1):
                if run is not None and run.cancel.is_set():
                    raise Cancelled()
                emit("status", text="Думаю…" if round_index == 0 else "Обдумываю результаты…")
                _shrink_tool_outputs(messages, budget=int(getattr(getattr(self.router, "ollama", None), "num_ctx", 16384) * 2.2))
                last_round = round_index == MAX_ROUNDS
                result = self.router.chat(messages, tools=None if last_round else tools, private=private,
                                          max_tokens=4096, needs_vision=bool(images), **stream)
                if not last_round and not result.tool_calls and tools and nudges < 2:
                    nudge = _needs_nudge(result.content or "", steps)
                    if nudge:
                        nudges += 1
                        emit("reset")
                        emit("status", text="Проверяю себя…")
                        messages.append({"role": "assistant", "content": result.content or ""})
                        messages.append({"role": "user", "content": nudge})
                        continue
                if last_round or not result.tool_calls:
                    break
                emit("reset")
                messages.append({"role": "assistant", "content": result.content or "", "tool_calls": [
                    {"id": c["id"], "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)}}
                    for c in result.tool_calls]})
                for call in result.tool_calls:
                    if run is not None and run.cancel.is_set():
                        raise Cancelled()
                    step = {"id": str(uuid.uuid4())[:8], "tool": call["name"],
                            "label": step_label(call["name"], call.get("arguments") or {}), "status": "running"}
                    emit("step", **step)
                    output = self._run_tool(call, allow_web, sources, learned, conversation_id, actions, skills_learned)
                    step["status"] = "error" if output.startswith(("Ошибка", "Инструмент недоступен")) else "done"
                    emit("step", **step)
                    steps.append(step)
                    messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"],
                                     "content": output})
        except Cancelled:
            stopped = True
        except ProviderError as error:
            diagnostics.record("model_error", f"{error.code}: {error.detail}")
            if not regenerate:
                with self.store._session() as db:
                    db.execute("DELETE FROM chat_messages WHERE id = ?", (user_message["id"],))
                    if not history:
                        db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            raise AssistantError(f"ai_{error.code}", 503 if error.code != "invalid_key" else 401) from None

        if stopped:
            partial = (run.text if run is not None else "").strip()
            answer = partial or "_Ответ остановлен._"
            provider_id = result.provider if result else None
            model_id = result.model if result else None
        else:
            answer = (result.content or "").strip() or "Не удалось сформулировать ответ. Попробуйте переформулировать вопрос."
            provider_id, model_id = result.provider, result.model
        meta = {"steps": steps, "stopped": stopped,"knowledge": [{"path": k["path"], "heading": k["heading"]} for k in knowledge_used],
                "sources": sources, "memory_ids": [m["id"] for m in memories],
                "skill_ids": [s["id"] for s in skills], "learned": learned, "private": private,
                "actions": actions, "skills_learned": skills_learned}
        with self.store._session() as db:
            reply = self._add_message(db, conversation_id, "assistant", answer, provider_id, model_id, meta)
            if memories:
                db.executemany("UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id = ?",
                               [(_now(), m["id"]) for m in memories])
        if self.toolbox is not None and actions:
            self.toolbox.attach([a["id"] for a in actions], reply["id"])

        if not stopped and total + 2 - summary_upto > COMPRESS_AFTER:
            if self.background:
                threading.Thread(target=self._compress, args=(conversation_id, private), daemon=True).start()
            else:
                self._compress(conversation_id, private)

        if not stopped and not regenerate and config.get("learning", True) and PERSONAL_SIGNALS.search(text) and not learned:
            if self.background:
                threading.Thread(target=self._reflect, args=(text, answer, private), daemon=True).start()
            else:
                self._reflect(text, answer, private)

        return {"conversation_id": conversation_id, "user_message": user_message, "message": reply,
                "provider": provider_id, "model": model_id}

    def _run_tool(self, call: dict, allow_web: bool, sources: list, learned: list,
                  conversation_id: str = "", actions: list | None = None, skills_learned: list | None = None) -> str:
        name, args = call["name"], call.get("arguments") or {}
        if self.toolbox is not None and name in self.toolbox.tools:
            outcome = self.toolbox.run(name, args, conversation_id)
            if outcome["status"] == "done":
                if isinstance(outcome["result"], dict) and "learned_skill" in outcome["result"] and skills_learned is not None:
                    skills_learned.append(outcome["result"]["learned_skill"])
                return json.dumps(outcome["result"], ensure_ascii=False, default=str)[:20000]
            if outcome["status"] == "error":
                return "Ошибка: " + outcome["error"]
            if actions is not None:
                actions.append(outcome["action"])
            if outcome["status"] == "pending":
                return ("Действие подготовлено и ждёт подтверждения пользователя (кнопка «Выполнить» под ответом): "
                        + outcome["action"]["summary"] + ". Не говори, что оно уже выполнено.")
            return "Приложение открыло: " + outcome["action"]["summary"]
        try:
            if name == "web_search" and allow_web:
                query = str(args.get("query") or "")[:300]
                found = self.web.search(query)[:6]
                for item in found:
                    if item.get("url") and all(s.get("url") != item["url"] for s in sources):
                        sources.append({"title": item.get("title", ""), "url": item["url"]})
                return json.dumps(found, ensure_ascii=False)[:6000] or "Ничего не найдено"
            if name == "remember":
                kind = args.get("kind") if args.get("kind") in MEMORY_KINDS else "fact"
                saved = self.add_memory(str(args.get("content") or ""), kind, "assistant")
                if saved:
                    learned.append({"id": saved["id"], "content": saved["content"]})
                return "Сохранено" if saved else "Уже было известно или содержит секреты — не сохранено"
            if name == "search_notes" and self.knowledge is not None:
                found = self.knowledge.retrieve(str(args.get("query") or "")[:500])
                return json.dumps(found, ensure_ascii=False)[:6000] if found else "В заметках ничего не найдено"
        except (WebError, KnowledgeError, AssistantError) as error:
            return f"Ошибка инструмента: {error}"
        return "Инструмент недоступен"

    def _compress(self, conversation_id: str, private: bool) -> None:
        """Fold old messages into a running summary so long chats stay coherent and fast."""
        try:
            with self.store._session() as db:
                row = db.execute("SELECT summary, summary_upto FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
                messages = [dict(r) for r in db.execute(
                    "SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                    (conversation_id,))]
            if row is None:
                return
            upto = max(0, len(messages) - KEEP_RECENT)
            older = messages[row["summary_upto"]:upto]
            if not older:
                return
            transcript = "\n".join(f"{'Пользователь' if m['role'] == 'user' else 'Маления'}: {m['content'][:1500]}" for m in older)
            prompt = [{"role": "system", "content": COMPRESS_PROMPT},
                      {"role": "user", "content": f"Текущее краткое содержание:\n{row['summary'] or '(пусто)'}\n\nНовые сообщения:\n{transcript[:24000]}"}]
            result = self.router.chat(prompt, private=private, max_tokens=900, temperature=0.2)
            summary = (result.content or "").strip()[:3000]
            if summary:
                with self.store._session() as db:
                    db.execute("UPDATE conversations SET summary = ?, summary_upto = ? WHERE id = ?",
                               (summary, upto, conversation_id))
        except Exception:
            pass  # a summary is an optimisation; never break the chat

    def _reflect(self, text: str, answer: str, private: bool) -> None:
        try:
            known = "\n".join(f"- {m['content']}" for m in self.list_memories()[:40]) or "(пока ничего)"
            result = self.router.chat([
                {"role": "system", "content": REFLECTION_PROMPT.format(known=known)},
                {"role": "user", "content": f"Пользователь: {text[:3000]}\n\nАссистент: {answer[:1500]}"},
            ], private=private, json_mode=True, max_tokens=600, temperature=0)
            match = re.search(r"\{.*\}", result.content, re.S)
            data = json.loads(match.group(0)) if match else {}
            for item in (data.get("memories") or [])[:5]:
                if isinstance(item, dict) and isinstance(item.get("content"), str):
                    kind = item.get("kind") if item.get("kind") in ("fact", "preference") else "fact"
                    try:
                        self.add_memory(item["content"], kind, "auto")
                    except AssistantError:
                        continue
        except (ProviderError, ValueError, TypeError, AttributeError):
            return

    # ---- feedback -------------------------------------------------------
    def feedback(self, message_id: str, rating: int, comment: str | None = None) -> dict:
        if rating not in (-1, 0, 1):
            raise AssistantError("invalid_feedback")
        if comment is not None and (not isinstance(comment, str) or len(comment) > 1000):
            raise AssistantError("invalid_feedback")
        with self.store._session() as db:
            row = db.execute("SELECT * FROM chat_messages WHERE id = ? AND role = 'assistant'", (message_id,)).fetchone()
            if row is None:
                raise AssistantError("message_not_found", 404)
            message = self._message(dict(row))
            delta = rating - message["feedback"]
            db.execute("UPDATE chat_messages SET feedback = ? WHERE id = ?", (rating, message_id))
            ids = message["meta"].get("memory_ids", [])
            if delta and ids:
                db.executemany("UPDATE memories SET score = score + ? WHERE id = ?", [(delta, i) for i in ids])
            question = db.execute("""SELECT content FROM chat_messages WHERE conversation_id = ? AND role = 'user'
                AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM chat_messages WHERE id = ?)))
                ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (message["conversation_id"], message["created_at"], message["created_at"], message_id)).fetchone()
        if self.skills is not None and delta:
            for skill_id in message["meta"].get("skill_ids", []):
                try:
                    self.skills.record_feedback(str(uuid.uuid4()), skill_id, rating > 0)
                except Exception:
                    pass
        lesson = None
        if rating < 0 and comment and comment.strip():
            topic = re.sub(r"\s+", " ", question["content"] if question else "").strip()[:120]
            lesson = self.add_memory(f"Когда пользователь просит «{topic}»: {comment.strip()}"[:500], "lesson", "feedback")
        return {"id": message_id, "feedback": rating, "lesson": lesson}
