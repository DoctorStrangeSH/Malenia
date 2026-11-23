"""Make Sherlock *your* model.

Two levels:
1. Personal model (instant, no GPU): an Ollama model built on an open base
   model (Qwen/Gemma) with your memories, lessons and skills baked into it.
2. Fine-tuning (needs an NVIDIA GPU or free Google Colab): export your
   conversations as a training set and run training/train_sherlock.py; the
   result is imported back into Ollama as "sherlock".
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

from .assistant import SYSTEM_PROMPT, Assistant
from .config import data_directory
from .providers import OLLAMA_URL, ProviderError, _post_json

PERSONAL_MODEL = "sherlock-personal"


def persona(assistant: Assistant) -> str:
    system = SYSTEM_PROMPT.replace("\nСегодня {today}.", "")
    memories = assistant.list_memories()[:80]
    if memories:
        system += "\n\nЧто ты знаешь о пользователе:\n" + "\n".join(f"- [{m['kind']}] {m['content']}" for m in memories)
    skills = [s for s in (assistant.skills.list() if assistant.skills else []) if s["status"] == "approved" and not s.get("builtin")][:30]
    if skills:
        system += "\n\nНавыки, которым тебя научил пользователь:\n" + "\n".join(
            f"### {s['title']} (когда: {s['terms']})\n{s['instructions']}" for s in skills)
    return system


def stats(assistant: Assistant) -> dict:
    with assistant.store._session() as db:
        row = db.execute("""SELECT
            (SELECT COUNT(*) FROM conversations) AS conversations,
            (SELECT COUNT(*) FROM chat_messages WHERE role='assistant') AS answers,
            (SELECT COUNT(*) FROM chat_messages WHERE role='assistant' AND feedback > 0) AS liked,
            (SELECT COUNT(*) FROM chat_messages WHERE role='assistant' AND feedback < 0) AS disliked,
            (SELECT COUNT(*) FROM memories) AS memories,
            (SELECT COUNT(*) FROM memories WHERE kind='lesson') AS lessons""").fetchone()
    result = dict(row)
    result["skills"] = len([s for s in (assistant.skills.list() if assistant.skills else []) if not s.get("builtin")])
    result["ready_for_finetune"] = result["answers"] - result["disliked"] >= 200
    return result


def export_dataset(assistant: Assistant, folder: Path | None = None) -> dict:
    """Write chat examples (OpenAI "messages" JSONL) the user did not reject."""
    system = persona(assistant)
    folder = folder or data_directory() / "training"
    folder.mkdir(parents=True, exist_ok=True)
    examples = 0
    path = folder / f"sherlock-{datetime.now():%Y%m%d-%H%M}.jsonl"
    with assistant.store._session() as db:
        conversations = [r["id"] for r in db.execute("SELECT id FROM conversations ORDER BY created_at")]
        with path.open("w", encoding="utf-8") as out:
            for conversation_id in conversations:
                rows = [dict(r) for r in db.execute(
                    "SELECT role, content, feedback, meta FROM chat_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                    (conversation_id,))]
                history: list[dict] = []
                for row in rows:
                    try:
                        meta = json.loads(row["meta"] or "{}")
                    except ValueError:
                        meta = {}
                    content = meta.get("model_content") or row["content"]
                    if row["role"] == "assistant" and row["feedback"] >= 0 and history and history[-1]["role"] == "user":
                        sample = {"messages": [{"role": "system", "content": system}] + history[-6:] +
                                  [{"role": "assistant", "content": content}]}
                        repeats = 2 if row["feedback"] > 0 else 1  # liked answers count double
                        for _ in range(repeats):
                            out.write(json.dumps(sample, ensure_ascii=False) + "\n")
                            examples += 1
                    if row["role"] == "assistant" and row["feedback"] < 0 and history and history[-1]["role"] == "user":
                        history.pop()  # don't teach the rejected answer
                        continue
                    history.append({"role": row["role"], "content": content[:8000]})
    return {"path": str(path), "examples": examples, "conversations": len(conversations)}


def create_personal_model(assistant: Assistant, base: str, opener=None, base_url: str = OLLAMA_URL) -> dict:
    if not isinstance(base, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]{0,100}", base) or base.startswith(PERSONAL_MODEL):
        raise ProviderError("bad_request", "invalid base model")
    opener = opener or build_opener(ProxyHandler({}))
    body = {"model": PERSONAL_MODEL, "from": base, "system": persona(assistant),
            "parameters": {"temperature": 0.4, "num_ctx": 8192}, "stream": False}
    result = _post_json(opener, base_url + "/api/create", body, {}, 600)
    if result.get("error"):
        raise ProviderError("unavailable", str(result["error"])[:200])
    return {"model": PERSONAL_MODEL + ":latest", "base": base}

