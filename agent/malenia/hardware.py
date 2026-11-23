"""Detect RAM/GPU and recommend a local model that fits this computer."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess

from .resources import ResourceManager

GIB = 1024 ** 3

# Each tier lists Ollama tags from best to fallback; newer tags first, older
# well-known ones after them in case the newer tag is unavailable.
TIERS = [
    {"id": "gpu-24", "min_vram": 20, "label": "Мощная видеокарта (20+ ГБ)",
     "models": ["gemma4:26b", "qwen3.5:27b", "gpt-oss:20b", "qwen3:14b"]},
    {"id": "gpu-16", "min_vram": 14, "label": "Видеокарта 16 ГБ",
     "models": ["gpt-oss:20b", "gemma4:12b", "qwen3:14b"]},
    {"id": "gpu-8", "min_vram": 8, "label": "Видеокарта 8–12 ГБ",
     "models": ["gemma4:12b", "qwen3.5:9b", "qwen3:8b"]},
    {"id": "gpu-6", "min_vram": 5, "label": "Видеокарта 6 ГБ",
     "models": ["qwen3.5:4b", "qwen3:4b"]},
    {"id": "cpu-32", "min_ram": 28, "label": "Без видеокарты, 32+ ГБ ОЗУ",
     "models": ["gpt-oss:20b", "qwen3.5:9b", "qwen3:8b"]},
    {"id": "cpu-16", "min_ram": 14, "label": "Без видеокарты, 16 ГБ ОЗУ",
     "models": ["qwen3.5:4b", "qwen3:4b"]},
    {"id": "cpu-8", "min_ram": 7, "label": "Без видеокарты, 8 ГБ ОЗУ",
     "models": ["gemma4:e2b", "qwen3:1.7b"]},
    {"id": "tiny", "min_ram": 0, "label": "Слабый компьютер",
     "models": ["qwen3:0.6b", "qwen2.5:0.5b"]},
]


def _run(command: list[str], timeout: float = 6) -> str:
    try:
        flags = 0x08000000 if os.name == "nt" else 0
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout,
                                creationflags=flags, stdin=subprocess.DEVNULL)
        return result.stdout if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _nvidia() -> tuple[str, float] | None:
    if not shutil.which("nvidia-smi"):
        return None
    output = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    best = None
    for line in output.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and re.fullmatch(r"\d+(\.\d+)?", parts[1]):
            gb = float(parts[1]) / 1024
            if best is None or gb > best[1]:
                best = (parts[0], gb)
    return best


def _windows_adapters() -> list[tuple[str, float]]:
    # qwMemorySize is accurate above 4 GB, unlike Win32_VideoController.AdapterRAM.
    script = ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\"
              "{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | "
              "ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }")
    output = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], timeout=8)
    adapters = []
    for line in output.splitlines():
        name, _, size = line.strip().partition("|")
        if name and size.isdigit():
            adapters.append((name, int(size) / GIB))
    return adapters


def detect() -> dict:
    snapshot = ResourceManager().snapshot()
    ram_gb = round(snapshot.total_memory_bytes / GIB, 1)
    gpu, vram = None, 0.0
    found = _nvidia()
    if found:
        gpu, vram = found
    elif os.name == "nt":
        for name, size in _windows_adapters():
            # Integrated Intel graphics share system RAM; they don't speed up LLMs much.
            dedicated = not re.search(r"intel|microsoft basic", name, re.I)
            if dedicated and size > vram:
                gpu, vram = name, size
            elif gpu is None:
                gpu = name
    elif platform.system() == "Darwin" and platform.machine() == "arm64":
        gpu, vram = "Apple Silicon", ram_gb * 0.7
    return {"ram_gb": ram_gb, "gpu": gpu, "vram_gb": round(vram, 1),
            "cpu_threads": snapshot.logical_processors, "os": platform.system()}


def recommend(ram_gb: float, vram_gb: float) -> dict:
    for tier in TIERS:
        if "min_vram" in tier and vram_gb >= tier["min_vram"]:
            break
        if "min_ram" in tier and ram_gb >= tier["min_ram"]:
            break
    note = ""
    if vram_gb < 8 and ram_gb < 24:
        note = ("Этому компьютеру лучше использовать бесплатную облачную модель или "
                "подключиться к Малении на более мощном компьютере. Локальная модель — "
                "запасной вариант без интернета.")
    return {"tier": tier["id"], "label": tier["label"], "models": list(tier["models"]), "note": note}


_cache: dict | None = None


def profile(refresh: bool = False) -> dict:
    global _cache
    if _cache is None or refresh:
        hardware = detect()
        _cache = {**hardware, "recommendation": recommend(hardware["ram_gb"], hardware["vram_gb"])}
    return _cache
