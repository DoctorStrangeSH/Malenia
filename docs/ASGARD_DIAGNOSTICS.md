## 2026-11-14 — 0.6.6 / Bridge 1.6.3 — preserve found-order routing in batches

- User supplied a 03.10 sheet and a first-order DataLens history containing OK scans at SC 101366 on 05.10. The expected outcome is Found without Asgard. Screenshots do not identify which order caused the Asgard stage of the 20-order batch.
- Reproduced a batch defect: accumulated scan histories were capped at 100 rows for the entire batch; a later DataLens failure discarded the partial snapshot and Asgard fell back to all inventory keys. This could re-query already found cargo and mask the DataLens failure with an Asgard failure.
- Browser and Python reconciliation now permit up to 2000 DataLens rows (20 orders x 100 scans), retaining 100 scans per individual order. Other source row bounds are unchanged.
- Exact-search audits stop on upstream failure, keep its source/reason, do not reconcile incomplete evidence and never treat missing DataLens schema as a reason to search all keys in Asgard.
- Updated on-screen explanation: Asgard can refer to other unresolved orders in the same batch. Only complete acknowledged batches advance the sheet cursor.
- Regression coverage uses synthetic cargo IDs with the reported dates/SC: found-only order skips Asgard; mixed batch routes only the unresolved order; 20 x 24 history rows reconcile; later DataLens errors and unknown schema stop before Asgard; oversized per-order history remains rejected.
- Validation: 105 Node tests, 236 Python tests (one Windows-only skip), frontend production build. Windows 0.6.6 installer and real user session still need confirmation.
- This fixes a reproducible routing defect; do not claim screenshots prove that exact defect caused this particular run. Automatic Sheets writeback remains unimplemented in the browser audit flow.

## 2026-11-14 — Browser Bridge 1.6.2 — missing Asgard search field

- Real user screenshot now reports search_field_missing on Asgard, sheet 03.10. This proves the detailed failure pipeline works; it does not establish whether missing field is hydration, layout, authentication, or navigation.
- Workplace adapter waits up to 12 seconds for SPA controls rather than treating tabs.status=complete as form readiness. Reverse-flow navigation occurs at most once, respects aria-selected, then waits for controls.
- Captions support aria-labelledby, visible sibling label/span/div/p within a single editable-field container, trailing colon/required marker, and containers containing hidden inputs. Never infer a field by ordinal position or across multiple editable fields.
- Existing source-result freshness and exact identity checks remain. Other filled Asgard filters still stop the search.
- Validation: all 99 Node tests passed, including delayed form hydration, sibling/ARIA captions, hidden input, reverse-flow navigation, ambiguous field rejection, stale/wrong results and worker integration.
- Only extension changes: update Browser Bridge to 1.6.2 and Continue. Existing source bindings persist. Desktop 0.6.5 installer run 43597985196 succeeded.
- Real Asgard search success and automatic Sheets writeback remain unconfirmed/unimplemented respectively.

## 2026-11-14 — 0.6.5 / Browser Bridge 1.6.1 — actionable Asgard failures

- User screenshots: sheet 03.10 stops on Asgard with a generic batch failure. Shared-tab metadata exists; screenshots do not establish the exact adapter failure.
- Workplace search now distinguishes missing/ambiguous barcode field, other filled Asgard filters, missing/ambiguous Find button, ambiguous reverse-flow navigation, and unconfirmed results after 15 seconds. No raw site exceptions or identifiers enter saved diagnostics.
- Background forwards allowlisted reasons through finish_browser_audit only when host advertises detailed_audit_failures. Older hosts receive execution_failed; prevents rejected finish messages and stuck running jobs.
- Store accepts bounded codes, UI explains them and preserves cursor. Popup also localizes new codes. Updated current-tab setup guidance in source cards.
- Important: this is diagnostic repair, not proof Asgard works. Strict result freshness/identity checks remain. Automatic Sheets writeback and Asgard extended history are still absent.
- Validation: 97 Node tests, 234 Python tests (one platform skip), frontend production build. Windows installer and real workplace session need separate confirmation.
- User has authorized main updates. Earlier historical entries saying not to update main are superseded.

