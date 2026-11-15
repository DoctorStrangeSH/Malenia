## 2026-11-15 — Bridge 1.6.12 — wait for the real DataLens parameter

- New retained-page screenshot confirms Orders is open, input contains the dashboard example 134305382, and all visible tables say no data. Popup is 1.6.11 / input_changed_after_submit. This is not a confirmed inventory search. Initial-control loading is a reproduced explanation, not a proven live root cause.
- Added a source-faithful real-React regression of DataLens renderLoadingStub: BaseControlInput initially has param='', value='', onChange=no-op, but accepts local text through its own state. After 2.2s /api/run supplies a nonempty param and default value, synchronizing the example back into the field. Running 1.6.11 against this fixture failed with search_results_unconfirmed / input_changed_after_submit, matching the observed stage. New code passes, with zero edits and zero submissions to the stub and exactly one real submission.
- Before the first write, inspect only the selected native input's bounded React owner ancestry (max 16 nodes per current/alternate branch, stop at its nearest dashkit widget). Recognize published ControlInput props type=input, param:string, value, onChange:function. Wait for nonempty parameter, parent value matching the visible field, and 400ms stable field/value. Bound is the existing 12s form-readiness deadline. No hooks/state/sibling traversal; no props, parameter name, values or fibers are returned or persisted. Other/unrecognized form implementations retain existing compatibility handling.
- This deliberately extends 1.6.10's native-node-only inspection to bounded owner props because native value acknowledgement cannot distinguish the editable loading stub from a loaded filter. React internals remain private/version-sensitive; public DataLens source may differ from corporate deployment.
- A recognized control that stays unloaded stops with input_loading_timeout, explicitly described as filter not loaded / search not sent. Post-submit behavior, one commit path, exact cargo/schema/date checks, and retained error tab remain. Desktop reinstall/protocol unchanged.
- Validation: 141 Node tests passed. React 18.3.1 / ReactDOM 18.3.1 / jsdom 26.1.0 full integration passed, including delayed source initialization. Script supports --loading-stub-only for the new regression. No live corporate/Chrome verification. Google Sheets writeback remains unimplemented.
- Deliver Bridge 1.6.12 ZIP. Do not claim end-to-end success before the user's inventory cargo and scan rows are confirmed on the actual service.

## 2026-11-15 — Bridge 1.6.11 — single commit and post-submit control lifecycle

- User confirmed the same input_value_reset message on 1.6.10. The prior fix did not resolve the corporate workflow. Do not describe live automation as working.
- Code review found two adapter defects: sending both Enter and blur (both submit DataLens BaseControlInput), and treating any post-submit input reset longer than one second as a pre-submit failure. The previous diagnostic did not record submission state, so the screenshot cannot distinguish these causes.
- Primary sources inspected: datalens-tech/datalens-ui main src/ui/libs/DatalensChartkit/components/Control/Items/Items.js (BaseControlInput has local text, value-sync effect, Enter and deferred blur commits); src/ui/components/DashKit/plugins/GroupControl/Control/Control.tsx (loading stub has empty value/no-op change); gravity-ui/uikit main src/components/controls/TextInput/TextInputControl.tsx (current native input forwards onBlur but omits deprecated onKeyPress). These public versions may differ from the corporate deployment.
- Choose one commit path from the selected node's current handlers: Enter when available, otherwise blur when React exposes onBlur without onKeyPress. Never send both. No retry/search is issued after submission.
- A replaced post-submit control is reacquired through the existing unique field binding. Temporary missing/reset fields wait within the existing 15s result deadline. A matching live DOM/controlled value plus changed, exact-identity, stable scan table is still required; a detached old input or matching table alone cannot confirm success. Stability restarts after a mismatch. Pre-submit node replacement stops explicitly rather than writing a new guessed field.
- Diagnostics now distinguish input_handler_unavailable, input_handler_failed, input_replaced_before_submit and input_changed_after_submit from pre-submit input_value_reset. Only fixed stage names are persisted. Popup labels no longer call input failures table parsing failures. Raw handler exceptions remain private. Native protocol and desktop installer unchanged.
- Validation: 138 Node tests passed. Real React 18.3.1/ReactDOM 18.3.1/jsdom 26.1.0 integration passed normal events, blocked native events requiring the bound handler, refused controlled state/no-submit, 2.2-second node replacement/reset after Enter, blur-only control, and exactly one submission. This is a DOM simulation, not live Chrome/corporate verification.
- Deliver Browser Bridge 1.6.11 ZIP only. User's real workflow remains unverified; automatic Google Sheets writeback remains unimplemented. If still failing, the new stage determines whether input delivery, handler availability, node replacement, or post-submit restoration failed.

## 2026-11-15 — Bridge 1.6.10 — controlled-input acknowledgement

- Confirmed user evidence: popup explicitly reports Bridge 1.6.9, inventory read complete, DataLens input_value_reset, retained error page. This narrows the observed failure to a value reset, not field discovery. The underlying React event/state mechanism is a reproduced hypothesis, not a live-site diagnosis.
- DataLens workplace interaction now runs in Chrome MAIN world so the selected control's own React props are visible. Asgard remains ISOLATED. The injected function uses only the authorized cargo and DOM; no native host or extension storage/API is exposed to page code.
- Native setter and composed input/change events are followed by acknowledgement of both DOM value and the selected input's current controlled value before Enter. If ordinary events do not update React, invoke that input's bound onChange once, then wait for its rendered props. Never traverse fibers/app state or repeatedly force the value. Missing/refusing acknowledgement stops with input_value_reset and retains the failed tab. Exact cargo, updated table, scan schema, SC/date/result requirements remain.
- Validation: 136 Node tests passed. Added scripts/verify-datalens-react-input.cjs: real React 18.3.1 + ReactDOM 18.3.1 + jsdom 26.1.0 passed normal events, blocked DOM events requiring the bound handler, and refused-state/no-submit cases. Run with NODE_PATH pointing to an external installation of those dependencies. jsdom is not a real browser and does not validate the user's corporate dashboard or Chrome extension isolation implementation.
- React source checked: packages/react-dom-bindings/src/client/ReactDOMComponentTree.js uses __reactProps$ on the DOM node for current props. This is a private implementation detail; fallback is bounded and fails when controlled value does not acknowledge the cargo.
- Deliver extension ZIP 1.6.10 only; desktop reinstall not required. Live workflow remains unconfirmed. Automatic Google Sheets writeback remains unimplemented. Next evidence is whether the retained page shows the actual inventory cargo and refreshed scan rows, with popup version/step if it fails.

## 2026-11-15 — Bridge 1.6.9 — activate workplace before inspecting controls

- User clarifies that a number already appears when a fresh dashboard opens, but it is the dashboard's example/default; the job still reports missing search field. Its presence must not be treated as proof that Malenia read an inventory order or submitted it.
- Code previously created each workplace tab with active=false, then activated it only after a failed search. This can expose a default-filled form after the job has already stopped. Foreground hydration is a hypothesis, not yet established on the live site.
- Exact approved DataLens/Asgard searches now create an active tab and focus its own browser window before waiting for controls. Generic page inspections remain background operations. Failure-page retention and exact identity/freshness checks are unchanged.
- Regression covers a SPA that exposes controls only after tab activation/window focus, plus replacement of a prefilled example with the exact inventory cargo before Enter. No dashboard default is accepted as a task seed.
- Session diagnostics now include the running manifest's bridge_version, displayed by the popup. Native job protocol and installed desktop version are unchanged.
- Validation: 132 Node tests passed. The real user's DataLens search still requires confirmation; automatic writeback remains unimplemented.
- Deliver Bridge 1.6.9 ZIP. During checking the browser comes to the foreground. For another failure use the visible retained page and popup version/step/counters, not another guessed selector change.

## 2026-11-15 — Bridge 1.6.8 — retain failed workplace page

- User now reports DataLens unmapped_search_results and says the extension opens then closes the page. This is a different failure from missing-field discovery; it does not by itself prove a search was submitted.
- Found unconditional finally cleanup of all created tabs. Failed workplace searches now retain and activate their created tab only on the authorized service origin. Successful page cleanup remains. Later failures may replace only the prior unchanged extension-owned review page; user tabs and navigated-away review pages are preserved. Cross-origin redirects are not retained.
- Added allowlisted transient failure steps: input_value_reset, input_setter_unavailable, page_changed, result_wait_timeout. Popup explains these and the retained-page state; no raw URLs, field values or page text are stored. Native protocol/version is unchanged.
- A transient controlled-input mismatch is allowed a bounded one-second grace before reporting a value reset; permanent mismatch still fails, never interprets old table data as a successful check.
- Validation: 128 Node tests passed, including retained failed tab, scoped replacement, foreign-origin cleanup, reset-value classification, and popup explanation. Live corporate search and automated writeback remain unconfirmed/unimplemented.
- Deliver extension 1.6.8 separately; installed Malenia does not need reinstalling. Inspect the retained page and popup step if the next check fails, rather than requesting the user to reconstruct HTML again.

## 2026-11-14 — Browser Bridge 1.6.7 — owner-confirmed widget binding

- User supplied actual Elements screenshots: selected input is inside data-qa=dashkit-grid-item / data-dashkit-grid-id=13, then chartkit-control, chartkit-control-title, chartkit-control-input, and input.g-text-input__control. Input has no unique ID, readonly or disabled attributes.
- Added an exact binding for this field only on the confirmed DataLens dashboard /94srinatuhls4-sc?tab=qmM. Reject multiple visible bound inputs or a non-editable bound input. Generic semantic detection remains for other pages; never select an arbitrary first text input.
- Earlier active-page diagnostic found the correct caption while automatic-page lookup still failed. Added four bounded, value-free counters to failure reports: visible_inputs, editable_inputs, bound_inputs, matched_inputs. Popup labels these «Вкладка разбора» so active-page observations are no longer confused with the new background job page. Native job persistence remains coarse (no field values or raw DOM).
- Validation: 123 Node tests passed, covering exact binding, dashboard scope, duplicate/disabled controls, and bounded automatic-page diagnostics with private text rejected. A local Chromium DOM smoke attempt could not launch due to restricted socket permissions; do not count that as browser verification.
- Bridge 1.6.7 ZIP delivered separately; desktop reinstall is unnecessary. Live DataLens/Asgard audit and automatic writeback remain unconfirmed/unimplemented respectively.
- If the real lookup still fails, inspect the popup «Вкладка разбора» counters first; do not claim another fix from active-tab screenshots alone.

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

