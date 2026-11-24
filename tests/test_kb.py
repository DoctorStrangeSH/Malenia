import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from malenia.agent_tools import ToolBox
from malenia.kb import KnowledgeBaseError, KnowledgeVault, split_sections
from malenia.settings import MemorySecretStore, SettingsStore
from malenia.store import TaskStore

DOC = """---
title: Наименования товаров
type: operational-instruction
status: active
---
# Наименования товаров
Вступление.
## 4. Маршрут A — прямые цифровые заказы
Открой Asgard → Заказы и найди номер заказа.
## 5. Маршрут B — логистические заказы LO
Ищи в логистике только цифры номера.
### 5.1. Если не найдено
Отметь допущение в комментарии.
"""


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    def __init__(self, data):
        self.data, self.requests = data, []

    def open(self, request, timeout=0):
        self.requests.append(request)
        return FakeResponse(self.data)


class KnowledgeVaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = TaskStore(root / "db.sqlite3")
        self.settings = SettingsStore(self.store)
        self.secrets = MemorySecretStore()
        self.folder = root / "vault"
        (self.folder / "05-Инструкции").mkdir(parents=True)
        (self.folder / ".obsidian").mkdir()
        (self.folder / "05-Инструкции" / "NAMING.md").write_text(DOC, "utf-8")
        (self.folder / ".obsidian" / "skip.md").write_text("# hidden", "utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_sections_keep_heading_path(self):
        headings = [h for h, _ in split_sections(DOC.split("---\n", 2)[2], "Doc")]
        self.assertIn("Doc › 5. Маршрут B — логистические заказы LO › 5.1. Если не найдено", headings)
        self.assertIn("Doc › 4. Маршрут A — прямые цифровые заказы", headings)

    def test_folder_sync_and_search_picks_route_by_identifier(self):
        vault = KnowledgeVault(self.store, self.settings, self.secrets)
        vault.configure({"folder": str(self.folder)})
        info = vault.sync()
        self.assertEqual(info["documents"], 1)
        self.assertEqual(info["items"][0]["title"], "Наименования товаров")
        top = vault.search("какой товар в заказе LO-1024583296", 1)[0]
        self.assertIn("LO", top["heading"])
        top = vault.search("наименование для 61225672960", 1)[0]
        self.assertIn("Маршрут A", top["heading"])
        self.assertEqual(vault.search("", 3), [])
        self.assertEqual(vault.search('"*) OR (', 3), [])

    def test_github_sync_uses_token_and_reads_markdown_only(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("owner-repo-abc/05/NAMING.md", DOC)
            archive.writestr("owner-repo-abc/attachments/a.png", b"x")
        opener = FakeOpener(buffer.getvalue())
        vault = KnowledgeVault(self.store, self.settings, self.secrets, opener=opener)
        vault.configure({"repo": "https://github.com/Owner/Repo.git", "token": "github_pat_" + "a" * 30})
        info = vault.sync()
        self.assertEqual(info["repo"], "Owner/Repo")
        self.assertTrue(info["has_token"])
        self.assertEqual(info["documents"], 1)
        request = opener.requests[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/Owner/Repo/zipball")
        self.assertTrue(request.get_header("Authorization").startswith("Bearer github_pat_"))

    def test_meaning_search_finds_section_without_shared_words(self):
        class Embedder:
            # "Toy" meanings: dimension 0 = returns/boxes, 1 = logistics, 2 = direct orders.
            def embedding_model(self):
                return "embeddinggemma:latest"

            def embed(self, model, texts):
                out = []
                for text in texts:
                    t = text.casefold()
                    out.append([1.0 if ("возврат" in t or "коробк" in t or "вернул" in t) else 0.0,
                                1.0 if "логист" in t else 0.0, 1.0 if "прям" in t or "asgard" in t else 0.1])
                return out
        extra = "# Возвраты\n## Возвратная коробка\nСмотри обратный поток по штрихкоду коробки.\n"
        (self.folder / "05-Инструкции" / "RETURNS.md").write_text(extra, "utf-8")
        vault = KnowledgeVault(self.store, self.settings, self.secrets, embedder=Embedder())
        vault.configure({"folder": str(self.folder)})
        info = vault.sync()
        self.assertTrue(info["semantic"])
        found = vault.search("клиент вернул посылку, что делать", 2)
        self.assertEqual(found[0]["path"], "05-Инструкции/RETURNS.md")

    def test_background_sync_only_when_configured(self):
        vault = KnowledgeVault(self.store, self.settings, self.secrets)
        vault.start_background_sync()
        self.assertIsNone(vault._sync_thread)

    def test_invalid_configuration_is_rejected(self):
        vault = KnowledgeVault(self.store, self.settings, self.secrets)
        with self.assertRaises(KnowledgeBaseError):
            vault.configure({"repo": "not a repo"})
        with self.assertRaises(KnowledgeBaseError):
            vault.configure({"folder": "/definitely/missing"})
        with self.assertRaises(KnowledgeBaseError):
            vault.sync()

    def test_tools_search_and_open_documents(self):
        vault = KnowledgeVault(self.store, self.settings, self.secrets)
        vault.configure({"folder": str(self.folder)})
        vault.sync()
        tools = ToolBox(self.store, self.settings, vault=vault)
        found = tools.run("search_knowledge_base", {"query": "логистические заказы LO"}, "c1")
        self.assertEqual(found["status"], "done")
        self.assertTrue(found["result"]["results"])
        doc = tools.run("read_knowledge_document", {"path": "NAMING", "section": "5.1"}, "c1")
        self.assertIn("допущение", doc["result"]["content"])
        missing = tools.run("read_knowledge_document", {"path": "nope"}, "c1")
        self.assertEqual(missing["status"], "error")


if __name__ == "__main__":
    unittest.main()


class EmptyVaultToolTests(unittest.TestCase):
    def test_empty_knowledge_base_is_reported_plainly(self):
        with tempfile.TemporaryDirectory() as folder:
            store = TaskStore(Path(folder) / "db.sqlite3")
            settings = SettingsStore(store)
            tools = ToolBox(store, settings, vault=KnowledgeVault(store, settings, MemorySecretStore()))
            outcome = tools.run("search_knowledge_base", {"query": "наименования"}, "c1")
            self.assertEqual(outcome["status"], "error")
            self.assertIn("Подключите базу знаний", outcome["error"])
