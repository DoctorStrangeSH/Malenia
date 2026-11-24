"""Tools that let Malenia act, not only talk.

Risk levels:
  * safe    — read-only or local, reversible: executed immediately;
  * confirm — changes files or work systems: stored as a pending action and
              executed only after the user presses "Выполнить" in the chat;
  * ui      — performed by the desktop app (open a tool, start a check).
"""
from __future__ import annotations

import ast
import json
import math
import operator
import os
import re
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .store import TaskStore, _now

MAX_READ = 60_000


class ToolError(Exception):
    pass


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


# ---- safe arithmetic --------------------------------------------------------
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
        ast.USub: operator.neg, ast.UAdd: operator.pos}
_FUNCS = {"sqrt": math.sqrt, "round": round, "abs": abs, "min": min, "max": max, "log": math.log,
          "sin": math.sin, "cos": math.cos, "tan": math.tan, "pi": math.pi, "e": math.e, "ceil": math.ceil,
          "floor": math.floor, "sum": sum}


def calculate(expression: str) -> float:
    if not isinstance(expression, str) or len(expression) > 300:
        raise ToolError("Слишком длинное выражение")
    expression = expression.replace(",", ".").replace("^", "**").replace("×", "*").replace("÷", "/")

    def walk(node):
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            left, right = walk(node.left), walk(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 100:
                raise ToolError("Слишком большая степень")
            return _OPS[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](walk(node.operand))
        if isinstance(node, ast.Name) and node.id in ("pi", "e"):
            return _FUNCS[node.id]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
            return _FUNCS[node.func.id](*[walk(a) for a in node.args])
        if isinstance(node, (ast.List, ast.Tuple)):
            return [walk(item) for item in node.elts]
        raise ToolError("Разрешены только числа, + - * / ** % и функции sqrt, round, abs, min, max, log")

    try:
        return walk(ast.parse(expression, mode="eval"))
    except (SyntaxError, ZeroDivisionError, ValueError, TypeError, OverflowError) as error:
        raise ToolError(f"Не удалось вычислить: {error}") from None


# ---- workspace files --------------------------------------------------------
class Workspace:
    """A single folder the user allowed Malenia to read and (with approval) write."""

    TEXT = {".txt", ".md", ".csv", ".json", ".tsv", ".log", ".xml", ".html", ".py", ".js", ".ts", ".ini", ".yaml", ".yml"}

    def __init__(self, settings):
        self.settings = settings

    def root(self) -> Path:
        configured = self.settings.get("agent.workspace")
        root = Path(configured) if isinstance(configured, str) and configured else Path.home() / "Documents" / "Маления"
        root.mkdir(parents=True, exist_ok=True)
        return root.resolve()

    def set_root(self, path: str) -> str:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            raise ToolError("Нужен полный путь к папке")
        resolved = candidate.resolve()
        if resolved == Path(resolved.anchor) or resolved == Path.home().resolve():
            raise ToolError("Выберите отдельную папку, а не весь диск или домашнюю папку")
        resolved.mkdir(parents=True, exist_ok=True)
        self.settings.set("agent.workspace", str(resolved))
        return str(resolved)

    def resolve(self, relative: str) -> Path:
        if not isinstance(relative, str) or len(relative) > 300 or "\x00" in relative:
            raise ToolError("Некорректный путь")
        root = self.root()
        target = (root / relative.strip().lstrip("/\\")).resolve()
        if target != root and root not in target.parents:
            raise ToolError("Можно работать только внутри рабочей папки Малении")
        return target

    def list(self, relative: str = "") -> list[dict]:
        folder = self.resolve(relative or ".")
        if not folder.is_dir():
            raise ToolError("Папка не найдена")
        items = []
        for path in sorted(folder.iterdir())[:200]:
            if path.name.startswith("."):
                continue
            items.append({"name": path.name, "type": "folder" if path.is_dir() else "file",
                          "size": path.stat().st_size if path.is_file() else None})
        return items

    def read(self, relative: str) -> str:
        from .attachments import extract_text
        path = self.resolve(relative)
        if not path.is_file():
            raise ToolError("Файл не найден")
        if path.stat().st_size > 20 * 1024 * 1024:
            raise ToolError("Файл больше 20 МБ")
        return extract_text(path.name, path.read_bytes())[:MAX_READ]

    def write(self, relative: str, content: str) -> str:
        path = self.resolve(relative)
        if path.suffix.lower() not in self.TEXT:
            raise ToolError("Записывать можно только текстовые файлы (.txt, .md, .csv, .json …)")
        if not isinstance(content, str) or len(content) > 2_000_000:
            raise ToolError("Слишком большой файл")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".malenia-tmp")
        temporary.write_text(content, encoding="utf-8-sig" if path.suffix.lower() == ".csv" else "utf-8")
        os.replace(temporary, path)
        return str(path.relative_to(self.root()))


SHOPS = {
    "market": {"domain": "market.yandex.ru", "search": "https://market.yandex.ru/search?text="},
    "lamoda": {"domain": "lamoda.ru", "search": "https://www.lamoda.ru/catalogsearch/result/?q="},
    "ozon": {"domain": "ozon.ru", "search": "https://www.ozon.ru/search/?text="},
    "wildberries": {"domain": "wildberries.ru", "search": "https://www.wildberries.ru/catalog/0/search.aspx?search="},
    "avito": {"domain": "avito.ru", "search": "https://www.avito.ru/rossiya?q="},
}

SPREADSHEET = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})")


def spreadsheet_id(value: str) -> str:
    if not isinstance(value, str):
        raise ToolError("Нужна ссылка на таблицу")
    match = SPREADSHEET.search(value)
    candidate = match.group(1) if match else value.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", candidate):
        raise ToolError("Не похоже на ссылку Google Sheets")
    return candidate


class ToolBox:
    """Registry of tools offered to the model."""

    def __init__(self, store: TaskStore, settings, skills=None, sheets=None, web=None, knowledge=None, vault=None):
        self.vault = vault
        self.store = store
        self.settings = settings
        self.skills = skills
        self.sheets = sheets
        self.web = web
        self.knowledge = knowledge
        self.workspace = Workspace(settings)
        with store._session() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS pending_actions (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT,
                tool TEXT NOT NULL, arguments TEXT NOT NULL, summary TEXT NOT NULL,
                status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL)""")
        self.tools: dict[str, dict[str, Any]] = {}
        self._register()

    # ---- registration ---------------------------------------------------
    def add(self, name: str, description: str, parameters: dict, risk: str, handler: Callable[[dict], Any],
            summary: Callable[[dict], str] | None = None):
        self.tools[name] = {"name": name, "description": description, "parameters": parameters,
                            "risk": risk, "handler": handler, "summary": summary or (lambda a: name)}

    def specs(self, allow_web: bool = True) -> list[dict]:
        return [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                   "parameters": t["parameters"]}}
                for t in self.tools.values() if allow_web or t["name"] != "web_search"]

    def _register(self):
        text = {"type": "string"}
        self.add("calculate", "Точно вычислить арифметическое выражение. Используй для любых расчётов вместо счёта в уме.",
                 _schema({"expression": {**text, "description": "Например (1250*3+400)/7"}}, ["expression"]), "safe",
                 lambda a: {"result": calculate(a.get("expression", ""))})
        self.add("create_plan", "Сохранить задачу или план в список планов пользователя.",
                 _schema({"title": text, "details": text}, ["title"]), "safe", self._create_plan)
        self.add("list_plans", "Показать сохранённые планы и задачи пользователя.", _schema({}, []), "safe",
                 lambda a: {"plans": [{"title": t["title"], "details": t["description"][:300], "status": t["status"]}
                                      for t in self.store.list_tasks(30)]})
        self.add("learn_skill",
                 "Выучить навык: сохранить порядок действий, которому пользователь тебя учит "
                 "(«делай так», «запомни, как…», «в следующий раз…»). Навык будет применяться в похожих задачах.",
                 _schema({"title": {**text, "description": "Короткое название навыка"},
                          "when": {**text, "description": "Когда применять: ключевые слова и ситуации"},
                          "steps": {**text, "description": "Пошаговая инструкция"}}, ["title", "when", "steps"]),
                 "safe", self._learn_skill)
        self.add("list_files", "Список файлов в рабочей папке Малении (или её подпапке).",
                 _schema({"folder": {**text, "description": "Подпапка, пусто — корень"}}, []), "safe",
                 lambda a: {"root": str(self.workspace.root()), "items": self.workspace.list(a.get("folder") or "")})
        self.add("read_file", "Прочитать файл из рабочей папки (txt, csv, xlsx, docx, pdf и др.).",
                 _schema({"path": text}, ["path"]), "safe", lambda a: {"content": self.workspace.read(a.get("path", ""))})
        self.add("write_file", "Создать или перезаписать текстовый файл (txt, md, csv, json) в рабочей папке. Требует подтверждения.",
                 _schema({"path": text, "content": text}, ["path", "content"]), "confirm",
                 lambda a: {"saved": self.workspace.write(a.get("path", ""), a.get("content", ""))},
                 lambda a: f"Сохранить файл «{a.get('path', '')}» ({len(a.get('content') or '')} символов) в рабочей папке")
        self.add("read_google_sheet", "Прочитать диапазон Google-таблицы (нужно подключение Google Sheets).",
                 _schema({"spreadsheet": {**text, "description": "Ссылка или ID таблицы"},
                          "range": {**text, "description": "Например Лист1!A1:F50"}}, ["spreadsheet", "range"]),
                 "safe", self._read_sheet)
        self.add("update_google_sheet",
                 "Записать значения в диапазон Google-таблицы. Формулы не перезаписываются. Требует подтверждения пользователя.",
                 _schema({"spreadsheet": text, "range": text,
                          "values": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}},
                         ["spreadsheet", "range", "values"]), "confirm", self._write_sheet,
                 lambda a: f"Записать {sum(len(r) for r in a.get('values') or [])} ячеек в {a.get('range', '')}")
        self.add("browser_tabs", "Список рабочих вкладок, которые пользователь передал Малении из браузера.",
                 _schema({}, []), "safe",
                 lambda a: {"tabs": [{"title": t["title"], "url": t["url"]} for t in self.store.list_browser_tabs(20)]})
        self.add("shop_search",
                 "Найти товар в интернет-магазине (Яндекс Маркет, Lamoda, Ozon, Wildberries, Avito) по описанию. "
                 "Возвращает найденные карточки товаров и ссылку на поиск в самом магазине.",
                 _schema({"query": {**text, "description": "Описание товара: бренд, модель, тип, цвет, надписи"},
                          "shop": {"type": "string", "enum": list(SHOPS) + ["any"]}}, ["query"]),
                 "safe", self._shop_search)
        self.add("search_knowledge_base",
                 "Поиск по базе знаний пользователя (рабочие инструкции, процедуры, архитектура, решения). "
                 "Используй перед работой с рабочими процессами (инвентаризация, Asgard, статусы) и когда нужен опыт пользователя.",
                 _schema({"query": text}, ["query"]), "safe", self._kb_search)
        self.add("read_knowledge_document",
                 "Открыть документ базы знаний целиком или его раздел, чтобы понять процедуру полностью, а не по фрагменту.",
                 _schema({"path": {**text, "description": "Путь документа из результатов поиска или часть названия"},
                          "section": {**text, "description": "Необязательно: часть заголовка раздела"}}, ["path"]),
                 "safe", self._kb_document)
        self.add("open_inventory",
                 "Открыть инструмент инвентаризации (сверка листа ИНВенты с DataLens и Asgard) и при start=true запустить проверку выбранного листа.",
                 _schema({"start": {"type": "boolean"}}, []), "ui", lambda a: {"ui": "open_inventory", "start": bool(a.get("start"))},
                 lambda a: "Запустить проверку инвентаризации" if a.get("start") else "Открыть инвентаризацию")

    # ---- handlers -------------------------------------------------------
    def _kb_search(self, args: dict) -> dict:
        if self.vault is None:
            raise ToolError("База знаний не подключена")
        found = self.vault.search(str(args.get("query") or "")[:500], 6)
        if not found:
            return {"results": [], "note": "Ничего не найдено. Попробуй другие слова или скажи, что в базе этого нет."}
        return {"results": [{"path": f["path"], "section": f["heading"], "text": f["content"][:1500]} for f in found]}

    def _kb_document(self, args: dict) -> dict:
        if self.vault is None:
            raise ToolError("База знаний не подключена")
        from .kb import KnowledgeBaseError
        try:
            return self.vault.document(str(args.get("path") or "")[:300], (args.get("section") or None))
        except KnowledgeBaseError as error:
            raise ToolError(str(error)) from None

    def _shop_search(self, args: dict) -> dict:
        if self.web is None:
            raise ToolError("Поиск недоступен")
        query = re.sub(r"\s+", " ", str(args.get("query") or "")).strip()[:200]
        if not query:
            raise ToolError("Нужно описание товара")
        shop = args.get("shop") if args.get("shop") in SHOPS else "any"
        results = []
        domains = [SHOPS[shop]["domain"]] if shop != "any" else [s["domain"] for s in SHOPS.values()][:2]
        for domain in domains:
            try:
                for item in self.web.search(f"site:{domain} {query}", limit=8):
                    results.append({"title": item.get("title"), "url": item.get("url"), "snippet": item.get("excerpt", "")[:200]})
            except Exception:
                continue
        links = {name: info["search"] + quote(query) for name, info in SHOPS.items() if shop in ("any", name)}
        return {"results": results[:10], "shop_search_links": links,
                "note": "Если карточки не найдены, предложи пользователю ссылку на поиск в магазине."}


    def _create_plan(self, args: dict) -> dict:
        title = str(args.get("title") or "").strip()[:200]
        if not title:
            raise ToolError("Нужно название")
        task = self.store.create_task(title, str(args.get("details") or "")[:2000])
        return {"saved": task["title"]}

    def _learn_skill(self, args: dict) -> dict:
        if self.skills is None:
            raise ToolError("Навыки недоступны")
        title = str(args.get("title") or "").strip()[:80]
        when = str(args.get("when") or "").strip()[:240] or title
        steps = str(args.get("steps") or "").strip()[:1600]
        skill = self.skills.draft(str(uuid.uuid4()), title, ("Выучено в чате: " + when)[:200], steps, when)
        self.skills.approve(skill["id"])
        return {"learned_skill": {"id": skill["id"], "title": title}}

    def _read_sheet(self, args: dict) -> dict:
        if self.sheets is None:
            raise ToolError("Google Sheets не подключён")
        result = self.sheets.read_values(spreadsheet_id(args.get("spreadsheet", "")), str(args.get("range", "")))
        values = result.get("values", [])
        return {"range": result.get("range"), "rows": values[:300], "truncated": len(values) > 300}

    def _write_sheet(self, args: dict) -> dict:
        if self.sheets is None:
            raise ToolError("Google Sheets не подключён")
        sid, target = spreadsheet_id(args.get("spreadsheet", "")), str(args.get("range", ""))
        values = args.get("values")
        if not isinstance(values, list) or not values or any(not isinstance(r, list) for r in values):
            raise ToolError("Нужна таблица значений")
        current = self.sheets.read_values(sid, target, value_render_option="FORMULA").get("values", [])
        if any(isinstance(v, str) and v.startswith("=") for row in current for v in row):
            raise ToolError("В диапазоне есть формулы — запись отменена, чтобы их не сломать")
        written = self.sheets.write_values(sid, target, values)
        return {"updated_cells": written.get("updatedCells", 0), "range": target}

    # ---- execution ------------------------------------------------------
    def run(self, name: str, args: dict, conversation_id: str) -> dict:
        """Return {"status": done|pending|ui|error, ...}."""
        tool = self.tools.get(name)
        if tool is None:
            return {"status": "error", "error": "Неизвестный инструмент"}
        if not isinstance(args, dict):
            args = {}
        if tool["risk"] == "safe":
            try:
                return {"status": "done", "result": tool["handler"](args)}
            except Exception as error:  # surfaced to the model, never crashes the chat
                return {"status": "error", "error": str(getattr(error, "code", "") or error)[:300]}
        action = {"id": str(uuid.uuid4()), "conversation_id": conversation_id, "message_id": None,
                  "tool": name, "arguments": json.dumps(args, ensure_ascii=False)[:200_000],
                  "summary": tool["summary"](args)[:300], "status": "pending" if tool["risk"] == "confirm" else "ui",
                  "result": None, "created_at": _now()}
        if tool["risk"] == "ui":
            action["result"] = json.dumps(tool["handler"](args), ensure_ascii=False)
        with self.store._session() as db:
            db.execute("""INSERT INTO pending_actions VALUES (:id,:conversation_id,:message_id,:tool,:arguments,
                          :summary,:status,:result,:created_at)""", action)
        return {"status": action["status"], "action": self.public(action)}

    @staticmethod
    def public(row: dict) -> dict:
        data = dict(row)
        try:
            data["arguments"] = json.loads(data["arguments"])
        except (ValueError, TypeError):
            data["arguments"] = {}
        try:
            data["result"] = json.loads(data["result"]) if data.get("result") else None
        except ValueError:
            pass
        return data

    def attach(self, action_ids: list[str], message_id: str) -> None:
        if action_ids:
            with self.store._session() as db:
                db.executemany("UPDATE pending_actions SET message_id = ? WHERE id = ?",
                               [(message_id, i) for i in action_ids])

    def get(self, action_id: str) -> dict | None:
        with self.store._session() as db:
            row = db.execute("SELECT * FROM pending_actions WHERE id = ?", (action_id,)).fetchone()
        return self.public(dict(row)) if row else None

    def decide(self, action_id: str, approve: bool) -> dict:
        with self.store._session() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM pending_actions WHERE id = ?", (action_id,)).fetchone()
            if row is None:
                raise ToolError("Действие не найдено")
            if row["status"] != "pending":
                return self.public(dict(row))
            db.execute("UPDATE pending_actions SET status = 'running' WHERE id = ?", (action_id,))
        row = dict(row)
        if not approve:
            status, result = "cancelled", {"message": "Отменено пользователем"}
        else:
            try:
                result = self.tools[row["tool"]]["handler"](json.loads(row["arguments"]))
                status = "done"
            except Exception as error:
                status, result = "failed", {"error": str(getattr(error, "code", "") or error)[:300]}
        with self.store._session() as db:
            db.execute("UPDATE pending_actions SET status = ?, result = ? WHERE id = ?",
                       (status, json.dumps(result, ensure_ascii=False), action_id))
        return self.get(action_id)

    def for_message(self, message_id: str) -> list[dict]:
        with self.store._session() as db:
            rows = db.execute("SELECT * FROM pending_actions WHERE message_id = ? ORDER BY created_at",
                              (message_id,)).fetchall()
        return [self.public(dict(r)) for r in rows]
