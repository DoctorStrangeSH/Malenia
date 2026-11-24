"""Background download of local Ollama models with progress for the UI."""
from __future__ import annotations

import json
import re
import threading
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from .providers import OLLAMA_URL

TAG = re.compile(r"[a-z0-9][a-z0-9._-]{0,60}(:[a-z0-9._-]{1,40})?")


class ModelPuller:
    def __init__(self, base_url: str = OLLAMA_URL, opener=None):
        self.base_url = base_url
        self.opener = opener or build_opener(ProxyHandler({}))
        self._lock = threading.Lock()
        self.state = {"status": "idle", "model": None, "completed": 0, "total": 0, "error": None, "tried": []}

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def start(self, candidates: list[str]) -> dict:
        candidates = [c for c in candidates if isinstance(c, str) and TAG.fullmatch(c)]
        if not candidates:
            raise ValueError("invalid_model")
        with self._lock:
            if self.state["status"] == "running":
                raise RuntimeError("pull_already_running")
            self.state = {"status": "running", "model": candidates[0], "completed": 0, "total": 0,
                          "error": None, "tried": []}
        threading.Thread(target=self._run, args=(candidates,), daemon=True).start()
        return self.snapshot()

    def _update(self, **values):
        with self._lock:
            self.state.update(values)

    def _pull(self, model: str) -> None:
        request = Request(self.base_url + "/api/pull", data=json.dumps({"model": model, "stream": True}).encode(),
                          headers={"Content-Type": "application/json"})
        with self.opener.open(request, timeout=3600) as response:
            for raw in response:
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                if event.get("error"):
                    raise RuntimeError(str(event["error"])[:200])
                if event.get("total"):
                    self._update(total=int(event["total"]), completed=int(event.get("completed") or 0))
                if event.get("status") == "success":
                    return
        raise RuntimeError("pull_incomplete")

    def _run(self, candidates: list[str]) -> None:
        last_error = None
        for model in candidates:
            self._update(model=model, completed=0, total=0)
            try:
                self._pull(model)
                with self._lock:
                    self.state["tried"].append(model)
                self._update(status="done", error=None)
                return
            except (HTTPError, URLError, OSError) as error:
                last_error = "ollama_unavailable" if isinstance(error, URLError) else str(error)[:200]
                if isinstance(error, URLError):
                    break
            except RuntimeError as error:
                last_error = str(error)
            with self._lock:
                self.state["tried"].append(model)
        self._update(status="failed", error=last_error or "pull_failed")
