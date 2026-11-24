"""Voice input: local speech recognition with whisper.cpp.

Nothing leaves the computer. On first use the engine (a few MB) and a
multilingual model are downloaded once into Malenia's data folder.
"""
from __future__ import annotations

import base64
import io
import os
import shutil
import subprocess
import tempfile
import threading
import zipfile
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, build_opener

from .config import data_directory

ENGINE_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-bin-x64.zip"
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
MODELS = {"base": 140_000_000, "small": 460_000_000}
MAX_AUDIO = 25 * 1024 * 1024


class VoiceError(Exception):
    pass


class VoiceEngine:
    def __init__(self, folder: Path | None = None, opener=None, runner=None):
        self.folder = Path(folder) if folder else data_directory() / "voice"
        self.opener = opener or build_opener()
        self.runner = runner or subprocess.run
        self.state = {"state": "idle", "progress": 0, "error": None}
        self._lock = threading.Lock()

    # ---- status ---------------------------------------------------------
    def _binary(self) -> Path | None:
        for name in ("whisper-cli.exe", "whisper-cli", "main.exe"):
            found = next(iter(sorted(self.folder.rglob(name))), None) if self.folder.exists() else None
            if found:
                return found
        system = shutil.which("whisper-cli")
        return Path(system) if system else None

    def _model(self) -> Path | None:
        for name in ("small", "base"):
            path = self.folder / f"ggml-{name}.bin"
            if path.is_file() and path.stat().st_size > MODELS[name] * 0.9:
                return path
        return None

    def status(self) -> dict:
        ready = bool(self._binary() and self._model())
        return {**self.state, "ready": ready, "model": self._model().stem.removeprefix("ggml-") if self._model() else None}

    # ---- install --------------------------------------------------------
    def install(self, model: str = "small", background: bool = True) -> dict:
        if model not in MODELS:
            raise VoiceError("Неизвестная модель")
        if not self._lock.acquire(blocking=False):
            return self.status()

        def work():
            try:
                self.folder.mkdir(parents=True, exist_ok=True)
                self.state = {"state": "installing", "progress": 0, "error": None}
                if self._binary() is None:
                    raw = self._download(ENGINE_URL, 50 * 1024 * 1024, None, share=0.05)
                    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                        target = (self.folder / "engine").resolve()
                        for info in archive.infolist():
                            path = (target / info.filename).resolve()
                            if not str(path).startswith(str(target)):
                                raise VoiceError("Повреждённый архив")
                        archive.extractall(target)
                if self._model() is None:
                    destination = self.folder / f"ggml-{model}.bin"
                    self._download(MODEL_URL.format(name=model), MODELS[model] * 2, destination, share=0.95, offset=0.05)
                self.state = {"state": "done", "progress": 1, "error": None}
            except (VoiceError, URLError, OSError, zipfile.BadZipFile) as error:
                message = str(error) if isinstance(error, VoiceError) else "Не удалось скачать голосовой движок. Проверьте интернет."
                self.state = {"state": "failed", "progress": 0, "error": message}
            finally:
                self._lock.release()

        if background:
            threading.Thread(target=work, name="malenia-voice-install", daemon=True).start()
        else:
            work()
        return self.status()

    def _download(self, url: str, limit: int, destination: Path | None, share: float, offset: float = 0.0):
        request = Request(url, headers={"User-Agent": "Malenia"})
        with self.opener.open(request, timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0) if hasattr(response, "headers") and response.headers else 0
            chunks, done = [], 0
            partial = destination.with_suffix(".part") if destination else None
            sink = open(partial, "wb") if partial else None
            try:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    done += len(chunk)
                    if done > limit:
                        raise VoiceError("Файл слишком большой")
                    if sink:
                        sink.write(chunk)
                    else:
                        chunks.append(chunk)
                    if total:
                        self.state["progress"] = round(offset + share * done / total, 3)
            finally:
                if sink:
                    sink.close()
            if partial:
                os.replace(partial, destination)
                return b""
            return b"".join(chunks)

    # ---- transcription --------------------------------------------------
    def transcribe(self, audio_b64: str, language: str = "ru") -> str:
        binary, model = self._binary(), self._model()
        if not binary or not model:
            raise VoiceError("voice_not_installed")
        try:
            audio = base64.b64decode(audio_b64, validate=True)
        except (ValueError, TypeError):
            raise VoiceError("invalid_audio") from None
        if not audio or len(audio) > MAX_AUDIO or audio[:4] != b"RIFF":
            raise VoiceError("invalid_audio")
        language = language if language in ("ru", "en", "auto") else "ru"
        with tempfile.TemporaryDirectory() as folder:
            wav = Path(folder) / "speech.wav"
            wav.write_bytes(audio)
            out = Path(folder) / "speech"
            threads = str(max(2, min(8, (os.cpu_count() or 4) - 1)))
            flags = 0x08000000 if os.name == "nt" else 0  # no console window
            result = self.runner([str(binary), "-m", str(model), "-f", str(wav), "-l", language, "-t", threads,
                                  "-nt", "-np", "-otxt", "-of", str(out)],
                                 capture_output=True, timeout=180, creationflags=flags)
            text_file = out.with_suffix(".txt")
            text = text_file.read_text("utf-8", errors="replace") if text_file.exists() else \
                (result.stdout.decode("utf-8", "replace") if isinstance(result.stdout, bytes) else str(result.stdout or ""))
        return " ".join(text.split()).strip()
