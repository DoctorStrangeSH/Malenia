import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError

from malenia.assistant import Assistant, AssistantError
from malenia.assistant_api import AssistantServices
from malenia.hardware import recommend
from malenia.lan import LanServer
from malenia.providers import PRESETS, ChatResult, ModelRouter, ProviderError, rank_models
from malenia.resources import ResourceManager
from malenia.server import make_handler
from malenia.settings import FileSecretStore, MemorySecretStore, SettingsStore
from malenia.store import TaskStore


class FakeProvider:
    def __init__(self, provider_id, script=None, models=None, error=None):
        self.id = provider_id
        self.script = list(script or [])
        self._models = models or ["model-a"]
        self.error = error
        self.calls = []

    def list_models(self):
        if self.error:
            raise ProviderError(self.error)
        return list(self._models)

    def chat(self, model, messages, tools=None, **options):
        self.calls.append({"model": model, "messages": messages, "tools": tools, "options": options})
        if self.error:
            raise ProviderError(self.error)
        item = self.script.pop(0) if self.script else ChatResult("ок")
        return item


class FakeWeb:
    def __init__(self):
        self.queries = []

    def search(self, query):
        self.queries.append(query)
        return [{"id": "web-1", "title": "Курс", "url": "https://example.com/rate", "excerpt": "90 рублей"}]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "db.sqlite3")
        self.settings = SettingsStore(self.store)
        self.secrets = MemorySecretStore()
        self.providers = {}

        def factory(pid, url, key):
            return self.providers.setdefault(pid, FakeProvider(pid))

        self.local = FakeProvider("ollama", models=["qwen3:4b"])
        self.router = ModelRouter(self.settings, self.secrets, lambda: ["qwen3:4b"], factory, self.local)

    def tearDown(self):
        self.tmp.cleanup()


class ProviderTests(Base):
    def test_rank_models_prefers_newest_full_flash(self):
        models = ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.8-flash-image",
                  "text-embedding-004", "gemini-3.9-flash-preview", "gemma-4-31b-it"]
        ranked = rank_models(models, PRESETS["gemini"])
        self.assertEqual(ranked[0], "gemini-3.8-flash")
        self.assertNotIn("gemini-3.8-flash-lite", ranked)
        self.assertNotIn("text-embedding-004", ranked)

    def test_openrouter_only_free(self):
        ranked = rank_models(["openai/gpt-5", "deepseek/deepseek-v4:free", "meta/llama-4:free"], PRESETS["openrouter"])
        self.assertEqual(ranked, ["deepseek/deepseek-v4:free", "meta/llama-4:free"])

    def test_key_is_stored_in_secret_store_and_never_described(self):
        self.router.update_provider("gemini", {"api_key": "AIzaSy-test-key-123"})
        self.assertEqual(self.secrets.values["ai.gemini"], "AIzaSy-test-key-123")
        description = json.dumps(self.router.describe())
        self.assertNotIn("AIzaSy", description)
        self.assertIn('"has_key": true', description)
        with self.assertRaises(ProviderError):
            self.router.update_provider("gemini", {"api_key": "bad key with spaces"})

    def test_fallback_to_next_provider_on_rate_limit(self):
        self.router.update_provider("gemini", {"api_key": "key-gemini-123"})
        self.router.update_provider("groq", {"api_key": "key-groq-1234"})
        self.providers["gemini"] = FakeProvider("gemini", error="rate_limited", models=["gemini-3.8-flash"])
        self.providers["groq"] = FakeProvider("groq", [ChatResult("ответ groq")], models=["openai/gpt-oss-120b"])
        self.providers["gemini"].list_models = lambda: ["gemini-3.8-flash"]
        result = self.router.chat([{"role": "user", "content": "привет"}])
        self.assertEqual((result.provider, result.content), ("groq", "ответ groq"))

    def test_private_mode_uses_only_local_and_own_server(self):
        self.router.update_provider("gemini", {"api_key": "key-gemini-123"})
        self.assertEqual(self.router.candidates(private=True), ["ollama"])
        self.router.update_provider("malenia", {"base_url": "http://192.168.1.5:8766", "api_key": "mln-pairing-key"})
        self.assertEqual(self.router.candidates(private=True), ["malenia", "ollama"])
        self.assertEqual(self.router.provider_config("malenia")["base_url"], "http://192.168.1.5:8766/v1")
        self.assertEqual(self.router.candidates()[0], "gemini")

    def test_tools_unsupported_retries_without_tools(self):
        class NoTools(FakeProvider):
            def chat(self, model, messages, tools=None, **options):
                if tools:
                    raise ProviderError("tools_unsupported")
                return ChatResult("без инструментов")
        self.router.ollama = NoTools("ollama", models=["qwen3:4b"])
        result = self.router.chat([{"role": "user", "content": "x"}], tools=[{"type": "function"}], private=True)
        self.assertEqual(result.content, "без инструментов")

    def test_local_model_follows_hardware_recommendation(self):
        self.local._models = ["llama3.2:3b", "qwen3:4b"]
        self.assertEqual(self.router.model_for("ollama"), "qwen3:4b")

    def test_file_secret_store_is_user_only(self):
        path = Path(self.tmp.name) / "secrets.json"
        store = FileSecretStore(path)
        store.set("ai.groq", "abc12345")
        self.assertEqual(store.get("ai.groq"), "abc12345")
        if os.name != "nt":
            self.assertEqual(path.stat().st_mode & 0o077, 0)
        self.assertTrue(store.delete("ai.groq"))


class HardwareTests(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(recommend(16, 0)["tier"], "cpu-16")
        self.assertTrue(recommend(16, 0)["note"])
        self.assertEqual(recommend(32, 0)["tier"], "cpu-32")
        self.assertEqual(recommend(32, 12)["tier"], "gpu-8-ram")
        self.assertEqual(recommend(16, 8)["tier"], "gpu-8")
        self.assertEqual(recommend(64, 24)["tier"], "gpu-24")
        self.assertEqual(recommend(4, 0)["tier"], "tiny")


class AssistantTests(Base):
    def make(self, script, web=None):
        self.local.script = list(script)
        return Assistant(self.store, self.router, web=web or FakeWeb(), background=False)

    def test_conversation_is_persisted_with_history(self):
        assistant = self.make([ChatResult("Привет!"), ChatResult("Помню.")])
        first = assistant.chat({"message": "Привет", "private": True})
        second = assistant.chat({"message": "Что я сказал?", "conversation_id": first["conversation_id"], "private": True})
        sent = self.local.calls[1]["messages"]
        self.assertEqual([m["role"] for m in sent], ["system", "user", "assistant", "user"])
        conversation = assistant.get_conversation(second["conversation_id"])
        self.assertEqual([m["content"] for m in conversation["messages"]], ["Привет", "Привет!", "Что я сказал?", "Помню."])
        self.assertEqual(assistant.list_conversations()[0]["title"], "Привет")

    def test_remember_tool_saves_memory_and_it_is_used_next_time(self):
        assistant = self.make([
            ChatResult("", [{"id": "1", "name": "remember", "arguments": {"content": "Пользователя зовут Андрей", "kind": "fact"}}]),
            ChatResult("Запомнил, Андрей."),
            ChatResult("Андрей, вот ответ."),
        ])
        reply = assistant.chat({"message": "Запомни: меня зовут Андрей", "private": True})
        self.assertEqual(reply["message"]["meta"]["learned"][0]["content"], "Пользователя зовут Андрей")
        assistant.chat({"message": "Как меня зовут Андрей?", "private": True})
        self.assertIn("Андрей", self.local.calls[-1]["messages"][0]["content"])

    def test_web_search_tool_collects_sources(self):
        web = FakeWeb()
        assistant = self.make([
            ChatResult("", [{"id": "1", "name": "web_search", "arguments": {"query": "курс доллара"}}]),
            ChatResult("Курс 90 рублей."),
        ], web)
        reply = assistant.chat({"message": "Какой курс доллара?", "private": True})
        self.assertEqual(web.queries, ["курс доллара"])
        self.assertEqual(reply["message"]["meta"]["sources"][0]["url"], "https://example.com/rate")

    def test_web_tool_hidden_when_disabled(self):
        assistant = self.make([ChatResult("ок")])
        assistant.chat({"message": "вопрос", "private": True, "use_web": False})
        names = [t["function"]["name"] for t in self.local.calls[-1]["tools"]]
        self.assertNotIn("web_search", names)

    def test_reflection_learns_preferences_but_not_secrets(self):
        assistant = self.make([
            ChatResult("Хорошо."),
            ChatResult(json.dumps({"memories": [
                {"content": "Предпочитает короткие ответы списком", "kind": "preference"},
                {"content": "Пароль пользователя qwerty", "kind": "fact"}]})),
        ])
        assistant.chat({"message": "Я люблю, когда ответы короткие и списком", "private": True})
        contents = [m["content"] for m in assistant.list_memories()]
        self.assertEqual(contents, ["Предпочитает короткие ответы списком"])

    def test_duplicate_memories_are_merged(self):
        assistant = self.make([])
        self.assertIsNotNone(assistant.add_memory("Работает в сортировочном центре", "fact"))
        self.assertIsNone(assistant.add_memory("Работает в сортировочном центре.", "fact"))
        self.assertEqual(len(assistant.list_memories()), 1)

    def test_negative_feedback_with_comment_becomes_lesson(self):
        assistant = self.make([ChatResult("Длинный ответ")])
        memory = assistant.add_memory("Работает с инвентаризацией", "fact")
        reply = assistant.chat({"message": "Расскажи про инвентаризацию", "private": True})
        result = assistant.feedback(reply["message"]["id"], -1, "Отвечай короче, без вступлений")
        self.assertEqual(result["lesson"]["kind"], "lesson")
        self.assertIn("Отвечай короче", result["lesson"]["content"])
        scores = {m["id"]: m["score"] for m in assistant.list_memories()}
        self.assertEqual(scores[memory["id"]], 0)

    def test_provider_failure_does_not_leave_orphan_messages(self):
        self.local.error = "unavailable"
        assistant = self.make([])
        with self.assertRaises(AssistantError) as caught:
            assistant.chat({"message": "привет", "private": True})
        self.assertEqual(caught.exception.code, "ai_unavailable")
        self.assertEqual(assistant.list_conversations(), [])


class LanServerTests(Base):
    def test_requires_key_and_serves_openai_chat(self):
        self.local.script = [ChatResult("ответ сервера")]
        lan = LanServer(self.settings, self.router)
        with ThreadingHTTPServer(("127.0.0.1", 0), lan._handler()) as httpd:
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            body = json.dumps({"model": "auto", "messages": [{"role": "user", "content": "hi"}]}).encode()
            with self.assertRaises(HTTPError) as denied:
                urllib.request.urlopen(urllib.request.Request(base + "/v1/chat/completions", data=body,
                                                              headers={"Authorization": "Bearer wrong"}), timeout=5)
            self.assertEqual(denied.exception.code, 401)
            request = urllib.request.Request(base + "/v1/chat/completions", data=body,
                                             headers={"Authorization": "Bearer " + lan.token(),
                                                      "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                data = json.loads(response.read())
            httpd.shutdown()
        self.assertEqual(data["choices"][0]["message"]["content"], "ответ сервера")
        self.assertEqual(data["model"], "qwen3:4b")

    def test_status_and_rotation(self):
        lan = LanServer(self.settings, self.router)
        first = lan.token()
        self.assertTrue(first.startswith("mln-"))
        self.assertNotEqual(lan.rotate_token(), first)
        self.assertFalse(lan.status()["running"])
        with self.assertRaises(ValueError):
            lan.configure(True, 8765)


class ApiTests(Base):
    def test_chat_route_through_authenticated_api(self):
        self.local.script = [ChatResult("Готово")]
        services = AssistantServices(self.store, router=self.router, web=FakeWeb(), background=False,
                                     hardware_profile=lambda refresh=False: {"recommendation": {"models": ["qwen3:4b"]}})
        handler = make_handler(self.store, "token", ResourceManager(), services=services)
        with ThreadingHTTPServer(("127.0.0.1", 0), handler) as httpd:
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            port = httpd.server_address[1]

            def call(method, path, payload=None):
                request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                    data=json.dumps(payload).encode() if payload is not None else None,
                    headers={"Authorization": "Bearer token", "Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    return json.loads(response.read())

            reply = call("POST", "/v1/assistant/chat", {"message": "Сделай план", "private": True})
            self.assertEqual(reply["message"]["content"], "Готово")
            listed = call("GET", "/v1/assistant/conversations")
            self.assertEqual(len(listed["conversations"]), 1)
            settings = call("POST", "/v1/ai/settings", {"mode": "local", "learning": False})
            self.assertEqual((settings["mode"], settings["learning"]), ("local", False))
            memory = call("POST", "/v1/assistant/memories", {"content": "Работает в СЦ"})
            self.assertTrue(call("DELETE", f"/v1/assistant/memories/{memory['memory']['id']}")["deleted"])
            self.assertIn("token", call("GET", "/v1/server"))
            self.assertTrue(call("DELETE", f"/v1/assistant/conversations/{reply['conversation_id']}")["deleted"])
            httpd.shutdown()


if __name__ == "__main__":
    unittest.main()


class GigaChatTests(unittest.TestCase):
    def test_detect_provider_by_key_shape(self):
        import base64 as b64
        from malenia.providers import detect_provider
        giga = b64.b64encode(b"0198c6a2-1111-7222-8333-444455556666:0198c6a2-aaaa-7bbb-8ccc-ddddeeeeffff").decode()
        self.assertEqual(detect_provider(giga), "gigachat")
        self.assertEqual(detect_provider("AIzaSyA-123"), "gemini")
        self.assertEqual(detect_provider("gsk_abc"), "groq")
        self.assertEqual(detect_provider("mln-abc"), "malenia")
        self.assertIsNone(detect_provider("hello"))

    def test_oauth_token_and_function_calling(self):
        from malenia.providers import GigaChatProvider
        sent = []

        class Response:
            def __init__(self, data): self.data = json.dumps(data).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return self.data

        class Opener:
            def open(self, request, timeout):
                sent.append(request)
                if request.full_url.endswith("/oauth"):
                    return Response({"access_token": "tok", "expires_at": 9999999999999})
                return Response({"choices": [{"message": {"role": "assistant", "content": "",
                                 "function_call": {"name": "calculate", "arguments": {"expression": "2+2"}}}}]})

        GigaChatProvider._tokens.clear()
        provider = GigaChatProvider("a2V5", opener=Opener())
        messages = [{"role": "user", "content": "2+2"},
                    {"role": "assistant", "content": "", "tool_calls": [{"id": "1", "type": "function", "function": {"name": "calculate", "arguments": "{\"expression\": \"1+1\"}"}}]},
                    {"role": "tool", "tool_call_id": "1", "name": "calculate", "content": "{\"result\": 2}"}]
        result = provider.chat("GigaChat-2-Max", messages, tools=[{"type": "function", "function": {"name": "calculate", "parameters": {}}}])
        provider.chat("GigaChat-2-Max", messages)
        self.assertEqual(result.tool_calls[0]["arguments"], {"expression": "2+2"})
        oauth = [r for r in sent if r.full_url.endswith("/oauth")]
        self.assertEqual(len(oauth), 1)  # token is cached
        self.assertEqual(oauth[0].get_header("Authorization"), "Basic a2V5")
        body = json.loads(sent[1].data)
        self.assertEqual(body["functions"][0]["name"], "calculate")
        self.assertEqual([m["role"] for m in body["messages"]], ["user", "assistant", "function"])
        self.assertEqual(body["messages"][1]["function_call"]["arguments"], {"expression": "1+1"})
        self.assertEqual(sent[1].get_header("Authorization"), "Bearer tok")
