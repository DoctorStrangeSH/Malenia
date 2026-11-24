"""AI providers: local Ollama, free cloud APIs and another Malenia server.

Every cloud provider here speaks the OpenAI-compatible chat API, so adding a
new one is a preset, not new code. Messages and tool calls use the OpenAI
format internally and are converted for Ollama.
"""
from __future__ import annotations

import base64
import inspect
import json
import re
import ssl
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

OLLAMA_URL = "http://127.0.0.1:11434"

# Order = default priority in "auto" mode. Models are discovered from each
# provider's /models list, so new free models are picked up automatically.
PRESETS: dict[str, dict[str, Any]] = {
    "gigachat": {
        "name": "GigaChat (Сбер)",
        "kind": "cloud",
        "base_url": "https://api.giga.chat/v1",
        "key_url": "https://developers.sber.ru/studio/workspaces",
        "hint": "Работает из России. Бесплатно для физлиц: 365 млн токенов на год, включая GigaChat 3 Ultra.",
        "region_note": "",
        "include": [r"gigachat"],
        "exclude": [r"embed", r"image"],
        "prefer": [r"ultra", r"max", r"pro", r"gigachat"],
    },
    "gemini": {
        "name": "Google Gemini",
        "kind": "cloud",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_url": "https://aistudio.google.com/apikey",
        "hint": "Щедрый бесплатный тариф. Из России недоступен без VPN.",
        "include": [r"gemini"],
        "exclude": [r"lite", r"image", r"tts", r"embed", r"live", r"audio", r"thinking-exp", r"learnlm", r"aqa", r"robotics", r"computer-use"],
        "prefer": [r"gemini-[\d.]+-flash$", r"gemini-[\d.]+-flash", r"gemini-[\d.]+-pro", r"gemini"],
    },
    "groq": {
        "name": "Groq",
        "kind": "cloud",
        "base_url": "https://api.groq.com/openai/v1",
        "key_url": "https://console.groq.com/keys",
        "hint": "Очень быстрые ответы, бесплатно. Из России может требоваться VPN.",
        "include": [r"."],
        "exclude": [r"whisper", r"tts", r"guard", r"embed", r"playai", r"orpheus", r"compound"],
        "prefer": [r"gpt-oss-120b", r"qwen", r"kimi", r"llama-4", r"llama-3\.3-70b", r"gpt-oss"],
    },
    "openrouter": {
        "name": "OpenRouter",
        "kind": "cloud",
        "base_url": "https://openrouter.ai/api/v1",
        "key_url": "https://openrouter.ai/keys",
        "hint": "Десятки бесплатных моделей. С июня 2026 закрыт для России.",
        "include": [r":free$"],
        "exclude": [r"embed", r"vision-only"],
        "prefer": [r"deepseek", r"qwen3", r"gemma-4", r"gpt-oss-120b", r"kimi", r"glm", r"llama-4", r"gemini"],
    },
    "cerebras": {
        "name": "Cerebras",
        "kind": "cloud",
        "base_url": "https://api.cerebras.ai/v1",
        "key_url": "https://cloud.cerebras.ai",
        "hint": "Около миллиона бесплатных токенов в день. Из России может требоваться VPN.",
        "include": [r"."],
        "exclude": [r"embed"],
        "prefer": [r"gpt-oss-120b", r"qwen", r"glm", r"llama"],
    },
    "malenia": {
        "name": "Сервер Малении",
        "kind": "server",
        "base_url": "",
        "key_url": "",
        "hint": "Модель на другом вашем компьютере. Адрес и ключ — в его настройках «Сервер».",
        "include": [r"."],
        "exclude": [],
        "prefer": [],
    },
    "custom": {
        "name": "Свой OpenAI-совместимый",
        "kind": "cloud",
        "base_url": "",
        "key_url": "",
        "hint": "LM Studio, vLLM, корпоративный шлюз и т.п.",
        "include": [r"."],
        "exclude": [r"embed"],
        "prefer": [],
    },
}
CLOUD_ORDER = ["gigachat", "gemini", "groq", "cerebras", "openrouter", "custom"]


def detect_provider(key: str) -> str | None:
    """Guess the provider from the shape of an API key."""
    key = (key or "").strip()
    if key.startswith("AIza"):
        return "gemini"
    if key.startswith("gsk_"):
        return "groq"
    if key.startswith("sk-or-"):
        return "openrouter"
    if key.startswith("csk-"):
        return "cerebras"
    if key.startswith("mln-"):
        return "malenia"
    try:
        decoded = base64.b64decode(key + "=" * (-len(key) % 4), validate=True).decode("utf-8")
        if re.fullmatch(r"[0-9a-f-]{36}:[0-9a-f-]{36}", decoded):
            return "gigachat"
    except (ValueError, UnicodeDecodeError):
        pass
    return None


class ProviderError(Exception):
    """code: invalid_key | rate_limited | unavailable | bad_request | not_configured | tools_unsupported"""

    def __init__(self, code: str, detail: str = ""):
        self.code, self.detail = code, detail
        super().__init__(code if not detail else f"{code}: {detail}")


@dataclass
class ChatResult:
    content: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    provider: str = ""
    model: str = ""


def _version_key(name: str) -> tuple:
    numbers = [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)", name)[:3]]
    return tuple(numbers) if numbers else (0.0,)


def rank_models(models: list[str], preset: dict[str, Any]) -> list[str]:
    """Order discovered model IDs from best to worst for a preset."""
    usable = []
    for model in models:
        lower = model.casefold()
        if not any(re.search(p, lower) for p in preset.get("include", [r"."])):
            continue
        if any(re.search(p, lower) for p in preset.get("exclude", [])):
            continue
        usable.append(model)
    prefer = preset.get("prefer", [])

    def key(model: str):
        lower = model.casefold()
        bucket = next((i for i, p in enumerate(prefer) if re.search(p, lower)), len(prefer))
        preview = 1 if re.search(r"preview|exp", lower) else 0
        return (bucket, preview, tuple(-x for x in _version_key(lower)), lower)

    return sorted(usable, key=key)


def _post_json(opener, url: str, body: dict, headers: dict, timeout: float) -> dict:
    request = Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json", **headers})
    return _open(opener, request, timeout)


def _get_json(opener, url: str, headers: dict, timeout: float) -> dict:
    return _open(opener, Request(url, headers=headers), timeout)


def _http_error(error: HTTPError) -> ProviderError:
    try:
        detail = error.read(4096).decode("utf-8", "replace")
    except Exception:
        detail = ""
    if re.search(r"location is not supported|unsupported_country|not available in your (region|country)|region", detail, re.I) and error.code in (400, 403, 451):
        return ProviderError("region_blocked", detail[:300])
    if error.code == 402:
        return ProviderError("payment_required", detail[:300])
    if error.code in (401, 403):
        return ProviderError("invalid_key", detail[:300])
    if error.code == 429:
        return ProviderError("rate_limited", detail[:300])
    if error.code in (400, 404, 422):
        if re.search(r"tool|function", detail, re.I):
            return ProviderError("tools_unsupported", detail[:300])
        return ProviderError("bad_request", detail[:300])
    return ProviderError("unavailable", f"HTTP {error.code}")


def _open(opener, request: Request, timeout: float) -> dict:
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
    except HTTPError as error:
        raise _http_error(error) from None
    except (URLError, OSError, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
            raise ProviderError("certificate", str(reason)[:200]) from None
        raise ProviderError("unavailable", str(reason)[:200]) from None
    if len(raw) > 8 * 1024 * 1024:
        raise ProviderError("unavailable", "response too large")
    try:
        value = json.loads(raw)
    except ValueError:
        raise ProviderError("unavailable", "invalid json") from None
    if not isinstance(value, dict):
        raise ProviderError("unavailable", "invalid json")
    return value


class Cancelled(Exception):
    """The user pressed "Stop" while the model was answering."""


def _stream(opener, url: str, body: dict, headers: dict, timeout: float, cancel=None):
    """Yield decoded lines of a streaming response (SSE or NDJSON)."""
    request = Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json", **headers})
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as error:
        raise _http_error(error) from None
    except (URLError, OSError, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
            raise ProviderError("certificate", str(reason)[:200]) from None
        raise ProviderError("unavailable", str(reason)[:200]) from None
    total = 0
    try:
        with response:
            for raw in response:
                if cancel is not None and cancel.is_set():
                    raise Cancelled()
                total += len(raw)
                if total > 16 * 1024 * 1024:
                    raise ProviderError("unavailable", "response too large")
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    yield line
    except (URLError, OSError, TimeoutError) as error:
        raise ProviderError("unavailable", str(error)[:200]) from None


def _sse_json(lines):
    for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return
        try:
            value = json.loads(data)
        except ValueError:
            continue
        if isinstance(value, dict):
            if value.get("error"):
                raise ProviderError("unavailable", json.dumps(value["error"], ensure_ascii=False)[:300])
            yield value


def _parse_arguments(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw or "{}")
            return value if isinstance(value, dict) else {}
        except ValueError:
            return {}
    return {}


class OpenAICompatibleProvider:
    def __init__(self, provider_id: str, base_url: str, api_key: str | None, opener=None):
        self.id = provider_id
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        # Cloud calls honour the system/corporate proxy; local servers do not.
        local = re.match(r"https?://(127\.|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)", self.base_url)
        self.opener = opener or (build_opener(ProxyHandler({})) if local else build_opener())

    def _headers(self) -> dict:
        headers = {"User-Agent": "Malenia-Assistant"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.id == "openrouter":
            headers["HTTP-Referer"] = "https://github.com/DoctorStrangeSH/WorkPilot"
            headers["X-Title"] = "Malenia"
        return headers

    def list_models(self) -> list[str]:
        if not self.base_url:
            raise ProviderError("not_configured")
        data = _get_json(self.opener, self.base_url + "/models", self._headers(), 15)
        items = data.get("data") if isinstance(data.get("data"), list) else data.get("models", [])
        names = []
        for item in items if isinstance(items, list) else []:
            name = item.get("id") or item.get("name") if isinstance(item, dict) else None
            if isinstance(name, str) and name:
                names.append(name.removeprefix("models/"))
        return names

    def chat(self, model: str, messages: list[dict], tools: list[dict] | None = None,
             max_tokens: int = 2048, temperature: float = 0.4, json_mode: bool = False,
             timeout: float = 120, on_delta=None, cancel=None) -> ChatResult:
        if not self.base_url:
            raise ProviderError("not_configured")
        body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature,
                                "max_tokens": max_tokens, "stream": bool(on_delta)}
        if tools:
            body["tools"] = tools
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if on_delta:
            content, partial = [], {}
            for chunk in _sse_json(_stream(self.opener, self.base_url + "/chat/completions", body,
                                           {**self._headers(), "Accept": "text/event-stream"}, timeout, cancel)):
                choices = chunk.get("choices") or []
                delta = choices[0].get("delta") if choices and isinstance(choices[0], dict) else None
                if not isinstance(delta, dict):
                    continue
                if isinstance(delta.get("content"), str) and delta["content"]:
                    content.append(delta["content"])
                    on_delta(delta["content"])
                for call in delta.get("tool_calls") or []:
                    if not isinstance(call, dict):
                        continue
                    slot = partial.setdefault(call.get("index", len(partial)), {"id": None, "name": "", "arguments": ""})
                    slot["id"] = call.get("id") or slot["id"]
                    function = call.get("function") or {}
                    slot["name"] += function.get("name") or ""
                    slot["arguments"] += function.get("arguments") or ""
            calls = [{"id": slot["id"] or f"call_{index}", "name": slot["name"],
                      "arguments": _parse_arguments(slot["arguments"])}
                     for index, slot in sorted(partial.items()) if slot["name"]]
            return ChatResult(content="".join(content), tool_calls=calls, provider=self.id, model=model)
        data = _post_json(self.opener, self.base_url + "/chat/completions", body, self._headers(), timeout)
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            error = data.get("error")
            raise ProviderError("unavailable", json.dumps(error, ensure_ascii=False)[:300] if error else "no choices")
        message = choices[0].get("message") or {}
        content = message.get("content") or ""
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                calls.append({"id": call.get("id") or f"call_{len(calls)}", "name": function["name"],
                              "arguments": _parse_arguments(function.get("arguments"))})
        return ChatResult(content=str(content), tool_calls=calls, provider=self.id, model=model)


class GigaChatProvider:
    """Sber GigaChat: OAuth key -> 30-minute token; chat is OpenAI-like with
    "functions" (one function call per turn) instead of "tools"."""

    AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    _tokens: dict[str, tuple[str, float]] = {}
    _lock = threading.Lock()

    def __init__(self, auth_key: str | None, base_url: str = "https://api.giga.chat/v1", opener=None, scope: str = "GIGACHAT_API_PERS"):
        self.id = "gigachat"
        self.auth_key = (auth_key or "").strip()
        self.base_url = (base_url or "https://api.giga.chat/v1").rstrip("/")
        self.opener = opener or build_opener()
        self.scope = scope

    def _token(self) -> str:
        if not self.auth_key:
            raise ProviderError("not_configured")
        with self._lock:
            cached = self._tokens.get(self.auth_key)
            if cached and cached[1] - 60 > time.time():
                return cached[0]
            request = Request(self.AUTH_URL, data=urlencode({"scope": self.scope}).encode(), headers={
                "Authorization": "Basic " + self.auth_key, "RqUID": str(uuid.uuid4()),
                "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
            data = _open(self.opener, request, 20)
            token = data.get("access_token")
            if not isinstance(token, str):
                raise ProviderError("invalid_key", "no access token")
            expires = data.get("expires_at")
            expires = float(expires) / 1000 if isinstance(expires, (int, float)) and expires > 1e11 else time.time() + 1700
            self._tokens[self.auth_key] = (token, expires)
            return token

    def _headers(self) -> dict:
        return {"Authorization": "Bearer " + self._token(), "Accept": "application/json"}

    def list_models(self) -> list[str]:
        data = _get_json(self.opener, self.base_url + "/models", self._headers(), 20)
        return [item["id"] for item in data.get("data", []) if isinstance(item, dict) and isinstance(item.get("id"), str)]

    @staticmethod
    def _convert(messages: list[dict]) -> list[dict]:
        converted = []
        for message in messages:
            content = message.get("content") or ""
            if isinstance(content, list):  # images are not sent to GigaChat inline
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
            role = message["role"]
            if role == "tool":
                converted.append({"role": "function", "name": message.get("name", ""), "content": content or "{}"})
                continue
            item = {"role": role, "content": content}
            if message.get("tool_calls"):
                call = message["tool_calls"][0]["function"]
                item["function_call"] = {"name": call["name"], "arguments": _parse_arguments(call.get("arguments"))}
            converted.append(item)
        return converted

    def chat(self, model: str, messages: list[dict], tools: list[dict] | None = None,
             max_tokens: int = 2048, temperature: float = 0.4, json_mode: bool = False,
             timeout: float = 120, on_delta=None, cancel=None) -> ChatResult:
        body: dict[str, Any] = {"model": model, "messages": self._convert(messages),
                                "temperature": max(temperature, 0.01), "max_tokens": max_tokens, "stream": bool(on_delta)}
        if tools:
            body["functions"] = [t["function"] for t in tools if t.get("type") == "function"]
            body["function_call"] = "auto"
        if on_delta:
            content, call = [], None
            headers = {**self._headers(), "Accept": "text/event-stream"}
            for chunk in _sse_json(_stream(self.opener, self.base_url + "/chat/completions", body, headers, timeout, cancel)):
                choices = chunk.get("choices") or []
                delta = choices[0].get("delta") if choices and isinstance(choices[0], dict) else None
                if not isinstance(delta, dict):
                    continue
                if isinstance(delta.get("content"), str) and delta["content"]:
                    content.append(delta["content"])
                    on_delta(delta["content"])
                if isinstance(delta.get("function_call"), dict) and isinstance(delta["function_call"].get("name"), str):
                    call = delta["function_call"]
            calls = [{"id": "call_0", "name": call["name"], "arguments": _parse_arguments(call.get("arguments"))}] if call else []
            return ChatResult(content="".join(content), tool_calls=calls, provider=self.id, model=model)
        data = _post_json(self.opener, self.base_url + "/chat/completions", body, self._headers(), timeout)
        choices = data.get("choices") or []
        message = choices[0].get("message", {}) if choices and isinstance(choices[0], dict) else {}
        calls = []
        function_call = message.get("function_call")
        if isinstance(function_call, dict) and isinstance(function_call.get("name"), str):
            calls.append({"id": "call_0", "name": function_call["name"],
                          "arguments": _parse_arguments(function_call.get("arguments"))})
        return ChatResult(content=str(message.get("content") or ""), tool_calls=calls, provider=self.id, model=model)


class OllamaProvider:
    id = "ollama"
    # Keep the model in (video) memory so answers start in seconds.
    keep_alive = "30m"

    def warm_up(self, model: str) -> None:
        """Load a model into memory in advance (empty request)."""
        try:
            _post_json(self.opener, self.base_url + "/api/chat",
                       {"model": model, "messages": [], "keep_alive": self.keep_alive}, {}, 120)
        except ProviderError:
            pass

    def __init__(self, base_url: str = OLLAMA_URL, opener=None):
        self.base_url = base_url.rstrip("/")
        self.opener = opener or build_opener(ProxyHandler({}))

    def list_models(self) -> list[str]:
        data = _get_json(self.opener, self.base_url + "/api/tags", {}, 3)
        return [item["name"] for item in data.get("models", [])
                if isinstance(item, dict) and isinstance(item.get("name"), str)
                and not item.get("remote_host") and "embed" not in item["name"]]

    _capabilities: dict[str, set[str]] = {}

    def capabilities(self, model: str) -> set[str]:
        """Model features reported by Ollama (e.g. "vision", "tools", "thinking")."""
        if model not in self._capabilities:
            try:
                data = _post_json(self.opener, self.base_url + "/api/show", {"model": model}, {}, 10)
                caps = data.get("capabilities")
                self._capabilities[model] = {str(c) for c in caps} if isinstance(caps, list) else set()
            except ProviderError:
                return set()
        return self._capabilities[model]

    @staticmethod
    def _convert(messages: list[dict]) -> list[dict]:
        converted = []
        for message in messages:
            content = message.get("content") or ""
            images = []
            if isinstance(content, list):
                images = [part["image_url"]["url"].split(",", 1)[-1] for part in content
                          if isinstance(part, dict) and part.get("type") == "image_url"]
                content = "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
            item = {"role": message["role"], "content": content}
            if images:
                item["images"] = images
            if message.get("tool_calls"):
                item["tool_calls"] = [{"function": {"name": c["function"]["name"],
                                       "arguments": _parse_arguments(c["function"].get("arguments"))}}
                                      for c in message["tool_calls"]]
            if message["role"] == "tool":
                item["tool_name"] = message.get("name", "")
            converted.append(item)
        return converted

    def chat(self, model: str, messages: list[dict], tools: list[dict] | None = None,
             max_tokens: int = 2048, temperature: float = 0.4, json_mode: bool = False,
             timeout: float = 300, on_delta=None, cancel=None) -> ChatResult:
        body: dict[str, Any] = {"model": model, "messages": self._convert(messages), "stream": bool(on_delta),
                                "keep_alive": self.keep_alive,
                                "options": {"num_ctx": 8192, "num_predict": max_tokens, "temperature": temperature}}
        if tools:
            body["tools"] = tools
        if json_mode:
            body["format"] = "json"
        if re.match(r"(qwen3|gemma4|malenia)", model):
            body["think"] = False
        try:
            if on_delta:
                content, calls = [], []
                for line in _stream(self.opener, self.base_url + "/api/chat", body, {}, timeout, cancel):
                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if chunk.get("error"):
                        raise ProviderError("unavailable", str(chunk["error"])[:300])
                    message = chunk.get("message") if isinstance(chunk.get("message"), dict) else {}
                    if isinstance(message.get("content"), str) and message["content"]:
                        content.append(message["content"])
                        on_delta(message["content"])
                    calls.extend(message.get("tool_calls") or [])
                data = {"message": {"content": "".join(content), "tool_calls": calls}}
            else:
                data = _post_json(self.opener, self.base_url + "/api/chat", body, {}, timeout)
        except ProviderError as error:
            if tools and error.code in ("bad_request", "tools_unsupported"):
                raise ProviderError("tools_unsupported", error.detail) from None
            raise
        message = data.get("message") if isinstance(data.get("message"), dict) else {}
        calls = []
        for index, call in enumerate(message.get("tool_calls") or []):
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                calls.append({"id": f"call_{index}", "name": function["name"],
                              "arguments": _parse_arguments(function.get("arguments"))})
        return ChatResult(content=str(message.get("content") or ""), tool_calls=calls,
                          provider=self.id, model=model)


class ModelRouter:
    """Chooses provider+model and falls back when one is down or rate-limited."""

    def __init__(self, settings, secrets, hardware_recommendation: Callable[[], list[str]] | None = None,
                 factory: Callable[[str, str, str | None], Any] | None = None, ollama: OllamaProvider | None = None):
        self.settings = settings
        self.secrets = secrets
        self.recommended_local = hardware_recommendation or (lambda: [])
        self.factory = factory or (lambda pid, url, key: OpenAICompatibleProvider(pid, url, key))
        self.ollama = ollama or OllamaProvider()
        # Tests inject `factory` for every provider; production uses the real GigaChat client.
        self.gigachat_factory = None if factory is not None else (lambda key: GigaChatProvider(key))
        self._model_cache: dict[str, list[str]] = {}

    # ---- configuration ---------------------------------------------------
    def config(self) -> dict:
        value = self.settings.get("ai.config", {})
        value = value if isinstance(value, dict) else {}
        value.setdefault("mode", "auto")  # auto | cloud | local
        value.setdefault("providers", {})
        value.setdefault("learning", True)
        value.setdefault("auto_web", True)
        value.setdefault("local_model", None)
        return value

    def save_config(self, config: dict) -> None:
        self.settings.set("ai.config", config)

    def provider_config(self, provider_id: str) -> dict:
        return self.config()["providers"].get(provider_id, {})

    def api_key(self, provider_id: str) -> str | None:
        try:
            return self.secrets.get(f"ai.{provider_id}")
        except Exception:
            return None

    def update_provider(self, provider_id: str, payload: dict) -> dict:
        if provider_id not in PRESETS:
            raise ProviderError("bad_request", "unknown provider")
        config = self.config()
        entry = dict(config["providers"].get(provider_id, {}))
        if "api_key" in payload:
            key = payload["api_key"]
            if key in (None, ""):
                try:
                    self.secrets.delete(f"ai.{provider_id}")
                except Exception:
                    pass
            elif isinstance(key, str) and 8 <= len(key.strip()) <= 2048 and not re.search(r"\s", key.strip()):
                self.secrets.set(f"ai.{provider_id}", key.strip())
                entry["enabled"] = True
            else:
                raise ProviderError("bad_request", "invalid key")
        if "base_url" in payload:
            url = payload["base_url"]
            if url and (not isinstance(url, str) or not re.fullmatch(r"https?://[^\s]{3,300}", url.strip())):
                raise ProviderError("bad_request", "invalid url")
            url = (url or "").strip().rstrip("/")
            if provider_id == "malenia" and url and not url.endswith("/v1"):
                url += "/v1"
            entry["base_url"] = url
        if "enabled" in payload:
            entry["enabled"] = bool(payload["enabled"])
        if "model" in payload:
            model = payload["model"]
            if model is not None and (not isinstance(model, str) or len(model) > 200):
                raise ProviderError("bad_request", "invalid model")
            entry["model"] = model or None
        config["providers"][provider_id] = entry
        self.save_config(config)
        self._model_cache.pop(provider_id, None)
        return entry

    def _base_url(self, provider_id: str) -> str:
        return self.provider_config(provider_id).get("base_url") or PRESETS[provider_id]["base_url"]

    def provider(self, provider_id: str):
        if provider_id == "ollama":
            return self.ollama
        if provider_id == "gigachat" and self.gigachat_factory is not None:
            return self.gigachat_factory(self.api_key(provider_id))
        return self.factory(provider_id, self._base_url(provider_id), self.api_key(provider_id))

    def configured(self, provider_id: str) -> bool:
        if provider_id == "ollama":
            return True
        entry = self.provider_config(provider_id)
        if entry.get("enabled") is False or not self._base_url(provider_id):
            return False
        return bool(self.api_key(provider_id)) or provider_id == "custom" and bool(entry.get("base_url"))

    # ---- model choice ----------------------------------------------------
    def models(self, provider_id: str, refresh: bool = False) -> list[str]:
        if refresh or provider_id not in self._model_cache:
            discovered = self.provider(provider_id).list_models()
            if provider_id == "ollama":
                self._model_cache[provider_id] = self._rank_local(discovered)
            else:
                self._model_cache[provider_id] = rank_models(discovered, PRESETS[provider_id])
        return self._model_cache[provider_id]

    def _rank_local(self, installed: list[str]) -> list[str]:
        recommended = self.recommended_local()

        def key(name):
            base = name.removesuffix(":latest")
            for index, tag in enumerate(recommended):
                if base == tag or name == tag:
                    return (index, name)
            size = _version_key(name.split(":")[-1])
            return (len(recommended), tuple(-x for x in size), name)

        return sorted(installed, key=key)

    def model_for(self, provider_id: str) -> str | None:
        if provider_id == "ollama":
            chosen = self.config().get("local_model")
        else:
            chosen = self.provider_config(provider_id).get("model")
        if chosen:
            return chosen
        models = self.models(provider_id)
        return models[0] if models else None

    def candidates(self, private: bool = False) -> list[str]:
        config = self.config()
        server = ["malenia"] if self.configured("malenia") else []
        clouds = [pid for pid in CLOUD_ORDER if self.configured(pid)]
        if private or config["mode"] == "local":
            return server + ["ollama"]
        if config["mode"] == "cloud":
            return clouds + server
        return clouds + server + ["ollama"]

    VISION_HINT = re.compile(r"gemini|gemma[-_]?[34]|vl|vision|llava|pixtral|scout|maverick|gpt-4o|gpt-5|minicpm-v", re.I)

    @staticmethod
    def _streams(provider) -> bool:
        try:
            parameters = inspect.signature(provider.chat).parameters
        except (TypeError, ValueError):
            return False
        return "on_delta" in parameters

    def warm_up(self) -> None:
        """Preload the local model so the first answer starts quickly."""
        if self.config().get("mode") == "cloud":
            return
        model = self.model_for("ollama")
        if model and hasattr(self.ollama, "warm_up"):
            self.ollama.warm_up(model)

    def _vision_local_model(self, preferred: str | None) -> str | None:
        caps = getattr(self.ollama, "capabilities", None)
        candidates = ([preferred] if preferred else []) + [m for m in self.models("ollama") if m != preferred]
        for model in candidates:
            if caps is not None and "vision" in caps(model):
                return model
        return None

    def chat(self, messages: list[dict], tools: list[dict] | None = None, private: bool = False,
             needs_vision: bool = False, **options) -> ChatResult:
        errors = []
        for provider_id in self.candidates(private):
            try:
                model = self.model_for(provider_id)
                if needs_vision:
                    if provider_id == "gigachat":
                        errors.append((provider_id, "no_vision_model"))
                        continue
                    if provider_id == "ollama":
                        model = self._vision_local_model(model)
                    elif model and provider_id != "malenia" and not self.VISION_HINT.search(model):
                        errors.append((provider_id, "no_vision_model"))
                        continue
                if not model:
                    errors.append((provider_id, "no_vision_model" if needs_vision else "no_model"))
                    continue
                provider = self.provider(provider_id)
                chosen = (self.config().get("local_model") if provider_id == "ollama"
                          else self.provider_config(provider_id).get("model"))
                # A free tier may cover only some models: try the next best ones.
                alternatives = [] if chosen else [m for m in self._model_cache.get(provider_id, []) if m != model][:2]
                for attempt, current in enumerate([model] + alternatives):
                    try:
                        call_options = options if self._streams(provider) else {
                            k: v for k, v in options.items() if k not in ("on_delta", "cancel")}
                        try:
                            result = provider.chat(current, messages, tools=tools, **call_options)
                        except ProviderError as error:
                            if tools and error.code == "tools_unsupported":
                                result = provider.chat(current, messages, tools=None, **call_options)
                            else:
                                raise
                        result.provider, result.model = provider_id, current
                        return result
                    except ProviderError as error:
                        if error.code in ("payment_required", "rate_limited") and attempt < len(alternatives):
                            continue
                        raise
            except ProviderError as error:
                errors.append((provider_id, error.code))
                continue
        if not errors:
            raise ProviderError("not_configured")
        codes = {code for _, code in errors}
        if codes == {"rate_limited"}:
            raise ProviderError("rate_limited", "; ".join(f"{p}:{c}" for p, c in errors))
        if len(errors) == 1 and errors[0][1] in ("invalid_key", "region_blocked", "certificate", "payment_required"):
            raise ProviderError(errors[0][1], errors[0][0])
        if needs_vision and all(code in ("no_vision_model", "bad_request", "unavailable") for code in codes) and "no_vision_model" in codes:
            raise ProviderError("no_vision_model", "; ".join(f"{p}:{c}" for p, c in errors))
        raise ProviderError("unavailable", "; ".join(f"{p}:{c}" for p, c in errors))

    def describe(self) -> dict:
        config = self.config()
        providers = []
        for provider_id, preset in PRESETS.items():
            entry = config["providers"].get(provider_id, {})
            providers.append({
                "id": provider_id, "name": preset["name"], "kind": preset["kind"],
                "hint": preset["hint"], "key_url": preset["key_url"],
                "base_url": entry.get("base_url") or preset["base_url"],
                "has_key": bool(self.api_key(provider_id)),
                "enabled": self.configured(provider_id),
                "model": entry.get("model"),
            })
        return {"mode": config["mode"], "learning": config["learning"], "auto_web": config["auto_web"],
                "local_model": config.get("local_model"), "providers": providers,
                "order": self.candidates(False)}
