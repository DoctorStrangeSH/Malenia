import tempfile
import threading
import unittest
from pathlib import Path

from malenia import browser_commands
from malenia.agent_tools import ToolBox, ToolError
from malenia.browser_commands import BrowserCommands
from malenia.native_messaging import handle_message
from malenia.settings import SettingsStore
from malenia.store import TaskStore


class BrowserCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "db.sqlite3")

    def tearDown(self):
        self.tmp.cleanup()

    def extension(self, reply):
        """A fake extension claiming one command through the native protocol."""
        def work():
            claimed = handle_message({"type": "claim_browser_command", "request_id": "r", "wait": 5}, self.store)
            command = claimed["command"]
            self.seen = command
            handle_message({"type": "finish_browser_command", "request_id": "r2", "id": command["id"],
                            "result": reply(command)}, self.store)
        thread = threading.Thread(target=work)
        thread.start()
        return thread

    def test_round_trip_through_extension_protocol(self):
        commands = BrowserCommands(self.store)
        thread = self.extension(lambda c: {"url": c["args"]["url"], "title": "Asgard", "text": "Грузоместо 123",
                                           "elements": [{"ref": 1, "kind": "input", "label": "Штрихкод коробки"}]})
        result = commands.run("open", {"url": "https://asgard.example/returnBox/search"})
        thread.join()
        self.assertEqual(self.seen["action"], "open")
        self.assertEqual(result["title"], "Asgard")

    def test_tool_errors_are_explained(self):
        commands = BrowserCommands(self.store)
        tools = ToolBox(self.store, SettingsStore(self.store), browser=commands)
        thread = self.extension(lambda c: {"error": "risky_button"})
        outcome = tools.run("browser_click", {"ref": 3}, "c1")
        thread.join()
        self.assertEqual(outcome["status"], "error")
        self.assertIn("меняет данные", outcome["error"])

    def test_without_extension_command_expires_quickly(self):
        commands = BrowserCommands(self.store)
        import time
        original = time.time
        start = original()
        # Pretend 9 seconds passed after the first poll.
        calls = iter([start] + [start + 9] * 1000)
        browser_commands.time.time = lambda: next(calls)
        try:
            self.assertEqual(commands.run("read", {}), {"error": "extension_not_connected"})
        finally:
            browser_commands.time.time = original
        self.assertIsNone(browser_commands.claim(self.store))

    def test_finish_rejects_bad_input(self):
        self.assertFalse(browser_commands.finish(self.store, "x", {}))
        self.assertFalse(browser_commands.finish(self.store, "0" * 36, "text"))


if __name__ == "__main__":
    unittest.main()
