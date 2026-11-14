import unittest

from malenia.site_reconciliation import SiteSnapshotError, reconcile_tables


def snapshots():
    return {
        "inventory": {
            "columns": ["cargo_place", "inventory_date"],
            "rows": [["TEST-001", "2026-09-12"], ["TEST-002", "2026-09-12"]],
        },
        "datalens": {
            "columns": ["main_partner_code_original", "sc_id", "result", "scanned_at"],
            "rows": [["TEST-001", "101366", "OK", "2026-09-14T10:00:00"],
                     ["TEST-002", "222", "OK", "2026-09-19T11:00:00"]],
        },
        "asgard": {
            "columns": ["cargo_place", "status"],
            "rows": [["TEST-002", "Принят на ФФ"]],
        },
    }


class SiteReconciliationTests(unittest.TestCase):
    def test_reviewed_datalens_scan_history_schema_and_display_formats(self):
        data = snapshots()
        data["datalens"]["columns"][0] = "place_external_id"
        data["datalens"]["rows"][0] = ["TEST-001", "101\u00a0366", "OK", "2026/10/05 20:35:36"]
        result = reconcile_tables(data)
        self.assertEqual(result["summary"]["found"], 1)

    def test_03_10_inventory_finds_05_10_scan_without_asgard(self):
        data = snapshots()
        data["inventory"]["rows"] = [["VOZ_MK_TEST_001", "2026-10-03"]]
        data["datalens"]["columns"][0] = "place_external_id"
        data["datalens"]["rows"] = [
            ["VOZ_MK_TEST_001", "101 366", "OK", "2026/10/05 16:51:32"],
            ["VOZ_MK_TEST_001", "101 366", "OK", "2026/09/29 14:59:51"],
        ]
        data["asgard"]["rows"] = []
        self.assertEqual(reconcile_tables(data)["summary"],
                         {"found": 1, "in_progress": 0, "manual_review": 0})

    def test_twenty_scan_histories_are_not_limited_to_100_rows_together(self):
        data = snapshots()
        codes = [f"TEST-{i}" for i in range(20)]
        data["inventory"]["rows"] = [[code, "2026-10-03"] for code in codes]
        data["datalens"]["rows"] = [
            [code, "101366", "OK", "2026-10-05 16:51:32"]
            for code in codes for _ in range(24)]
        data["asgard"]["rows"] = []
        self.assertEqual(reconcile_tables(data)["summary"]["found"], 20)
        # The per-order bound is unchanged.
        data["datalens"]["rows"] = [
            [codes[0], "101366", "OK", "2026-10-05 16:51:32"]] * 101
        with self.assertRaises(SiteSnapshotError):
            reconcile_tables(data)
        data["datalens"]["rows"] *= 20
        with self.assertRaises(SiteSnapshotError):
            reconcile_tables(data)

    def test_conflicting_datalens_identity_columns_are_rejected(self):
        data = snapshots()
        data["datalens"]["columns"].append("place_external_id")
        for row in data["datalens"]["rows"]:
            row.append("OTHER")
        with self.assertRaises(SiteSnapshotError):
            reconcile_tables(data)

    def test_joins_visible_tables_without_writes(self):
        value = reconcile_tables(snapshots())
        self.assertEqual(value["total"], 2)
        self.assertEqual(value["summary"], {
            "found": 1, "in_progress": 1, "manual_review": 0
        })
        self.assertFalse(value["write_enabled"])
        self.assertTrue(value["read_only"])
        self.assertNotIn("TEST-001", str(value))

    def test_unknown_data_requires_manual(self):
        data = snapshots()
        data["datalens"]["rows"] = []
        data["asgard"]["rows"] = []
        self.assertEqual(reconcile_tables(data)["summary"]["manual_review"], 2)

    def test_duplicate_asgard_is_ambiguous(self):
        data = snapshots()
        data["asgard"]["rows"].append(["TEST-002", "Выдан"])
        self.assertEqual(reconcile_tables(data)["summary"]["manual_review"], 1)

    def test_duplicate_inventory_fails_closed(self):
        data = snapshots()
        data["inventory"]["rows"].append(["TEST-001", "2026-09-12"])
        self.assertEqual(reconcile_tables(data)["summary"]["manual_review"], 2)

    def test_transit_history_is_not_inferred_from_summary_cell(self):
        data = snapshots()
        data["datalens"]["rows"] = []
        data["asgard"]["columns"] = [
            "cargo_place", "status", "box_id", "extended_history_statuses"
        ]
        data["asgard"]["rows"] = [["TEST-002", "В пути", "BOX-12", "Выдан"]]
        self.assertEqual(reconcile_tables(data)["summary"]["manual_review"], 2)

    def test_invalid_schema_does_not_guess(self):
        for transform in [
            lambda x: x["inventory"].update(columns=["barcode", "date"]),
            lambda x: x["datalens"].update(columns=["cargo_place", "sc", "status", "date"]),
            lambda x: x["asgard"].update(rows=[["TEST-002"]]),
            lambda x: x["inventory"].update(rows=[["TEST-001", "not-a-date"]]),
            lambda x: x["inventory"].update(rows=[["TEST-001", "2026-09-12"]] * 101),
        ]:
            data = snapshots()
            transform(data)
            with self.subTest(data=data), self.assertRaises(SiteSnapshotError):
                reconcile_tables(data)


if __name__ == "__main__":
    unittest.main()
