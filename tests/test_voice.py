import base64
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from malenia.voice import VoiceEngine, VoiceError


class Response(io.BytesIO):
    def __init__(self, data):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Opener:
    def __init__(self, files):
        self.files = files

    def open(self, request, timeout=0):
        return Response(self.files[request.full_url])


def engine_zip():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("Release/whisper-cli.exe", b"MZ")
    return buffer.getvalue()


class VoiceTests(unittest.TestCase):
    def test_install_then_transcribe(self):
        with tempfile.TemporaryDirectory() as folder:
            from malenia import voice
            files = {voice.ENGINE_URL: engine_zip(), voice.MODEL_URL.format(name="base"): b"0" * voice.MODELS["base"]}
            calls = []

            def runner(args, **kwargs):
                calls.append(args)
                Path(args[args.index("-of") + 1] + ".txt").write_text("  Привет,   Маления \n", "utf-8")
                return SimpleNamespace(stdout=b"", returncode=0)

            engine = VoiceEngine(Path(folder), Opener(files), runner)
            self.assertFalse(engine.status()["ready"])
            status = engine.install("base", background=False)
            self.assertTrue(status["ready"], status)
            self.assertEqual(status["model"], "base")
            wav = base64.b64encode(b"RIFF" + b"\0" * 100).decode()
            self.assertEqual(engine.transcribe(wav), "Привет, Маления")
            self.assertIn("-l", calls[0])
            with self.assertRaises(VoiceError):
                engine.transcribe(base64.b64encode(b"notwav").decode())

    def test_not_installed(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = VoiceEngine(Path(folder), Opener({}), lambda *a, **k: None)
            with self.assertRaises(VoiceError):
                engine.transcribe(base64.b64encode(b"RIFF").decode())


if __name__ == "__main__":
    unittest.main()
