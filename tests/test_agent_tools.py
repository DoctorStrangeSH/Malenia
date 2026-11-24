import base64
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from malenia.agent_tools import ToolBox, ToolError, calculate, spreadsheet_id
from malenia.assistant import Assistant
from malenia.attachments import AttachmentError, docx_text, extract_text, pdf_text, prepare, xlsx_text
from malenia.providers import ChatResult, ModelRouter
from malenia.settings import MemorySecretStore, SettingsStore
from malenia.skills import SkillRegistry
from malenia.store import TaskStore
from malenia import training


class FakeLocal:
    id = "ollama"

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def list_models(self):
        return ["qwen3:4b"]

    def chat(self, model, messages, tools=None, **options):
        self.calls.append(messages)
        return self.script.pop(0) if self.script else ChatResult("ок")


class FakeSheets:
    def __init__(self, current):
        self.current, self.written = current, None

    def read_values(self, sid, rng, value_render_option="UNFORMATTED_VALUE"):
        return {"range": rng, "values": self.current}

    def write_values(self, sid, rng, values):
        self.written = (sid, rng, values)
        return {"updatedCells": sum(len(r) for r in values)}


def xlsx_bytes():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   '<sheet name="Заказы" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<si><t>Заказ</t></si><si><t>Статус</t></si><si><t>Найден</t></si></sst>')
        z.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                   '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
                   '<row r="2"><c r="A2"><v>12345</v></c><c r="C2" t="s"><v>2</v></c></row></sheetData></worksheet>')
    return buffer.getvalue()


def docx_bytes():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   '<w:body><w:p><w:r><w:t>Привет, </w:t></w:r><w:r><w:t>мир</w:t></w:r></w:p><w:p><w:r><w:t>Вторая строка</w:t></w:r></w:p></w:body></w:document>')
    return buffer.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "db.sqlite3")
        self.settings = SettingsStore(self.store)
        self.settings.set("agent.workspace", str(Path(self.tmp.name) / "work"))
        self.skills = SkillRegistry(self.store)
        self.toolbox = ToolBox(self.store, self.settings, skills=self.skills)

    def tearDown(self):
        self.tmp.cleanup()


class ToolTests(Base):
    def test_calculate_is_exact_and_safe(self):
        self.assertEqual(calculate("(1250*3+400)/2"), 2075)
        self.assertEqual(calculate("2^10"), 1024)
        self.assertAlmostEqual(calculate("sqrt(16)+1,5"), 5.5)
        for bad in ("__import__('os')", "open('x')", "9**999999", "[x for x in ()]"):
            with self.assertRaises(ToolError):
                calculate(bad)

    def test_workspace_is_confined(self):
        ws = self.toolbox.workspace
        self.assertEqual(ws.write("notes/plan.md", "# План"), str(Path("notes/plan.md")))
        self.assertEqual(ws.read("notes/plan.md"), "# План")
        self.assertEqual(ws.list("notes")[0]["name"], "plan.md")
        for escape in ("../secret.txt", "/etc/passwd", "notes/../../x.txt"):
            with self.assertRaises(ToolError):
                ws.write(escape, "x")
        with self.assertRaises(ToolError):
            ws.write("run.exe", "x")
        with self.assertRaises(ToolError):
            ws.set_root(str(Path.home()))

    def test_safe_tools_run_and_confirm_tools_wait(self):
        done = self.toolbox.run("calculate", {"expression": "2+2"}, "c")
        self.assertEqual(done, {"status": "done", "result": {"result": 4}})
        pending = self.toolbox.run("write_file", {"path": "a.txt", "content": "hello"}, "c")
        self.assertEqual(pending["status"], "pending")
        self.assertFalse((self.toolbox.workspace.root() / "a.txt").exists())
        cancelled = self.toolbox.decide(pending["action"]["id"], approve=False)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertFalse((self.toolbox.workspace.root() / "a.txt").exists())
        again = self.toolbox.decide(pending["action"]["id"], approve=True)
        self.assertEqual(again["status"], "cancelled")  # a decision is final
        second = self.toolbox.run("write_file", {"path": "a.txt", "content": "hello"}, "c")
        approved = self.toolbox.decide(second["action"]["id"], approve=True)
        self.assertEqual(approved["status"], "done")
        self.assertEqual((self.toolbox.workspace.root() / "a.txt").read_text("utf-8"), "hello")

    def test_learn_skill_is_immediately_active(self):
        result = self.toolbox.run("learn_skill", {"title": "Письма поставщикам", "when": "письмо поставщику",
                                                  "steps": "1. Номер заказа в теме\n2. На «вы»"}, "c")
        self.assertEqual(result["status"], "done")
        matched = self.skills.matching("напиши письмо поставщику")
        self.assertEqual(matched[0]["title"], "Письма поставщикам")

    def test_sheet_write_requires_approval_and_protects_formulas(self):
        url = "https://docs.google.com/spreadsheets/d/" + "a" * 30 + "/edit#gid=0"
        self.assertEqual(spreadsheet_id(url), "a" * 30)
        self.toolbox.sheets = FakeSheets([["=SUM(A1:A2)"]])
        pending = self.toolbox.run("update_google_sheet", {"spreadsheet": url, "range": "A3", "values": [["1"]]}, "c")
        self.assertEqual(self.toolbox.decide(pending["action"]["id"], True)["status"], "failed")
        self.toolbox.sheets = FakeSheets([["old"]])
        pending = self.toolbox.run("update_google_sheet", {"spreadsheet": url, "range": "A3", "values": [["new"]]}, "c")
        self.assertIsNone(self.toolbox.sheets.written)
        self.assertEqual(self.toolbox.decide(pending["action"]["id"], True)["status"], "done")
        self.assertEqual(self.toolbox.sheets.written[2], [["new"]])

    def test_ui_tool_is_returned_to_the_app(self):
        result = self.toolbox.run("open_inventory", {"start": True}, "c")
        self.assertEqual(result["status"], "ui")
        self.assertEqual(result["action"]["result"], {"ui": "open_inventory", "start": True})


class AttachmentTests(unittest.TestCase):
    def test_office_formats(self):
        text = xlsx_text(xlsx_bytes())
        self.assertIn("## Лист: Заказы", text)
        self.assertIn("Заказ;Статус", text)
        self.assertIn("12345;;Найден", text)
        self.assertEqual(docx_text(docx_bytes()), "Привет, мир\nВторая строка")

    def test_pdf_text_from_simple_stream(self):
        import zlib
        stream = zlib.compress(b"BT /F1 12 Tf 72 712 Td (Hello PDF) Tj ET")
        pdf = b"%PDF-1.4\n1 0 obj<</Filter/FlateDecode>>stream\n" + stream + b"\nendstream endobj\n%%EOF"
        self.assertIn("Hello PDF", pdf_text(pdf))

    def test_prepare_mixes_text_and_images(self):
        png = base64.b64encode(b"\x89PNG fake").decode()
        text, images, meta = prepare([
            {"name": "data.csv", "mime": "text/csv", "data": base64.b64encode("a;b\n1;2".encode()).decode()},
            {"name": "photo.png", "mime": "image/png", "data": png}])
        self.assertIn("Файл «data.csv»", text)
        self.assertEqual(images[0]["image_url"]["url"], "data:image/png;base64," + png)
        self.assertEqual([m["kind"] for m in meta], ["file", "image"])
        with self.assertRaises(AttachmentError):
            prepare([{"name": "x.bin", "data": base64.b64encode(b"\x00\x01\x02").decode()}])
        with self.assertRaises(AttachmentError):
            extract_text("old.xls", b"x")


class AssistantActionTests(Base):
    def make(self, script):
        settings = self.settings
        local = FakeLocal(script)
        router = ModelRouter(settings, MemorySecretStore(), lambda: ["qwen3:4b"], ollama=local)
        assistant = Assistant(self.store, router, skills=self.skills, background=False, toolbox=self.toolbox)
        return assistant, local

    def test_pending_action_is_shown_with_answer_and_updated_after_decision(self):
        assistant, _ = self.make([
            ChatResult("", [{"id": "1", "name": "write_file", "arguments": {"path": "итоги.md", "content": "# Итоги"}}]),
            ChatResult("Подготовил файл, нажмите «Выполнить»."),
        ])
        reply = assistant.chat({"message": "Сохрани итоги в файл", "private": True})
        action = reply["message"]["meta"]["actions"][0]
        self.assertEqual(action["status"], "pending")
        self.toolbox.decide(action["id"], approve=True)
        conversation = assistant.get_conversation(reply["conversation_id"])
        self.assertEqual(conversation["messages"][1]["meta"]["actions"][0]["status"], "done")

    def test_attachment_text_reaches_model_and_history(self):
        assistant, local = self.make([ChatResult("В файле 1 заказ."), ChatResult("Да, 12345.")])
        data = base64.b64encode(xlsx_bytes()).decode()
        first = assistant.chat({"message": "Сколько заказов?", "private": True,
                                "attachments": [{"name": "inv.xlsx", "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "data": data}]})
        self.assertIn("12345", local.calls[0][-1]["content"])
        self.assertEqual(first["user_message"]["content"], "Сколько заказов?")
        self.assertEqual(first["user_message"]["meta"]["attachments"][0]["name"], "inv.xlsx")
        assistant.chat({"message": "Какой номер?", "conversation_id": first["conversation_id"], "private": True})
        self.assertTrue(any("12345" in str(m["content"]) for m in local.calls[-1][1:-1]))

    def test_learned_skill_reported_in_reply(self):
        assistant, _ = self.make([
            ChatResult("", [{"id": "1", "name": "learn_skill", "arguments": {"title": "Отчёт", "when": "отчёт за день", "steps": "Сначала итоги, потом проблемы"}}]),
            ChatResult("Выучил."),
        ])
        reply = assistant.chat({"message": "Запомни, как делать отчёт за день: сначала итоги, потом проблемы", "private": True})
        self.assertEqual(reply["message"]["meta"]["skills_learned"][0]["title"], "Отчёт")


class TrainingTests(Base):
    def test_export_skips_rejected_answers_and_doubles_liked(self):
        local = FakeLocal([ChatResult("хороший"), ChatResult("плохой")])
        router = ModelRouter(self.settings, MemorySecretStore(), lambda: ["qwen3:4b"], ollama=local)
        assistant = Assistant(self.store, router, skills=self.skills, background=False)
        assistant.add_memory("Предпочитает краткость", "preference")
        good = assistant.chat({"message": "вопрос один", "private": True})
        bad = assistant.chat({"message": "вопрос два", "conversation_id": good["conversation_id"], "private": True})
        assistant.feedback(good["message"]["id"], 1)
        assistant.feedback(bad["message"]["id"], -1)
        result = training.export_dataset(assistant, Path(self.tmp.name) / "train")
        lines = [json.loads(l) for l in Path(result["path"]).read_text("utf-8").splitlines()]
        self.assertEqual(result["examples"], 2)
        self.assertTrue(all(l["messages"][-1]["content"] == "хороший" for l in lines))
        self.assertIn("Предпочитает краткость", lines[0]["messages"][0]["content"])
        stats = training.stats(assistant)
        self.assertEqual((stats["liked"], stats["disliked"]), (1, 1))

    def test_personal_model_payload(self):
        sent = {}

        class Opener:
            def open(self, request, timeout):
                sent.update(json.loads(request.data))

                class Response:
                    def __enter__(self): return self
                    def __exit__(self, *a): return False
                    def read(self, n): return b'{"status":"success"}'
                return Response()

        router = ModelRouter(self.settings, MemorySecretStore(), lambda: [], ollama=FakeLocal([]))
        assistant = Assistant(self.store, router, skills=self.skills, background=False)
        assistant.add_memory("Работает в СЦ", "fact")
        created = training.create_personal_model(assistant, "qwen3:4b", opener=Opener())
        self.assertEqual(created["model"], "malenia:latest")
        self.assertEqual((sent["model"], sent["from"]), ("malenia", "qwen3:4b"))
        self.assertIn("Работает в СЦ", sent["system"])


if __name__ == "__main__":
    unittest.main()


class VisionAndShopTests(Base):
    def test_photo_goes_to_a_local_model_that_can_see(self):
        class Local(FakeLocal):
            def list_models(self):
                return ["qwen3:1.7b", "gemma4:12b"]

            def capabilities(self, model):
                return {"vision", "tools"} if model.startswith("gemma4") else {"tools"}

        local = Local([ChatResult("Это ботинок")])
        router = ModelRouter(self.settings, MemorySecretStore(), lambda: ["qwen3:1.7b"], ollama=local)
        router.save_config({**router.config(), "local_model": "qwen3:1.7b"})
        result = router.chat([{"role": "user", "content": "что на фото"}], private=True, needs_vision=True)
        self.assertEqual(result.model, "gemma4:12b")

    def test_no_vision_model_is_explained(self):
        from malenia.providers import ProviderError
        local = FakeLocal([])
        local.capabilities = lambda model: {"tools"}
        router = ModelRouter(self.settings, MemorySecretStore(), lambda: [], ollama=local)
        with self.assertRaises(ProviderError) as caught:
            router.chat([{"role": "user", "content": "x"}], private=True, needs_vision=True)
        self.assertEqual(caught.exception.code, "no_vision_model")

    def test_shop_search_restricts_to_the_shop_and_gives_a_search_link(self):
        queries = []

        class Web:
            def search(self, query, limit=4):
                queries.append((query, limit))
                return [{"title": "Ботинки Ecco Track 25", "url": "https://www.lamoda.ru/p/rtl1/", "excerpt": "Ботинки"}]

        self.toolbox.web = Web()
        result = self.toolbox.run("shop_search", {"query": "ботинки ecco коричневые", "shop": "lamoda"}, "c")
        self.assertEqual(queries, [("site:lamoda.ru ботинки ecco коричневые", 8)])
        self.assertEqual(result["result"]["results"][0]["url"], "https://www.lamoda.ru/p/rtl1/")
        self.assertTrue(result["result"]["shop_search_links"]["lamoda"].startswith("https://www.lamoda.ru/catalogsearch/result/?q="))


class PreviewTests(unittest.TestCase):
    def test_only_safe_small_previews_are_kept(self):
        good = "data:image/jpeg;base64," + base64.b64encode(b"thumb").decode()
        _, _, meta = prepare([{"name": "a.jpg", "mime": "image/jpeg", "data": base64.b64encode(b"x").decode(), "preview": good},
                              {"name": "b.jpg", "mime": "image/jpeg", "data": base64.b64encode(b"x").decode(), "preview": "javascript:alert(1)"}])
        self.assertEqual(meta[0]["preview"], good)
        self.assertNotIn("preview", meta[1])
