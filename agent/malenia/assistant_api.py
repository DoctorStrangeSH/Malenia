"""HTTP routes for the assistant, AI providers, hardware and server mode.

Mounted by server.py after authentication; returns True when a route matched.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs

from . import hardware
from .assistant import Assistant, AssistantError
from .knowledge import KnowledgeBase
from .lan import LanServer
from .local_models import ModelPuller
from .providers import PRESETS, ModelRouter, ProviderError
from .settings import SettingsStore, default_secret_store
from .skills import SkillRegistry
from .store import TaskStore

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


class _LazySecrets:
    """Open the OS secret store only when a key is actually used."""

    def __init__(self, factory=default_secret_store):
        self._factory, self._store = factory, None

    def _get(self):
        if self._store is None:
            self._store = self._factory()
        return self._store

    def get(self, name):
        return self._get().get(name)

    def set(self, name, value):
        return self._get().set(name, value)

    def delete(self, name):
        return self._get().delete(name)


class AssistantServices:
    def __init__(self, store: TaskStore, secrets=None, router: ModelRouter | None = None,
                 web=None, background: bool = True, hardware_profile=None):
        self.settings = SettingsStore(store)
        self.hardware_profile = hardware_profile or hardware.profile
        self.router = router or ModelRouter(self.settings, secrets or _LazySecrets(),
                                            hardware_recommendation=lambda: self.hardware_profile()["recommendation"]["models"])
        self.assistant = Assistant(store, self.router, KnowledgeBase(store), SkillRegistry(store),
                                   web=web, background=background)
        self.lan = LanServer(self.settings, self.router)
        self.puller = ModelPuller()


AI_ERRORS = {
    "ai_not_configured": "Модель не настроена. Откройте «Настройки → Модели ИИ» и добавьте бесплатный ключ или локальную модель.",
    "ai_invalid_key": "Ключ API не подошёл. Проверьте его в «Настройки → Модели ИИ».",
    "ai_rate_limited": "Бесплатный лимит модели исчерпан. Подождите немного или добавьте ещё одного провайдера.",
    "ai_unavailable": "Ни одна модель сейчас не отвечает. Проверьте интернет, ключи или запустите локальную модель.",
    "ai_bad_request": "Модель отклонила запрос. Попробуйте сократить сообщение.",
    "ai_tools_unsupported": "Модель не поддерживает инструменты. Выберите другую модель.",
}


def handle(handler, method: str, parsed, services: AssistantServices) -> bool:
    path = parsed.path
    if not (path.startswith("/v1/assistant") or path.startswith("/v1/ai/") or path.startswith("/v1/server")):
        return False
    assistant, router = services.assistant, services.router
    try:
        # ---- conversations ------------------------------------------------
        if method == "GET" and path == "/v1/assistant/conversations":
            handler._send(200, {"conversations": assistant.list_conversations()})
            return True
        match = re.fullmatch(rf"/v1/assistant/conversations/({UUID})", path)
        if match:
            if method == "GET":
                conversation = assistant.get_conversation(match.group(1))
                handler._send(200 if conversation else 404, {"conversation": conversation} if conversation else {"error": "not_found"})
            elif method == "DELETE":
                handler._send(200, {"deleted": assistant.delete_conversation(match.group(1))})
            elif method == "POST":
                payload = handler._read_json(2048)
                if payload is not None:
                    handler._send(200, {"renamed": assistant.rename_conversation(match.group(1), payload.get("title"))})
            else:
                return False
            return True
        if method == "POST" and path == "/v1/assistant/chat":
            payload = handler._read_json(64 * 1024)
            if payload is not None:
                handler._send(200, assistant.chat(payload))
            return True
        if method == "POST" and path == "/v1/assistant/feedback":
            payload = handler._read_json(4096)
            if payload is not None:
                if not isinstance(payload.get("message_id"), str) or not re.fullmatch(UUID, payload["message_id"]):
                    raise AssistantError("invalid_feedback")
                handler._send(200, assistant.feedback(payload["message_id"], payload.get("rating"), payload.get("comment")))
            return True

        # ---- memories -----------------------------------------------------
        if path == "/v1/assistant/memories":
            if method == "GET":
                handler._send(200, {"memories": assistant.list_memories()})
            elif method == "POST":
                payload = handler._read_json(4096)
                if payload is not None:
                    kind = payload.get("kind", "fact")
                    saved = assistant.add_memory(payload.get("content"), kind, "user")
                    handler._send(200, {"memory": saved, "merged": saved is None})
            else:
                return False
            return True
        match = re.fullmatch(rf"/v1/assistant/memories/({UUID})", path)
        if match:
            if method == "DELETE":
                handler._send(200, {"deleted": assistant.delete_memory(match.group(1))})
            elif method == "POST":
                payload = handler._read_json(4096)
                if payload is not None:
                    handler._send(200, {"updated": assistant.update_memory(match.group(1), payload.get("content"))})
            else:
                return False
            return True

        # ---- providers & settings ----------------------------------------
        if method == "GET" and path == "/v1/ai/providers":
            handler._send(200, router.describe())
            return True
        if method == "POST" and path == "/v1/ai/settings":
            payload = handler._read_json(2048)
            if payload is not None:
                config = router.config()
                if "mode" in payload:
                    if payload["mode"] not in ("auto", "cloud", "local"):
                        raise AssistantError("invalid_mode")
                    config["mode"] = payload["mode"]
                for flag in ("learning", "auto_web"):
                    if flag in payload:
                        config[flag] = bool(payload[flag])
                if "local_model" in payload:
                    model = payload["local_model"]
                    if model is not None and (not isinstance(model, str) or len(model) > 200):
                        raise AssistantError("invalid_model")
                    config["local_model"] = model or None
                router.save_config(config)
                handler._send(200, router.describe())
            return True
        match = re.fullmatch(r"/v1/ai/providers/([a-z]+)(/test)?", path)
        if match and method == "POST" and match.group(1) in PRESETS | {"ollama": {}}:
            provider_id = match.group(1)
            if match.group(2):
                if int(handler.headers.get("Content-Length", "0") or 0):
                    handler._read_json(1024)
                try:
                    models = router.models(provider_id, refresh=True)
                    chosen = router.model_for(provider_id)
                    handler._send(200, {"ok": bool(models), "models": models[:50], "model": chosen})
                except ProviderError as error:
                    handler._send(200, {"ok": False, "error": error.code, "detail": error.detail[:200]})
            else:
                payload = handler._read_json(8192)
                if payload is not None:
                    router.update_provider(provider_id, payload)
                    handler._send(200, router.describe())
            return True

        # ---- hardware & local models -------------------------------------
        if method == "GET" and path == "/v1/ai/hardware":
            refresh = parse_qs(parsed.query).get("refresh", ["0"])[0] == "1"
            profile = services.hardware_profile(refresh) if refresh else services.hardware_profile()
            try:
                installed = router.models("ollama", refresh=True)
                ollama = True
            except ProviderError:
                installed, ollama = [], False
            handler._send(200, {"hardware": profile, "installed": installed, "ollama_running": ollama,
                                "pull": services.puller.snapshot()})
            return True
        if path == "/v1/ai/local/pull":
            if method == "GET":
                handler._send(200, services.puller.snapshot())
            elif method == "POST":
                payload = handler._read_json(1024) if int(handler.headers.get("Content-Length", "0") or 0) else {}
                if payload is None:
                    return True
                model = payload.get("model")
                candidates = [model] if model else services.hardware_profile()["recommendation"]["models"]
                try:
                    handler._send(202, services.puller.start(candidates))
                except ValueError:
                    handler._send(422, {"error": "invalid_model"})
                except RuntimeError:
                    handler._send(409, {"error": "pull_already_running"})
            else:
                return False
            return True

        # ---- server mode --------------------------------------------------
        if path == "/v1/server":
            if method == "GET":
                handler._send(200, services.lan.status())
            elif method == "POST":
                payload = handler._read_json(1024)
                if payload is not None:
                    try:
                        handler._send(200, services.lan.configure(bool(payload.get("enabled")), payload.get("port")))
                    except ValueError:
                        handler._send(422, {"error": "invalid_port"})
            else:
                return False
            return True
        if method == "POST" and path == "/v1/server/rotate-token":
            services.lan.rotate_token()
            handler._send(200, services.lan.status())
            return True
    except AssistantError as error:
        handler._send(error.status, {"error": error.code, "message": AI_ERRORS.get(error.code, "")})
        return True
    except ProviderError as error:
        handler._send(422, {"error": error.code, "message": error.detail[:200]})
        return True
    return False
