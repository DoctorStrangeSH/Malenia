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
import uuid
from datetime import datetime
from typing import Any

from .knowledge import KnowledgeBase, KnowledgeError, words
from .providers import ModelRouter, ProviderError
from .store import TaskStore, _now
from .web import PublicSearch, WebError

MAX_MESSAGE = 16000
MAX_MEMORIES = 500
MEMORY_KINDS = {"fact", "preference", "lesson"}

SYSTEM_PROMPT = """Ты — Шерлок, персональный ИИ-ассистент в приложении «Маления».
Помогаешь пользователю с любыми задачами: работа, учёба, тексты, письма, планирование, код, расчёты, советы, быт.
Отвечай на языке пользователя (по умолчанию по-русски), по делу, структурированно, без воды. Используй Markdown, когда это помогает.
Если для ответа нужны свежие данные (новости, цены, курсы, расписания, факты после твоего обучения) — используй инструмент web_search.
Если пользователь сообщает о себе что-то долговременное (имя, должность, предпочтения, правила работы) или просит запомнить — вызови remember.
Если вопрос может касаться заметок или документов пользователя — используй search_notes.
Не выдумывай факты и не утверждай, что выполнил действие, если не выполнял. Если чего-то не знаешь — скажи прямо.
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


class Assistant:
    def __init__(self, store: TaskStore, router: ModelRouter, knowledge: KnowledgeBase | None = None,
                 skills=None, web: PublicSearch | None = None, background: bool = True):
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
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL,
                    source TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, last_used_at TEXT);
            """)

    # ---- conversations --------------------------------------------------
    def list_conversations(self, limit: int = 100) -> list[dict]:
        with self.store._session() as db:
            return [dict(r) for r in db.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?", (limit,))]

    def get_conversation(self, conversation_id: str) -> dict | None:
        with self.store._session() as db:
            row = db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row is None:
                return None
            messages = [self._message(dict(m)) for m in db.execute(
                "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                (conversation_id,))]
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
        title = (title or "").strip()[:120]
        if not title:
            raise AssistantError("invalid_title")
        with self.store._session() as db:
            return db.execute("UPDATE conversations SET title = ? WHERE id = ?",
                              (title, conversation_id)).rowcount > 0

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

    # ---- chat -----------------------------------------------------------
    def chat(self, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise AssistantError("invalid_chat_request")
        text = payload.get("message")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_MESSAGE:
            raise AssistantError("invalid_message")
        private = bool(payload.get("private", False))
        allow_web = payload.get("use_web")
        config = self.router.config()
        allow_web = config.get("auto_web", True) if allow_web is None else bool(allow_web)
        instruction = payload.get("instruction")
        if instruction is not None and (not isinstance(instruction, str) or len(instruction) > 4000):
            raise AssistantError("invalid_instruction")

        conversation_id = payload.get("conversation_id")
        with self.store._session() as db:
            if conversation_id:
                if not db.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone():
                    raise AssistantError("conversation_not_found", 404)
            else:
                conversation_id = str(uuid.uuid4())
                title = re.sub(r"\s+", " ", text).strip()[:60]
                db.execute("INSERT INTO conversations VALUES (?, ?, ?, ?)", (conversation_id, title, _now(), _now()))
            history = [dict(r) for r in db.execute(
                "SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30",
                (conversation_id,))][::-1]
            user_message = self._add_message(db, conversation_id, "user", text.strip())

        memories = self.relevant_memories(text)
        system = SYSTEM_PROMPT.format(today=datetime.now().strftime("%d.%m.%Y, %A"))
        if memories:
            system += "\n\nЧто ты знаешь о пользователе (учитывай, но не пересказывай без повода):\n" + "\n".join(
                f"- [{m['kind']}] {m['content']}" for m in memories)
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

        budget = 6000 if private else 40000
        kept, used = [], len(text)
        for message in reversed(history):
            if used + len(message["content"]) > budget:
                break
            kept.insert(0, {"role": message["role"], "content": message["content"]})
            used += len(message["content"])
        messages = [{"role": "system", "content": system}] + kept + [{"role": "user", "content": text.strip()}]

        tools = [t for t in TOOLS if allow_web or t["function"]["name"] != "web_search"]
        sources: list[dict] = []
        learned: list[dict] = []
        result = None
        try:
            for _ in range(5):
                result = self.router.chat(messages, tools=tools, private=private, max_tokens=4096)
                if not result.tool_calls:
                    break
                messages.append({"role": "assistant", "content": result.content or "", "tool_calls": [
                    {"id": c["id"], "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)}}
                    for c in result.tool_calls]})
                for call in result.tool_calls:
                    output = self._run_tool(call, allow_web, sources, learned)
                    messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"],
                                     "content": output})
            else:
                result = self.router.chat(messages, tools=None, private=private, max_tokens=4096)
        except ProviderError as error:
            with self.store._session() as db:
                db.execute("DELETE FROM chat_messages WHERE id = ?", (user_message["id"],))
                if not history:
                    db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            raise AssistantError(f"ai_{error.code}", 503 if error.code != "invalid_key" else 401) from None

        answer = (result.content or "").strip() or "Не удалось сформулировать ответ. Попробуйте переформулировать вопрос."
        meta = {"sources": sources, "memory_ids": [m["id"] for m in memories],
                "skill_ids": [s["id"] for s in skills], "learned": learned, "private": private}
        with self.store._session() as db:
            reply = self._add_message(db, conversation_id, "assistant", answer, result.provider, result.model, meta)
            if memories:
                db.executemany("UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id = ?",
                               [(_now(), m["id"]) for m in memories])

        if config.get("learning", True) and PERSONAL_SIGNALS.search(text) and not learned:
            if self.background:
                threading.Thread(target=self._reflect, args=(text, answer, private), daemon=True).start()
            else:
                self._reflect(text, answer, private)

        return {"conversation_id": conversation_id, "user_message": user_message, "message": reply,
                "provider": result.provider, "model": result.model}

    def _run_tool(self, call: dict, allow_web: bool, sources: list, learned: list) -> str:
        name, args = call["name"], call.get("arguments") or {}
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
