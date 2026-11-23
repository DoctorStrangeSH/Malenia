"""Turn chat attachments into text (or images for vision models).

Standard library only: xlsx/docx are ZIP+XML, PDF text is pulled from
content streams (good for normal text PDFs; scanned PDFs need OCR).
"""
from __future__ import annotations

import base64
import binascii
import csv
import io
import re
import zipfile
import zlib
from xml.etree import ElementTree as ET

MAX_ATTACHMENTS = 6
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MAX_TEXT = 60_000
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


class AttachmentError(ValueError):
    pass


def _xml(data: bytes):
    if b"<!DOCTYPE" in data[:2000].upper() or b"<!ENTITY" in data.upper():
        raise AttachmentError("Файл содержит запрещённые XML-конструкции")
    return ET.fromstring(data)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _zip(data: bytes) -> zipfile.ZipFile:
    archive = zipfile.ZipFile(io.BytesIO(data))
    if sum(info.file_size for info in archive.infolist()) > 200 * 1024 * 1024:
        raise AttachmentError("Архив слишком большой после распаковки")
    return archive


def xlsx_text(data: bytes, max_rows: int = 1500) -> str:
    archive = _zip(data)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        for item in _xml(archive.read("xl/sharedStrings.xml")):
            shared.append("".join(node.text or "" for node in item.iter() if _local(node.tag) == "t"))
    names = {}
    if "xl/workbook.xml" in archive.namelist():
        rels = {}
        if "xl/_rels/workbook.xml.rels" in archive.namelist():
            for rel in _xml(archive.read("xl/_rels/workbook.xml.rels")):
                rels[rel.get("Id")] = rel.get("Target", "").lstrip("/").removeprefix("xl/")
        for sheet in _xml(archive.read("xl/workbook.xml")).iter():
            if _local(sheet.tag) == "sheet":
                rid = next((v for k, v in sheet.attrib.items() if k.endswith("}id")), None)
                if rid in rels:
                    names["xl/" + rels[rid]] = sheet.get("name", "")
    sheets = sorted(n for n in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    out, rows_total = [], 0
    for path in sheets:
        out.append(f"## Лист: {names.get(path, path.rsplit('/', 1)[-1])}")
        buffer = io.StringIO()
        writer = csv.writer(buffer, delimiter=";")
        for row in _xml(archive.read(path)).iter():
            if _local(row.tag) != "row":
                continue
            cells: dict[int, str] = {}
            for cell in row:
                if _local(cell.tag) != "c":
                    continue
                ref = re.match(r"([A-Z]+)", cell.get("r", "A"))
                column = 0
                for char in ref.group(1) if ref else "A":
                    column = column * 26 + ord(char) - 64
                kind, value = cell.get("t"), None
                for child in cell:
                    if _local(child.tag) == "v":
                        value = child.text or ""
                    elif _local(child.tag) == "is":
                        value = "".join(n.text or "" for n in child.iter() if _local(n.tag) == "t")
                if kind == "s" and value is not None and value.isdigit() and int(value) < len(shared):
                    value = shared[int(value)]
                if value is not None:
                    cells[column] = value
            if cells:
                writer.writerow([cells.get(i, "") for i in range(1, max(cells) + 1)])
                rows_total += 1
            if rows_total >= max_rows:
                break
        out.append(buffer.getvalue())
        if rows_total >= max_rows:
            out.append(f"(показаны первые {max_rows} строк)")
            break
    return "\n".join(out)


def docx_text(data: bytes) -> str:
    root = _xml(_zip(data).read("word/document.xml"))
    paragraphs = []
    for paragraph in root.iter():
        if _local(paragraph.tag) == "p":
            text = "".join(node.text or "" for node in paragraph.iter() if _local(node.tag) == "t")
            if text.strip():
                paragraphs.append(text)
    return "\n".join(paragraphs)


def pptx_text(data: bytes) -> str:
    archive = _zip(data)
    slides = sorted((n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                    key=lambda n: int(re.search(r"(\d+)", n.rsplit("/", 1)[-1]).group(1)))
    out = []
    for index, name in enumerate(slides, 1):
        texts = [n.text for n in _xml(archive.read(name)).iter() if _local(n.tag) == "t" and n.text]
        out.append(f"## Слайд {index}\n" + "\n".join(texts))
    return "\n\n".join(out)


def _pdf_string(raw: bytes) -> str:
    out, i = bytearray(), 0
    escapes = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f", b"(": b"(", b")": b")", b"\\": b"\\"}
    while i < len(raw):
        char = raw[i:i + 1]
        if char == b"\\" and i + 1 < len(raw):
            nxt = raw[i + 1:i + 2]
            if nxt in escapes:
                out += escapes[nxt]; i += 2; continue
            octal = re.match(rb"[0-7]{1,3}", raw[i + 1:i + 4])
            if octal:
                out.append(int(octal.group(0), 8) & 0xFF); i += 1 + len(octal.group(0)); continue
            i += 1; continue
        out += char; i += 1
    data = bytes(out)
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", "ignore")
    return data.decode("cp1251" if re.search(rb"[\xc0-\xff]{3}", data) else "latin-1", "ignore")


def pdf_text(data: bytes) -> str:
    try:  # use a proper library when it happens to be installed
        from pypdf import PdfReader  # type: ignore
        return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)
    except Exception:
        pass
    chunks = []
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        stream = match.group(1)
        try:
            stream = zlib.decompress(stream)
        except zlib.error:
            pass
        if b"BT" not in stream:
            continue
        for block in re.findall(rb"BT(.*?)ET", stream, re.S):
            line = []
            for token in re.finditer(rb"\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f\s]+)>|T\*|Td|TD|'", block):
                value = token.group(0)
                if value.startswith(b"("):
                    line.append(_pdf_string(value[1:-1]))
                elif value.startswith(b"<"):
                    hexdata = re.sub(rb"\s", b"", token.group(1))
                    try:
                        raw = binascii.unhexlify(hexdata + (b"0" if len(hexdata) % 2 else b""))
                        line.append(raw.decode("utf-16-be", "ignore") if len(raw) % 2 == 0 and raw[:1] == b"\x00" else raw.decode("latin-1"))
                    except binascii.Error:
                        pass
                else:
                    line.append("\n" if value in (b"T*", b"'") else " ")
            chunks.append("".join(line))
    text = re.sub(r"[ \t]+", " ", "\n".join(chunks)).strip()
    return text or "(Не удалось извлечь текст: возможно, это скан. Пришлите фото страниц — модель с поддержкой изображений прочитает их.)"


def extract_text(name: str, data: bytes) -> str:
    lower = name.lower()
    try:
        if lower.endswith((".xlsx", ".xlsm")):
            return xlsx_text(data)
        if lower.endswith(".docx"):
            return docx_text(data)
        if lower.endswith(".pptx"):
            return pptx_text(data)
        if lower.endswith(".pdf"):
            return pdf_text(data)
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        raise AttachmentError(f"Не удалось прочитать «{name}»: файл повреждён или в другом формате") from None
    if lower.endswith((".xls", ".doc", ".ppt")):
        raise AttachmentError(f"Старый формат «{name}». Сохраните как .xlsx/.docx/.pptx")
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            text = data.decode(encoding)
            if "\x00" not in text:
                return text
        except UnicodeDecodeError:
            continue
    raise AttachmentError(f"«{name}» не похож на текстовый файл")


def prepare(attachments) -> tuple[str, list[dict], list[dict]]:
    """Return (text to append to the message, image parts, saved metadata)."""
    if not attachments:
        return "", [], []
    if not isinstance(attachments, list) or len(attachments) > MAX_ATTACHMENTS:
        raise AttachmentError(f"Можно приложить до {MAX_ATTACHMENTS} файлов")
    text_parts, images, meta, total = [], [], [], 0
    for item in attachments:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("data"), str):
            raise AttachmentError("Некорректное вложение")
        name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", item["name"])[:120] or "file"
        try:
            data = base64.b64decode(item["data"], validate=True)
        except (binascii.Error, ValueError):
            raise AttachmentError(f"Не удалось прочитать «{name}»") from None
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise AttachmentError("Вложения больше 12 МБ")
        mime = str(item.get("mime") or "")
        if mime in IMAGE_TYPES:
            images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{item['data']}"}})
            meta.append({"name": name, "kind": "image", "size": len(data)})
            continue
        text = extract_text(name, data)
        truncated = len(text) > MAX_TEXT
        text_parts.append(f"\n\n📎 Файл «{name}»{' (обрезан)' if truncated else ''}:\n```\n{text[:MAX_TEXT]}\n```")
        meta.append({"name": name, "kind": "file", "size": len(data), "chars": min(len(text), MAX_TEXT)})
    return "".join(text_parts), images, meta
