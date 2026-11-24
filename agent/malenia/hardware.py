"""Detect RAM/GPU and recommend a local model that fits this computer."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess

from .resources import ResourceManager

GIB = 1024 ** 3

# Each tier lists Ollama tags from best to fallback (all verified Ollama
# library tags; Ollama 0.40 supports Gemma 4 and Qwen 3.5).
TIERS = [
    {"id": "gpu-24", "min_vram": 20, "label": "Мощная видеокарта (20+ ГБ)",
     "models": ["gemma4:31b", "gemma4:26b", "qwen3.5:27b"]},
    {"id": "gpu-16", "min_vram": 14, "label": "Видеокарта 16 ГБ",
     "models": ["gemma4:26b", "gpt-oss:20b", "gemma4:12b"]},
    {"id": "gpu-8-ram", "min_vram": 7.5, "min_ram": 28, "label": "Видеокарта 8–12 ГБ + 32 ГБ ОЗУ",
     "models": ["gemma4:26b", "gemma4:12b", "qwen3.5:9b"]},
    {"id": "gpu-8", "min_vram": 7.5, "label": "Видеокарта 8–12 ГБ",
     "models": ["gemma4:12b", "qwen3.5:9b", "gemma4:e4b"]},
    {"id": "gpu-6", "min_vram": 5, "label": "Видеокарта 6 ГБ",
     "models": ["qwen3.5:4b", "gemma4:e4b"]},
    {"id": "cpu-32", "min_ram": 28, "label": "Без видеокарты, 32+ ГБ ОЗУ",
     "models": ["gemma4:26b", "qwen3.5:9b", "gpt-oss:20b"]},
    {"id": "cpu-16", "min_ram": 14, "label": "Без видеокарты, 16 ГБ ОЗУ",
     "models": ["qwen3.5:4b", "gemma4:e4b"]},
    {"id": "cpu-8", "min_ram": 7, "label": "Без видеокарты, 8 ГБ ОЗУ",
     "models": ["qwen3.5:2b", "gemma4:e2b"]},
    {"id": "tiny", "min_ram": 0, "label": "Слабый компьютер",
     "models": ["qwen3.5:0.8b", "qwen3:0.6b"]},
]

# Catalogue shown in "Другая модель". size = download GB (approx.), moe = only a
# few billion parameters active per token, so it stays fast with part of it in RAM.
CATALOG = [
    {"tag": "gemma4:31b", "name": "Gemma 4 31B", "size": 20, "moe": False, "note": "Самая умная Gemma, нужна мощная видеокарта"},
    {"tag": "gemma4:26b", "name": "Gemma 4 26B (MoE)", "size": 18, "moe": True, "note": "Почти как 31B, но быстрее: активны ~4B параметров"},
    {"tag": "gemma4:12b", "name": "Gemma 4 12B", "size": 7.6, "moe": False, "note": "Лучший баланс для видеокарты 8 ГБ, понимает картинки"},
    {"tag": "gemma4:e4b", "name": "Gemma 4 E4B", "size": 9.6, "moe": False, "note": "Лёгкая, понимает картинки и звук"},
    {"tag": "gemma4:e2b", "name": "Gemma 4 E2B", "size": 7.2, "moe": False, "note": "Для слабых компьютеров"},
    {"tag": "qwen3.5:35b", "name": "Qwen 3.5 35B (MoE)", "size": 24, "moe": True, "note": "Сильная в инструментах и коде, быстрая для своего размера"},
    {"tag": "qwen3.5:27b", "name": "Qwen 3.5 27B", "size": 17, "moe": False, "note": "Точная, но требовательная"},
    {"tag": "qwen3.5:9b", "name": "Qwen 3.5 9B", "size": 6.6, "moe": False, "note": "Хорошо работает с инструментами"},
    {"tag": "qwen3.5:4b", "name": "Qwen 3.5 4B", "size": 3.4, "moe": False, "note": "Быстрая и лёгкая"},
    {"tag": "qwen3.5:2b", "name": "Qwen 3.5 2B", "size": 2.7, "moe": False, "note": "Для слабых компьютеров"},
    {"tag": "gpt-oss:20b", "name": "GPT-OSS 20B (MoE)", "size": 14, "moe": True, "note": "Открытая модель OpenAI, хорошо рассуждает"},
]


def fit(item: dict, ram_gb: float, vram_gb: float) -> str:
    """fast | ok | slow | no — how well a model runs on this computer."""
    need = item["size"] * 1.15
    if vram_gb and need <= vram_gb:
        return "fast"
    total = vram_gb + ram_gb * 0.6
    if need > total:
        return "no"
    if item["moe"]:
        return "ok"
    return "ok" if vram_gb and need <= vram_gb * 1.35 else "slow"


def catalog(ram_gb: float, vram_gb: float) -> list[dict]:
    return [{**item, "fit": fit(item, ram_gb, vram_gb)} for item in CATALOG]


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
        needs_vram = "min_vram" in tier
        if needs_vram and vram_gb < tier["min_vram"]:
            continue
        if "min_ram" in tier and ram_gb < tier["min_ram"]:
            continue
        if needs_vram or "min_ram" in tier:
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
        _cache = {**hardware, "recommendation": recommend(hardware["ram_gb"], hardware["vram_gb"]),
                  "catalog": catalog(hardware["ram_gb"], hardware["vram_gb"])}
    return _cache
