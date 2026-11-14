## 2026-11-14 — 0.6.5 / Browser Bridge 1.6.1 — actionable Asgard failures

- User screenshots: sheet 03.10 stops on Asgard with a generic batch failure. Shared-tab metadata exists; screenshots do not establish the exact adapter failure.
- Workplace search now distinguishes missing/ambiguous barcode field, other filled Asgard filters, missing/ambiguous Find button, ambiguous reverse-flow navigation, and unconfirmed results after 15 seconds. No raw site exceptions or identifiers enter saved diagnostics.
- Background forwards allowlisted reasons through finish_browser_audit only when host advertises detailed_audit_failures. Older hosts receive execution_failed; prevents rejected finish messages and stuck running jobs.
- Store accepts bounded codes, UI explains them and preserves cursor. Popup also localizes new codes. Updated current-tab setup guidance in source cards.
- Important: this is diagnostic repair, not proof Asgard works. Strict result freshness/identity checks remain. Automatic Sheets writeback and Asgard extended history are still absent.
- Validation: 97 Node tests, 234 Python tests (one platform skip), frontend production build. Windows installer and real workplace session need separate confirmation.
- User has authorized main updates. Earlier historical entries saying not to update main are superseded.

