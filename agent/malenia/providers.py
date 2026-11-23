"""AI providers: local Ollama, free cloud APIs and another Malenia server.

Every cloud provider here speaks the OpenAI-compatible chat API, so adding a
new one is a preset, not new code. Messages and tool calls use the OpenAI
format internally and are converted for Ollama.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

OLLAMA_URL = "http://127.0.0.1:11434"

# Order = default priority in "auto" mode. Models are discovered from each
# provider's /models list, so new free models are picked up automatically.
PRESETS: dict[str, dict[str, Any]] = {
    "gemini": {
        "name": "Google Gemini",
        "kind": "cloud",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_url": "https://aistudio.google.com/apikey",
        "hint": "Самый щедрый бесплатный тариф. Ключ без банковской карты.",
        "include": [r"gemini"],
        "exclude": [r"lite", r"image", r"tts", r"embed", r"live", r"audio", r"thinking-exp", r"learnlm", r"aqa", r"robotics", r"computer-use"],
        "prefer": [r"gemini-[\d.]+-flash$", r"gemini-[\d.]+-flash", r"gemini-[\d.]+-pro", r"gemini"],
    },
    "groq": {
        "name": "Groq",
        "kind": "cloud",
        "base_url": "https://api.groq.com/openai/v1",
        "key_url": "https://console.groq.com/keys",
        "hint": "Очень быстрые ответы. Бесплатный ключ без карты.",
        "include": [r"."],
        "exclude": [r"whisper", r"tts", r"guard", r"embed", r"playai", r"orpheus", r"compound"],
        "prefer": [r"gpt-oss-120b", r"qwen", r"kimi", r"llama-4", r"llama-3\.3-70b", r"gpt-oss"],
    },
    "openrouter": {
        "name": "OpenRouter",
        "kind": "cloud",
        "base_url": "https://openrouter.ai/api/v1",
        "key_url": "https://openrouter.ai/keys",
        "hint": "Десятки бесплатных моделей по одному ключу (50 запросов в день).",
        "include": [r":free$"],
        "exclude": [r"embed", r"vision-only"],
        "prefer": [r"deepseek", r"qwen3", r"gemma-4", r"gpt-oss-120b", r"kimi", r"glm", r"llama-4", r"gemini"],
    },
    "cerebras": {
        "name": "Cerebras",
        "kind": "cloud",
        "base_url": "https://api.cerebras.ai/v1",
        "key_url": "https://cloud.cerebras.ai",
        "hint": "Около миллиона бесплатных токенов в день.",
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
CLOUD_ORDER = ["gemini", "groq", "cerebras", "openrouter", "custom"]


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


def _open(opener, request: Request, timeout: float) -> dict:
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
    except HTTPError as error:
        try:
            detail = error.read(4096).decode("utf-8", "replace")
        except Exception:
            detail = ""
        if error.code in (401, 403):
            raise ProviderError("invalid_key", detail[:300]) from None
        if error.code == 429:
            raise ProviderError("rate_limited", detail[:300]) from None
        if error.code in (400, 404, 422):
            if re.search(r"tool|function", detail, re.I):
                raise ProviderError("tools_unsupported", detail[:300]) from None
            raise ProviderError("bad_request", detail[:300]) from None
        raise ProviderError("unavailable", f"HTTP {error.code}") from None
    except (URLError, OSError, TimeoutError) as error:
        raise ProviderError("unavailable", str(getattr(error, "reason", error))[:200]) from None
    if len(raw) > 8 * 1024 * 1024:
        raise ProviderError("unavailable", "response too large")
    try:
        value = json.loads(raw)
    except ValueError:
        raise ProviderError("unavailable", "invalid json") from None
    if not isinstance(value, dict):
        raise ProviderError("unavailable", "invalid json")
    return value


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
             timeout: float = 120) -> ChatResult:
        if not self.base_url:
            raise ProviderError("not_configured")
        body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature,
                                "max_tokens": max_tokens, "stream": False}
        if tools:
            body["tools"] = tools
        if json_mode:
            body["response_format"] = {"type": "json_object"}
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


class OllamaProvider:
    id = "ollama"

    def __init__(self, base_url: str = OLLAMA_URL, opener=None):
        self.base_url = base_url.rstrip("/")
        self.opener = opener or build_opener(ProxyHandler({}))

    def list_models(self) -> list[str]:
        data = _get_json(self.opener, self.base_url + "/api/tags", {}, 3)
        return [item["name"] for item in data.get("models", [])
                if isinstance(item, dict) and isinstance(item.get("name"), str)
                and not item.get("remote_host") and "embed" not in item["name"]]

    @staticmethod
    def _convert(messages: list[dict]) -> list[dict]:
        converted = []
        for message in messages:
            item = {"role": message["role"], "content": message.get("content") or ""}
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
             timeout: float = 300) -> ChatResult:
        body: dict[str, Any] = {"model": model, "messages": self._convert(messages), "stream": False,
                                "keep_alive": "10m",
                                "options": {"num_ctx": 8192, "num_predict": max_tokens, "temperature": temperature}}
        if tools:
            body["tools"] = tools
        if json_mode:
            body["format"] = "json"
        if re.match(r"qwen3", model):
            body["think"] = False
        try:
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

    def chat(self, messages: list[dict], tools: list[dict] | None = None, private: bool = False,
             **options) -> ChatResult:
        errors = []
        for provider_id in self.candidates(private):
            try:
                model = self.model_for(provider_id)
                if not model:
                    errors.append((provider_id, "no_model"))
                    continue
                provider = self.provider(provider_id)
                try:
                    result = provider.chat(model, messages, tools=tools, **options)
                except ProviderError as error:
                    if tools and error.code == "tools_unsupported":
                        result = provider.chat(model, messages, tools=None, **options)
                    else:
                        raise
                result.provider, result.model = provider_id, model
                return result
            except ProviderError as error:
                errors.append((provider_id, error.code))
                continue
        if not errors:
            raise ProviderError("not_configured")
        codes = {code for _, code in errors}
        if codes == {"rate_limited"}:
            raise ProviderError("rate_limited", "; ".join(f"{p}:{c}" for p, c in errors))
        if "invalid_key" in codes and len(errors) == 1:
            raise ProviderError("invalid_key", errors[0][0])
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
