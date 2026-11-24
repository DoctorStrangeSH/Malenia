import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

from malenia.assistant import Assistant
from malenia.providers import ChatResult, ModelRouter, OllamaProvider, OpenAICompatibleProvider
from malenia.settings import MemorySecretStore, SettingsStore
from malenia.store import TaskStore


class StreamingProvider:
    """Streams scripted answers; a script item may be a ChatResult with tool calls."""

    def __init__(self, script):
        self.id = "ollama"
        self.script = list(script)
        self.seen = []
        self.gate = None

    def list_models(self):
        return ["qwen3:4b"]

    def capabilities(self, model):
        return set()

    def chat(self, model, messages, tools=None, max_tokens=2048, temperature=0.4, json_mode=False,
             timeout=300, on_delta=None, cancel=None):
        self.seen.append(messages)
        item = self.script.pop(0) if self.script else ChatResult("ок")
        if isinstance(item, str):
            for word in item.split(" "):
                if self.gate is not None:
                    self.gate.wait(2)
                if cancel is not None and cancel.is_set():
                    from malenia.providers import Cancelled
                    raise Cancelled()
                if on_delta:
                    on_delta(word + " ")
            return ChatResult(item)
        return item


class RunBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "db.sqlite3")
        self.settings = SettingsStore(self.store)

    def tearDown(self):
        self.tmp.cleanup()

    def assistant(self, script, background=False):
        self.local = StreamingProvider(script)
        router = ModelRouter(self.settings, MemorySecretStore(), lambda: ["qwen3:4b"], lambda *a: None, self.local)
        router.save_config({**router.config(), "mode": "local"})
        return Assistant(self.store, router, background=background)


class RunTests(RunBase):
    def test_answer_streams_with_visible_steps(self):
        tool = ChatResult("", tool_calls=[{"id": "c1", "name": "remember", "arguments": {"content": "Пользователь любит кофе"}}])
        assistant = self.assistant([tool, "Готово , запомнила"])
        run = assistant.start_run({"message": "Запомни: я люблю кофе"})
        state = assistant.poll_run(run["run_id"])
        self.assertTrue(state["done"])
        types = [e["type"] for e in state["events"]]
        self.assertEqual(types[0], "started")
        self.assertIn("step", types)
        text = "".join(e["text"] for e in state["events"] if e["type"] == "delta")
        self.assertEqual(text.strip(), "Готово , запомнила")
        steps = [e for e in state["events"] if e["type"] == "step"]
        self.assertEqual(steps[-1]["status"], "done")
        self.assertIn("Запоминаю", steps[-1]["label"])
        meta = state["result"]["message"]["meta"]
        self.assertEqual(meta["steps"][0]["tool"], "remember")
        self.assertEqual(assistant.poll_run(run["run_id"], state["next"])["events"], [])

    def test_stop_keeps_partial_answer(self):
        assistant = self.assistant(["раз два три четыре пять"], background=True)
        self.local.script = ["раз два три четыре пять"]
        gate = threading.Event()
        self.local.gate = gate
        run = assistant.start_run({"message": "Посчитай"})
        assistant.cancel_run(run["run_id"])
        gate.set()
        for _ in range(100):
            state = assistant.poll_run(run["run_id"])
            if state["done"]:
                break
            threading.Event().wait(0.02)
        self.assertTrue(state["done"])
        message = state["result"]["message"]
        self.assertTrue(message["meta"]["stopped"])

    def test_regenerate_and_edit(self):
        assistant = self.assistant(["первый", "второй", "третий"])
        first = assistant.chat({"message": "Вопрос"})
        cid = first["conversation_id"]
        again = assistant.chat({"conversation_id": cid, "regenerate": True})
        messages = assistant.get_conversation(cid)["messages"]
        self.assertEqual([m["content"] for m in messages], ["Вопрос", "второй"])
        self.assertEqual(again["user_message"]["id"], first["user_message"]["id"])
        # the repeated question is sent once, not twice
        self.assertEqual(sum(1 for m in self.local.seen[-1] if m["role"] == "user"), 1)
        assistant.chat({"conversation_id": cid, "message": "Другой вопрос", "edit_message_id": first["user_message"]["id"]})
        messages = assistant.get_conversation(cid)["messages"]
        self.assertEqual([m["content"] for m in messages], ["Другой вопрос", "третий"])

    def test_invalid_run_is_rejected_synchronously(self):
        assistant = self.assistant([])
        with self.assertRaises(Exception):
            assistant.start_run({"message": ""})


class FakeStream(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Opener:
    def __init__(self, body):
        self.body = body
        self.requests = []

    def open(self, request, timeout=0):
        self.requests.append(json.loads(request.data))
        return FakeStream(self.body)


class ProviderStreamingTests(unittest.TestCase):
    def test_openai_sse_text_and_tool_calls(self):
        events = [
            {"choices": [{"delta": {"content": "При"}}]},
            {"choices": [{"delta": {"content": "вет"}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "x", "function": {"name": "calc", "arguments": "{\"a\":"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "1}"}}]}}]},
        ]
        body = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
        opener = Opener(body.encode())
        pieces = []
        result = OpenAICompatibleProvider("groq", "https://x/v1", "k", opener).chat("m", [{"role": "user", "content": "hi"}], on_delta=pieces.append)
        self.assertEqual(pieces, ["При", "вет"])
        self.assertEqual(result.content, "Привет")
        self.assertEqual(result.tool_calls, [{"id": "x", "name": "calc", "arguments": {"a": 1}}])
        self.assertTrue(opener.requests[0]["stream"])

    def test_ollama_ndjson(self):
        lines = [{"message": {"content": "Да"}}, {"message": {"content": "!"}},
                 {"message": {"content": "", "tool_calls": [{"function": {"name": "calc", "arguments": {"a": 2}}}]}, "done": True}]
        opener = Opener("\n".join(json.dumps(l) for l in lines).encode())
        pieces = []
        result = OllamaProvider("http://127.0.0.1:11434", opener).chat("qwen3:4b", [{"role": "user", "content": "x"}], on_delta=pieces.append)
        self.assertEqual(result.content, "Да!")
        self.assertEqual(result.tool_calls[0]["name"], "calc")
        self.assertEqual(opener.requests[0]["keep_alive"], "30m")


if __name__ == "__main__":
    unittest.main()


class ProjectAndSearchTests(RunBase):
    def test_projects_scope_instructions_and_search(self):
        assistant = self.assistant(["Готово", "Второй ответ"])
        project = assistant.save_project({"name": "Инвентаризация", "instructions": "Отвечай таблицей", "kb_scope": "05-Операционные-инструкции/"})
        reply = assistant.chat({"message": "Проверь заказ 123", "project_id": project["id"]})
        system = self.local.seen[-1][0]["content"]
        self.assertIn("Инвентаризация", system)
        self.assertIn("Отвечай таблицей", system)
        other = assistant.chat({"message": "Рецепт борща"})
        items = assistant.list_conversations(project_id=project["id"])
        self.assertEqual([c["id"] for c in items], [reply["conversation_id"]])
        found = assistant.list_conversations(query="борщ")
        self.assertEqual([c["id"] for c in found], [other["conversation_id"]])
        self.assertIn("борщ", found[0]["snippet"])
        assistant.update_conversation(reply["conversation_id"], {"pinned": True, "title": "Заказ 123"})
        first = assistant.list_conversations()[0]
        self.assertEqual((first["id"], first["pinned"], first["title"]), (reply["conversation_id"], True, "Заказ 123"))
        self.assertEqual(assistant.list_projects()[0]["conversations"], 1)
        assistant.delete_project(project["id"])
        self.assertIsNone(assistant.list_conversations()[0]["project_id"])
