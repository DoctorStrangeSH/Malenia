"""Command-line entry point for the Malenia local agent."""

from __future__ import annotations

import argparse
import errno
import os
import secrets
import sys

from . import __version__
from .config import database_path
from .resources import ResourceManager
from .server import create_server, run_server
from .store import TaskStore


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the local Malenia agent.")
    parser.add_argument("--host", default="127.0.0.1", help="Loopback address only.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan", action="store_true",
                        help="Share this computer's local model with your other computers (port 8766).")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("For safety, Malenia only listens on localhost.")
    if not 1 <= args.port <= 65535:
        raise SystemExit("Port must be between 1 and 65535.")

    store = TaskStore(database_path())
    snapshot = ResourceManager().snapshot()
    token = os.environ.get("MALENIA_API_TOKEN") or secrets.token_urlsafe(32)

    # Acquire the endpoint before printing readiness or a standalone API token.
    try:
        server = create_server(args.host, args.port, store, token)
    except OSError as error:
        if error.errno in {errno.EADDRINUSE, errno.EACCES} or getattr(error, "winerror", None) in {10048, 10013}:
            print(f"Malenia Agent: port {args.port} is occupied or unavailable. "
                  "Use the existing Malenia window or stop your standalone agent. "
                  "No process was terminated.", file=sys.stderr)
            return 2
        raise

    print(f"Malenia Agent {__version__}")
    print(f"Local API: http://{args.host}:{args.port}")
    print(f"Resource mode: {snapshot.mode}")
    print(f"Available memory: {snapshot.available_memory_bytes} bytes")
    if "MALENIA_API_TOKEN" not in os.environ:
        print("Temporary API token (keep private; valid for this run only):")
        print(token)
    if args.lan:
        status = server.services.lan.configure(True)
        if status["running"]:
            print("Server mode: other computers can use this model.")
            for item in status["addresses"]:
                print(f"  Address ({item['kind']}): {item['url']}")
            print(f"  Pairing key (keep private): {status['token']}")
        else:
            print(f"Server mode failed: {status['error']}", file=sys.stderr)
    print("Press Ctrl+C to stop.")

    run_server(server)
    return 0
