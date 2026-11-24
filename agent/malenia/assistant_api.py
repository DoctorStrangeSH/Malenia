"""HTTP routes for the assistant, AI providers, hardware and server mode.

Mounted by server.py after authentication; returns True when a route matched.
"""
from __future__ import annotations

import re
import threading
from urllib.parse import parse_qs

from . import hardware
from . import training
from .agent_tools import ToolBox, ToolError
from .kb import KnowledgeBaseError, KnowledgeVault
from .voice import VoiceEngine, VoiceError
from . import diagnostics
from . import __version__
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
        knowledge, skills = KnowledgeBase(store), SkillRegistry(store)
        self.vault = KnowledgeVault(store, self.settings, secrets or self.router.secrets,
                                    embedder=getattr(self.router, "ollama", None))
        self.voice = VoiceEngine()

        from .browser_commands import BrowserCommands
        self.browser = BrowserCommands(store)
        self.toolbox = ToolBox(store, self.settings, skills=skills, knowledge=knowledge, vault=self.vault,
                               browser=self.browser)
        self.assistant = Assistant(store, self.router, knowledge, skills, web=web, background=background,
                                   toolbox=self.toolbox)
        self.lan = LanServer(self.settings, self.router)
        self.puller = ModelPuller()

    def tune_local(self) -> None:
        """Bigger context only where it fits: running out of memory crashes the app window."""
        try:
            info = self.hardware_profile()
            ram, vram = float(info.get("ram_gb") or 0), float(info.get("vram_gb") or 0)
        except Exception:
            return
        ollama = getattr(self.router, "ollama", None)
        if ollama is not None and hasattr(ollama, "num_ctx"):
            ollama.ram_gb, ollama.vram_gb = ram, vram


AI_ERRORS = {
    "invalid_project": "Укажите название проекта.",
    "project_not_found": "Проект не найден — возможно, он удалён.",
    "nothing_to_regenerate": "Нечего повторять: в этом диалоге ещё нет вопросов.",
    "message_not_found": "Сообщение не найдено — обновите диалог.",
    "ai_not_configured": "Модель не настроена. Откройте «Настройки → Модели ИИ»: подключите GigaChat или скачайте локальную модель.",
    "ai_invalid_key": "Ключ API не подошёл. Проверьте его в «Настройки → Модели ИИ».",
    "ai_rate_limited": "Бесплатный лимит модели исчерпан. Подождите немного или добавьте ещё одного провайдера.",
    "ai_unavailable": "Ни одна модель сейчас не отвечает. Проверьте, что локальный движок запущен и модель скачана («Настройки → Модели ИИ»), или подключите GigaChat.",
    "ai_bad_request": "Модель отклонила запрос. Попробуйте сократить сообщение.",
    "ai_tools_unsupported": "Модель не поддерживает инструменты. Выберите другую модель.",
    "ai_region_blocked": "Этот провайдер недоступен из вашего региона. Используйте GigaChat, локальную модель или свой сервер.",
    "ai_certificate": "Не удалось проверить сертификат GigaChat. Установите сертификаты Минцифры (gosuslugi.ru/crt) и перезапустите Малению.",
    "ai_no_vision_model": "Чтобы смотреть фото, нужна модель со зрением. Скачайте Gemma 4 в «Настройки → Модели ИИ» (она видит картинки) или подключите облачную модель со зрением.",
    "ai_payment_required": "Бесплатный лимит этой модели закончился. Выберите другую модель или провайдера.",
}


def handle(handler, method: str, parsed, services: AssistantServices) -> bool:
    path = parsed.path
    if not (path.startswith("/v1/assistant") or path.startswith("/v1/ai/") or path.startswith("/v1/server")):
        return False
    assistant, router = services.assistant, services.router
    try:
        # ---- conversations ------------------------------------------------
        if method == "GET" and path == "/v1/assistant/conversations":
            query = parse_qs(parsed.query)
            handler._send(200, {"conversations": assistant.list_conversations(
                query=(query.get("q") or [None])[0], project_id=(query.get("project") or [None])[0])})
            return True
        if path == "/v1/assistant/projects":
            if method == "GET":
                handler._send(200, {"projects": assistant.list_projects()})
            elif method == "POST":
                payload = handler._read_json(16 * 1024)
                if payload is not None:
                    handler._send(200, {"project": assistant.save_project(payload)})
            else:
                return False
            return True
        match = re.fullmatch(rf"/v1/assistant/projects/({UUID})", path)
        if match:
            if method == "POST":
                payload = handler._read_json(16 * 1024)
                if payload is not None:
                    handler._send(200, {"project": assistant.save_project(payload, match.group(1))})
            elif method == "DELETE":
                handler._send(200, {"deleted": assistant.delete_project(match.group(1))})
            else:
                return False
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
                    handler._send(200, {"updated": assistant.update_conversation(match.group(1), payload),
                                        "renamed": True})
            else:
                return False
            return True
        if method == "POST" and path == "/v1/assistant/chat":
            payload = handler._read_json(18 * 1024 * 1024)
            if payload is not None:
                handler._send(200, assistant.chat(payload))
            return True
        if method == "POST" and path == "/v1/assistant/runs":
            payload = handler._read_json(18 * 1024 * 1024)
            if payload is not None:
                handler._send(200, assistant.start_run(payload))
            return True
        match = re.fullmatch(rf"/v1/assistant/runs/({UUID})(/cancel)?", path)
        if match:
            if method == "GET" and not match.group(2):
                try:
                    after = int(parse_qs(parsed.query).get("after", ["0"])[0])
                except ValueError:
                    after = 0
                state = assistant.poll_run(match.group(1), after)
                if state and state.get("error"):
                    state["error"] = {**state["error"], "message": AI_ERRORS.get(state["error"]["error"], "") or
                                      "Не удалось получить ответ. Попробуйте ещё раз."}
                handler._send(200 if state else 404, state or {"error": "run_not_found"})
            elif method == "POST" and match.group(2):
                if int(handler.headers.get("Content-Length", "0") or 0):
                    handler._read_json(1024)
                handler._send(200, {"cancelled": assistant.cancel_run(match.group(1))})
            else:
                return False
            return True
        if method == "POST" and path == "/v1/assistant/feedback":
            payload = handler._read_json(4096)
            if payload is not None:
                if not isinstance(payload.get("message_id"), str) or not re.fullmatch(UUID, payload["message_id"]):
                    raise AssistantError("invalid_feedback")
                handler._send(200, assistant.feedback(payload["message_id"], payload.get("rating"), payload.get("comment")))
            return True

        # ---- agent actions & workspace ------------------------------------
        match = re.fullmatch(rf"/v1/assistant/actions/({UUID})", path)
        if match and method == "POST":
            payload = handler._read_json(1024)
            if payload is not None:
                try:
                    handler._send(200, {"action": services.toolbox.decide(match.group(1), bool(payload.get("approve")))})
                except ToolError as error:
                    handler._send(404, {"error": "action_not_found", "message": str(error)})
            return True
        if path == "/v1/assistant/workspace":
            if method == "GET":
                handler._send(200, {"path": str(services.toolbox.workspace.root())})
            elif method == "POST":
                payload = handler._read_json(2048)
                if payload is not None:
                    try:
                        handler._send(200, {"path": services.toolbox.workspace.set_root(str(payload.get("path") or ""))})
                    except (ToolError, OSError) as error:
                        handler._send(422, {"error": "invalid_workspace", "message": str(error)})
            else:
                return False
            return True

        # ---- diagnostics for "Сообщить о проблеме" ------------------------
        if method == "GET" and path == "/v1/assistant/diagnostics":
            def safe(call):
                try:
                    return call()
                except Exception as error:
                    return {"error": type(error).__name__}
            providers = safe(router.describe)
            if isinstance(providers, dict):
                providers = {"mode": providers.get("mode"), "local_model": providers.get("local_model"),
                             "providers": [{k: p.get(k) for k in ("id", "enabled", "has_key", "model")}
                                           for p in providers.get("providers", []) if isinstance(p, dict)]}
            kb = safe(services.vault.describe)
            if isinstance(kb, dict):
                kb = {k: kb.get(k) for k in ("repo", "documents", "sections", "semantic", "embed_model", "last_sync", "status")}
            hardware_info = safe(services.hardware_profile)
            handler._send(200, {
                "version": __version__, "created": diagnostics.datetime.now().isoformat(timespec="seconds"),
                "environment": diagnostics.environment(),
                "hardware": {k: hardware_info.get(k) for k in ("ram_gb", "gpu", "vram_gb", "cpu_threads")} if isinstance(hardware_info, dict) and "error" not in hardware_info else hardware_info,
                "providers": providers, "knowledge_base": kb, "voice": safe(services.voice.status),
                "conversations": len(safe(assistant.list_conversations) or []),
                "problems": diagnostics.recent()})
            return True

        # ---- voice input (local whisper.cpp) ------------------------------
        if path.startswith("/v1/assistant/voice"):
            try:
                if method == "GET" and path == "/v1/assistant/voice":
                    handler._send(200, services.voice.status())
                elif method == "POST" and path == "/v1/assistant/voice/install":
                    payload = handler._read_json(1024)
                    if payload is not None:
                        handler._send(200, services.voice.install(str(payload.get("model") or "small")))
                elif method == "POST" and path == "/v1/assistant/voice/transcribe":
                    payload = handler._read_json(36 * 1024 * 1024)
                    if payload is not None:
                        handler._send(200, {"text": services.voice.transcribe(str(payload.get("audio") or ""),
                                                                              str(payload.get("language") or "ru"))})
                else:
                    return False
            except VoiceError as error:
                code = str(error)
                messages = {"voice_not_installed": "Голосовой ввод ещё не установлен.",
                            "invalid_audio": "Не удалось прочитать запись. Попробуйте ещё раз."}
                handler._send(422, {"error": code, "message": messages.get(code, code)})
            except Exception as error:
                diagnostics.record("voice_failed", type(error).__name__, error)
                handler._send(500, {"error": "voice_failed", "message": "Не удалось распознать речь."})
            return True

        # ---- knowledge base (Obsidian / GitHub) ----------------------------
        if path == "/v1/assistant/kb":
            try:
                if method == "GET":
                    handler._send(200, services.vault.describe())
                elif method == "POST":
                    payload = handler._read_json(4096)
                    if payload is not None:
                        handler._send(200, services.vault.configure(payload))
                else:
                    return False
            except KnowledgeBaseError as error:
                handler._send(422, {"error": "kb_invalid", "message": str(error)})
            return True
        if method == "POST" and path == "/v1/assistant/kb/sync":
            if int(handler.headers.get("Content-Length", "0") or 0):
                handler._read_json(1024)
            try:
                result = services.vault.sync()
                services.vault.enable_auto_sync()
                handler._send(200, result)
            except KnowledgeBaseError as error:
                handler._send(422, {"error": "kb_sync_failed", "message": str(error)})
            return True

        # ---- own model ----------------------------------------------------
        if method == "GET" and path == "/v1/assistant/training":
            handler._send(200, {"stats": training.stats(assistant), "personal_model": training.PERSONAL_MODEL})
            return True
        if method == "POST" and path == "/v1/assistant/training/export":
            if int(handler.headers.get("Content-Length", "0") or 0):
                handler._read_json(1024)
            handler._send(200, training.export_dataset(assistant))
            return True
        if method == "POST" and path == "/v1/ai/local/personal":
            payload = handler._read_json(1024)
            if payload is not None:
                base = payload.get("base") or router.model_for("ollama")
                created = training.create_personal_model(assistant, base)
                config = router.config()
                config["local_model"] = created["model"]
                router.save_config(config)
                router._model_cache.pop("ollama", None)
                handler._send(200, created)
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
        if method == "POST" and path == "/v1/ai/detect-key":
            payload = handler._read_json(4096)
            if payload is not None:
                from .providers import detect_provider
                handler._send(200, {"provider": detect_provider(str(payload.get("key") or ""))})
            return True
        if method == "GET" and path == "/v1/ai/providers":
            description = router.describe()
            handler._send(200, description)
            # First look at the chat: load the local model into memory so the first answer is fast.
            if not getattr(services, "_warmed", False):
                services._warmed = True
                services.tune_local()
                if description.get("mode") != "cloud" and hasattr(router.ollama, "warm_up"):
                    try:
                        model = router.model_for("ollama")
                    except Exception:
                        model = None
                    if model:
                        threading.Thread(target=router.ollama.warm_up, args=(model,), daemon=True).start()
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
                if "context" in payload:
                    from .providers import CONTEXT_SIZES
                    if payload["context"] != "auto" and payload["context"] not in CONTEXT_SIZES:
                        raise AssistantError("invalid_context")
                    config["context"] = payload["context"]
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
