"""Share this computer's local model with your other computers.

A separate listener (default port 8766) exposes ONLY an OpenAI-compatible
chat endpoint backed by the local Ollama model. The full Malenia API stays on
127.0.0.1. Access requires the pairing key shown in Settings → Server.
For computers in different networks use Tailscale (encrypted, free).
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .providers import ModelRouter, ProviderError

DEFAULT_PORT = 8766
MAX_BODY = 512 * 1024


def local_addresses() -> list[dict]:
    found: dict[str, str] = {}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.setdefault(info[4][0], "")
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # no packets are sent for UDP connect
            found.setdefault(probe.getsockname()[0], "")
    except OSError:
        pass
    result = []
    for address in found:
        ip = ipaddress.ip_address(address)
        if ip.is_loopback or ip.is_link_local:
            continue
        kind = "tailscale" if ip in ipaddress.ip_network("100.64.0.0/10") else "lan" if ip.is_private else "public"
        result.append({"address": address, "kind": kind})
    order = {"lan": 0, "tailscale": 1, "public": 2}
    return sorted(result, key=lambda item: (order[item["kind"]], item["address"]))


class LanServer:
    def __init__(self, settings, router: ModelRouter):
        self.settings = settings
        self.router = router
        self._server: ThreadingHTTPServer | None = None
        self._lock = threading.Lock()
        self._busy = threading.Semaphore(2)
        self.last_error: str | None = None
        self.requests_served = 0

    # ---- config ---------------------------------------------------------
    def token(self) -> str:
        token = self.settings.get("lan.token")
        if not isinstance(token, str) or len(token) < 20:
            token = "mln-" + secrets.token_urlsafe(24)
            self.settings.set("lan.token", token)
        return token

    def rotate_token(self) -> str:
        self.settings.set("lan.token", "mln-" + secrets.token_urlsafe(24))
        return self.token()

    def port(self) -> int:
        port = self.settings.get("lan.port", DEFAULT_PORT)
        return port if isinstance(port, int) and 1024 <= port <= 65535 else DEFAULT_PORT

    def status(self) -> dict:
        running = self._server is not None
        port = self.port()
        return {"enabled": bool(self.settings.get("lan.enabled", False)), "running": running, "port": port,
                "token": self.token(), "error": self.last_error, "requests_served": self.requests_served,
                "addresses": [{**a, "url": f"http://{a['address']}:{port}"} for a in local_addresses()]}

    def configure(self, enabled: bool, port: int | None = None) -> dict:
        if port is not None:
            if not isinstance(port, int) or not 1024 <= port <= 65535 or port == 8765:
                raise ValueError("invalid_port")
            self.settings.set("lan.port", port)
        self.settings.set("lan.enabled", bool(enabled))
        self.stop()
        if enabled:
            self.start()
        return self.status()

    # ---- lifecycle ------------------------------------------------------
    def start_if_enabled(self) -> None:
        if self.settings.get("lan.enabled", False):
            self.start()

    def start(self) -> None:
        with self._lock:
            if self._server is not None:
                return
            try:
                server = ThreadingHTTPServer(("0.0.0.0", self.port()), self._handler())
            except OSError as error:
                self.last_error = f"port_unavailable: {error}"
                return
            server.daemon_threads = True
            self._server = server
            self.last_error = None
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        with self._lock:
            server, self._server = self._server, None
        if server is not None:
            server.shutdown()
            server.server_close()

    # ---- HTTP -----------------------------------------------------------
    def _handler(self):
        lan = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MaleniaLAN/1"
            sys_version = ""

            def log_message(self, *args):
                return

            def _send(self, status: int, payload: dict):
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self) -> bool:
                supplied = self.headers.get("Authorization", "")
                if supplied.startswith("Bearer ") and hmac.compare_digest(supplied[7:].encode(), lan.token().encode()):
                    return True
                time.sleep(0.5)  # slow down key guessing
                self._send(401, {"error": {"message": "invalid pairing key", "type": "invalid_key"}})
                return False

            def do_GET(self):
                if self.path == "/health":
                    self._send(200, {"service": "malenia-lan", "status": "ok"})
                    return
                if not self._authorized():
                    return
                if self.path == "/v1/models":
                    try:
                        models = lan.router.models("ollama", refresh=True)
                    except ProviderError:
                        models = []
                    self._send(200, {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "malenia"} for m in models]})
                else:
                    self._send(404, {"error": {"message": "not found"}})

            def do_POST(self):
                if not self._authorized():
                    return
                if self.path != "/v1/chat/completions":
                    self._send(404, {"error": {"message": "not found"}})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = 0
                if not 0 < length <= MAX_BODY:
                    self._send(413, {"error": {"message": "body too large"}})
                    return
                try:
                    payload = json.loads(self.rfile.read(length))
                    messages = payload["messages"]
                    if not isinstance(messages, list) or not messages:
                        raise ValueError
                except (ValueError, KeyError, TypeError):
                    self._send(400, {"error": {"message": "invalid request"}})
                    return
                if not lan._busy.acquire(timeout=120):
                    self._send(429, {"error": {"message": "server busy"}})
                    return
                try:
                    provider = lan.router.provider("ollama")
                    installed = lan.router.models("ollama")
                    requested = payload.get("model")
                    model = requested if requested in installed else lan.router.model_for("ollama")
                    if not model:
                        self._send(503, {"error": {"message": "no local model installed on server"}})
                        return
                    result = provider.chat(model, messages, tools=payload.get("tools") or None,
                                           max_tokens=min(int(payload.get("max_tokens") or 2048), 8192),
                                           temperature=float(payload.get("temperature", 0.4)),
                                           json_mode=(payload.get("response_format") or {}).get("type") == "json_object")
                    lan.requests_served += 1
                    message = {"role": "assistant", "content": result.content}
                    if result.tool_calls:
                        message["tool_calls"] = [{"id": c["id"], "type": "function", "function": {
                            "name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)}}
                            for c in result.tool_calls]
                    self._send(200, {"id": "chatcmpl-" + secrets.token_hex(8), "object": "chat.completion",
                                     "created": int(time.time()), "model": model,
                                     "choices": [{"index": 0, "message": message,
                                                  "finish_reason": "tool_calls" if result.tool_calls else "stop"}]})
                except ProviderError as error:
                    status = 400 if error.code in ("bad_request", "tools_unsupported") else 503
                    self._send(status, {"error": {"message": error.code + (" tool" if error.code == "tools_unsupported" else ""),
                                                  "type": error.code}})
                except (ValueError, TypeError):
                    self._send(400, {"error": {"message": "invalid request"}})
                finally:
                    lan._busy.release()

        return Handler
