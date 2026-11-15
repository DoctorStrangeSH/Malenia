"""Bounded Found-only writes authorized by starting an inventory marking run."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .inventa import analyze_inventa, header_matches
from .site_reconciliation import reconcile_tables


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def inventory_hash(table: dict) -> str:
    if not isinstance(table, dict) or table.get("columns") != ["cargo_place", "inventory_date"]:
        raise ValueError("inventa_writeback_identity_mismatch")
    return digest(table)


def row_identity(source: dict, columns: dict, source_row: int) -> str:
    row = source["values"][source_row - 1]
    def value(key):
        index = columns.get(key, 0) - 1
        return row[index] if 0 <= index < len(row) else None
    return digest([value("order_id"), value("partner"), value("date")])


def build_context(source: dict, analysis: dict) -> dict:
    selected = analysis["audit_candidates"]
    columns = analysis["columns"]
    if (source.get("gid_selected") is not True or type(source.get("sheet_id")) is not int
            or source["sheet_id"] < 0 or not isinstance(source.get("sheet_title"), str)
            or not selected or not {"order_id", "partner", "status"}.issubset(columns)):
        raise ValueError("inventa_writeback_select_sheet")
    header = source["values"][analysis["header_row"] - 1]
    for key in ("order_id", "partner", "status"):
        matches = header_matches(header, key)
        if len(matches) != 1 or matches[0] + 1 != columns[key]:
            raise ValueError("inventa_writeback_ambiguous_columns_" + key)
    return {"spreadsheet_id": source["spreadsheet_id"], "sheet_id": source["sheet_id"],
            "sheet_title": source["sheet_title"], "columns": columns,
            "header_row": analysis["header_row"], "fingerprint": analysis["audit_fingerprint"],
            "asgard_required": True,
            "inventory_date": selected[0]["inventory_date"],
            "inventory_hash": inventory_hash({"columns": ["cargo_place", "inventory_date"],
                "rows": [[item["cargo_place"], item["inventory_date"]] for item in selected]}),
            "rows": [{"source_row": item["source_row"], "status_hash": digest(item["status"]),
                      "comment_hash": digest(str(source["values"][item["source_row"]-1][columns["comment"]-1]).strip() if "comment" in columns and len(source["values"][item["source_row"]-1]) >= columns["comment"] else ""),
                      "identity_hash": row_identity(source, columns, item["source_row"])}
                     for item in selected]}


def mark_found(sheets, context: dict, inventory: dict, datalens: dict) -> int:
    """Re-evaluate scans, re-read source identity/formulas, then write exact cells."""
    if inventory_hash(inventory) != context["inventory_hash"]:
        raise ValueError("inventa_writeback_identity_mismatch")
    result = reconcile_tables({"inventory": inventory, "datalens": datalens,
        "asgard": {"columns": ["cargo_place", "status"], "rows": []}}, include_results=True)
    found = [index for index, outcome in enumerate(result["results"])
             if outcome["proposal"]["decision"] == "found"]
    url = f'https://docs.google.com/spreadsheets/d/{context["spreadsheet_id"]}/edit?gid={context["sheet_id"]}'
    source = sheets.read_active_sheet(url, str(context["sheet_id"]))
    analysis = analyze_inventa(source["values"], source["sheet_title"], audit_batch_limit=20,
                              inventory_date=context["inventory_date"])
    header = source["values"][analysis["header_row"] - 1]
    if any(len(header_matches(header, key)) != 1 for key in ("order_id", "partner", "status")):
        raise ValueError("inventa_writeback_source_changed")
    if (source["spreadsheet_id"] != context["spreadsheet_id"]
            or source["sheet_id"] != context["sheet_id"] or source["sheet_title"] != context["sheet_title"]
            or analysis["audit_fingerprint"] != context["fingerprint"]
            or analysis["columns"] != context["columns"] or analysis["header_row"] != context["header_row"]):
        raise ValueError("inventa_writeback_source_changed")
    if any(row_identity(source, context["columns"], item["source_row"]) != item["identity_hash"]
           for item in context["rows"]):
        raise ValueError("inventa_writeback_source_changed")
    if not found:
        return 0
    # FORMULA render mode exposes formulas even when their displayed value is Found.
    status_col = context["columns"]["status"]
    column = chr(64 + status_col)  # source reader is bounded to A:Z
    rows = [context["rows"][index] for index in found]
    first, last = min(item["source_row"] for item in rows), max(item["source_row"] for item in rows)
    title = context["sheet_title"].replace("'", "''")
    values = sheets.read_values(context["spreadsheet_id"], f"'{title}'!{column}{first}:{column}{last}",
                               value_render_option="FORMULA")["values"]
    for item in rows:
        index = item["source_row"] - first
        value = str(values[index][0]).strip() if index < len(values) and values[index] else ""
        if value.startswith("="):
            raise ValueError("inventa_writeback_formula_protected")
        if value != "Найден" and digest(value) != item["status_hash"]:
            raise ValueError("inventa_writeback_source_changed")
    return sheets.mark_inventa_found(context["spreadsheet_id"], context["sheet_id"],
        context["sheet_title"], [item["source_row"] for item in rows], status_col,
        max(context["columns"].values()))


def mark_asgard(sheets, context: dict, inventory: dict, datalens: dict, asgard: dict) -> int:
    """Write only verified unresolved Asgard outcomes in the bound worksheet."""
    from .asgard_outcomes import COLUMNS, outcome
    if inventory_hash(inventory) != context["inventory_hash"] or asgard.get("columns") != COLUMNS:
        raise ValueError("inventa_writeback_identity_mismatch")
    dl = reconcile_tables({"inventory": inventory, "datalens": datalens,
        "asgard": {"columns": ["cargo_place", "status"], "rows": []}}, include_results=True)
    unresolved = {inventory["rows"][i][0]: i for i, item in enumerate(dl["results"])
                  if item["proposal"]["decision"] != "found"}
    rows = asgard.get("rows")
    if not isinstance(rows, list) or len(rows) != len(unresolved) or any(not isinstance(row, list) or not row for row in rows):
        raise ValueError("invalid_asgard_evidence")
    codes = [row[0] for row in rows]
    if len(set(codes)) != len(codes) or set(codes) != set(unresolved):
        raise ValueError("invalid_asgard_evidence")
    decisions = [(context["rows"][unresolved[row[0]]], outcome(row)) for row in rows]
    if any(decision is None for _, decision in decisions):
        raise ValueError("invalid_asgard_evidence")
    url = f'https://docs.google.com/spreadsheets/d/{context["spreadsheet_id"]}/edit?gid={context["sheet_id"]}'
    source = sheets.read_active_sheet(url, str(context["sheet_id"]))
    analysis = analyze_inventa(source["values"], source["sheet_title"], audit_batch_limit=20,
                              inventory_date=context["inventory_date"])
    header = source["values"][analysis["header_row"]-1]
    if (source["spreadsheet_id"] != context["spreadsheet_id"] or source["sheet_id"] != context["sheet_id"]
            or source["sheet_title"] != context["sheet_title"] or analysis["audit_fingerprint"] != context["fingerprint"]
            or analysis["columns"] != context["columns"] or analysis["header_row"] != context["header_row"]
            or any(len(header_matches(header, key)) != 1 for key in ("order_id", "partner", "status"))
            or any(row_identity(source, context["columns"], item["source_row"]) != item["identity_hash"] for item in context["rows"])):
        raise ValueError("inventa_writeback_source_changed")
    title = context["sheet_title"].replace("'", "''")
    updates = []
    for item, (status, comment) in decisions:
        for key, value in (("status", status), ("comment", comment)):
            if value is None:
                continue
            if key not in context["columns"] or len(header_matches(header, key)) != 1:
                raise ValueError("inventa_writeback_source_changed")
            column = context["columns"][key]
            cell = f"'{title}'!{chr(64+column)}{item['source_row']}"
            values = sheets.read_values(context["spreadsheet_id"], cell, value_render_option="FORMULA")["values"]
            old = str(values[0][0]).strip() if values and values[0] else ""
            if old.startswith("="):
                raise ValueError("inventa_writeback_formula_protected")
            if key == "comment" and old and value in [part.strip() for part in old.split(";")]:
                # Exact replay of an already-appended task marker.
                value = old
            elif old != value and digest(old) != item[key+"_hash"]:
                raise ValueError("inventa_writeback_source_changed")
            elif key == "comment" and old and old != value:
                value = old + "; " + value
            updates.append({"row": item["source_row"], "column": column, "value": value})
    if not updates:
        return 0
    sheets.mark_inventa_asgard(context["spreadsheet_id"], context["sheet_id"], context["sheet_title"], updates)
    return len(decisions)
