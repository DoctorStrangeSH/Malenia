## 2026-11-14 — Browser Bridge 1.6.6 — native DataLens control adapter

- Real user still reports search_field_missing after selecting the Orders deep link. Actual corporate DOM is unavailable; do not call the task fixed based on mocks or packaging checks.
- Reviewed primary upstream DataLens source rather than guessing new labels: datalens-tech/datalens-ui, src/ui/libs/DatalensChartkit/components/Control/Items/withWrapForControls.js and Items.js, plus src/shared/constants/qa/control.ts.
- Upstream wrapper exposes data-qa=chartkit-control, its caption via chartkit-control-title / chartkit-control-item__title-text, and full label in title attributes. Adapter now resolves that exact widget boundary and requires a single editable input; includes full caption title rather than only truncated text or a fixed ancestor depth.
- Upstream BaseControlInput commits through keypress charCode=13 or blur, after React onUpdate changes local state. Added deferred Enter keypress and blur, retaining exact cargo/result identity and freshness checks. Previous keydown/keyup alone did not match the published handler.
- Capability inspection now reads the same widget caption, still never reading field values. If live discovery still fails, request that structured diagnostic on the actual Orders tab; stop treating repeated missing-field screenshots as enough DOM evidence.
- Validation: 119 Node tests including native wrapper/full-title matching, deferred React state + keypress, and rejection of multiple editable fields in a widget. No desktop version bump. Bridge 1.6.6 is a source-based adapter improvement, not proof of successful corporate-site audit.

## 2026-11-14 — 0.6.7 installer — WebView2 cleanup race

- Failed Windows installer run 43602902240 / job 132471279286 compiled and bundled the installer successfully. Single-instance/agent lifecycle smoke test failed while leaving TemporaryDirectory: WinError 32 on webview-test/EBWebView/lockfile. Subsequent installer upgrade and artifact upload steps were skipped.
- packaging/smoke_test_desktop_instance.py now retries its isolated TemporaryDirectory cleanup for at most 15 seconds after owned processes have been closed. It retains standard read-only cleanup handling and still raises on persistent locks; no browser process killing or ignore-cleanup-errors workaround.
- A real smoke assertion is preserved if a second cleanup error occurs (added as exception note). Agent-start, single-instance and agent-stop assertions are unchanged.
- Five targeted regression tests passed, covering transient lock, permanent lock, other I/O errors, retained primary failure and mandatory cleanup after success. Python compilation and whitespace checks passed.
- No application or Bridge version bump: rebuild 0.6.7 / 1.6.5. Node 20 deprecation warning was not the failing cause; dependency upgrades are outside this repair.
- Confirmed: replacement Windows run 43603887345 succeeded on commit b84be43ba43f10718fd23e4c2dd726e196a49bb2. Desktop single-instance/auto-start/agent-stop, profile cleanup, installer upgrade, and both artifact uploads passed. Artifacts: malenia-windows-installer (14118285294), malenia-browser-extension (14118135746). Installer 0.6.7 and Bridge 1.6.5 are available from that run. Real DataLens/Asgard audit success remains a separate user-session check.

## 2026-11-14 — 0.6.7 / Bridge 1.6.5 — preserve DataLens Orders route

- User screenshot shows DataLens navigation ambiguity mislabeled as Asgard reverse flow. Corrected desktop wording by source: Orders for DataLens; reverse flow for Asgard.
- The user supplied the known dashboard Orders route `94srinatuhls4-sc?tab=qmM`. Normalize existing path-only bindings to that known Orders route without another setup. Preserve validated bounded DataLens tab IDs, discard state/filter payloads; other services still reject query parameters in normalized automation targets.
- Active-tab binding and tab discovery use the same source URL canonicalizer. Unrelated parameters, URL credentials, duplicate or malformed tab IDs are not persisted.
- Navigation now prioritizes actual tab roles and then captions inside the observed tab strip. A same-named page heading is not treated as a second tab. Known direct qmM routes wait for form hydration rather than clicking ambiguous captions prematurely.
- Validation: 115 Node tests, 236 Python tests (one Windows-only skip), frontend production build. Covers supplied route and old binding through queued searches, active-tab persistence, heading duplication, hydration and source-specific error wording.
- Bridge 1.6.5 supplies the actual navigation fix; desktop 0.6.7 corrects the error text. Existing bindings preserved. Windows installer/live corporate-session confirmation remain separate.

## 2026-11-14 — Browser Bridge 1.6.4 — navigate DataLens to Orders

- User screenshot identifies the real missing-field case: a new DataLens dashboard tab opens on the default SC overview, and order search lives on the Orders tab. Source URL sanitization retains dashboard path but drops query/fragment state.
- DataLens adapter now selects visible exact «Заказы» before searching when the order form is absent, waits for SPA controls, and never clicks again when a deep link already exposes the form.
- Supports semantic tabs/links/buttons and plain caption spans within a strip recognized by the observed adjacent labels «Статистика», «Массовые сканы», «Многоместка». Ambiguous captions and links to another origin are rejected before clicking.
- Only Browser Bridge changes: version 1.6.4, existing source settings preserved. No desktop reinstall required for this fix.
- Validation: 109 Node tests passed (default dashboard, lazy tabs, plain caption, existing Orders form, ambiguous/unrelated captions, foreign link); live corporate dashboard remains unavailable here, so actual search success still needs user confirmation.

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

