"""Second transport for the browser extension: loopback HTTP.

Native Messaging is the primary channel, but organisations often disable
user-level native hosts with a browser policy (NativeMessagingUserLevelHosts),
which makes the browser report "host not found". While the Malenia app is
running, the extension can instead POST the same protocol messages here.

Authentication: the browser sets the Origin header of extension requests to
chrome-extension://<id>/ and web pages cannot forge it. Only the bundled
extension ID (and an ID registered by the user) are accepted, the listener is
loopback-only and the Host header is checked by the server.
"""
from __future__ import annotations

import json
import re

from .native_messaging import configured_extension_id, handle_message

BUNDLED_EXTENSION_ID = "cbalbbednlnkjakimgigdnfmkgdpccbi"
PATH = "/v1/extension/message"
MAX_BODY = 1024 * 1024


def allowed_origins() -> set[str]:
    origins = {f"chrome-extension://{BUNDLED_EXTENSION_ID}"}
    try:
        configured = configured_extension_id()
        if re.fullmatch(r"[a-p]{32}", configured):
            origins.add(f"chrome-extension://{configured}")
    except (ValueError, OSError):
        pass
    return origins


def _origin(handler) -> str | None:
    origin = (handler.headers.get("Origin") or "").rstrip("/")
    return origin if origin in allowed_origins() else None


def _send(handler, status: int, payload: dict, origin: str | None) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    if origin:
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.end_headers()
    handler.wfile.write(body)


def handle(handler, method: str, path: str, store, sheets=None) -> bool:
    if path != PATH:
        return False
    if not handler._valid_host():
        _send(handler, 403, {"ok": False, "error": "invalid_host"}, None)
        return True
    origin = _origin(handler)
    if origin is None:
        _send(handler, 403, {"ok": False, "error": "extension_not_allowed"}, None)
        return True
    if method == "OPTIONS":
        handler.send_response(204)
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Access-Control-Allow-Methods", "POST")
        handler.send_header("Access-Control-Allow-Headers", "Content-Type")
        handler.send_header("Access-Control-Max-Age", "600")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return True
    if method != "POST":
        _send(handler, 405, {"ok": False, "error": "method_not_allowed"}, origin)
        return True
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        length = 0
    if not 0 < length <= MAX_BODY:
        _send(handler, 413, {"ok": False, "error": "body_size_not_allowed"}, origin)
        return True
    try:
        payload = json.loads(handler.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError
    except (ValueError, UnicodeDecodeError):
        _send(handler, 400, {"ok": False, "error": "invalid_json"}, origin)
        return True
    response = handle_message(payload, store, google_sheets=sheets)
    if response.get("type") == "hello" and response.get("ok"):
        response = {**response, "transport": "http"}
    _send(handler, 200, response, origin)
    return True
