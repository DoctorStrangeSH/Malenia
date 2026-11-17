/* An allowlisted, read-only browser visit runner. No page actions or form access. */
var MaleniaAutomation = (() => {
  const ROLES = ["inventory", "datalens", "asgard"];
  const MAX_TEXT = 16000;
  const reviewTabs = new Map();
  const SEARCH_STEPS = new Set(["page_changed","input_setter_unavailable","input_value_reset","input_changed_after_submit","input_handler_failed","input_handler_unavailable","input_replaced_before_submit","input_loading_timeout","scan_table_missing","scan_history_widget_missing","scan_empty_unconfirmed","scan_table_ambiguous","scan_table_incomplete","scan_table_identity_mismatch","scan_row_limit","scan_header_ambiguous","scan_row_width","scan_cell_limit","result_wait_timeout","asgard_wait_loading","asgard_table_missing","asgard_table_ambiguous","asgard_table_incomplete","asgard_input_unconfirmed","asgard_result_not_refreshed","asgard_card_heading","asgard_card_box","asgard_card_history","asgard_card_status"]);
  function safeScanShape(value){
    const fields=['rows','columns','min_cells','max_cells','duplicate_required_headers','max_required_chars'];
    return value && Object.keys(value).length===fields.length && fields.every(key=>
      Number.isInteger(value[key]) && value[key]>=0 && value[key]<=1000000)?
      Object.fromEntries(fields.map(key=>[key,value[key]])):null;
  }
  function normalizeTargets(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_targets");
    if (Object.keys(input).sort().join(",") !== [...ROLES].sort().join(",")) throw new Error("invalid_roles");
    const result = {};
    for (const role of ROLES) {
      const raw = input[role];
      if (typeof raw !== "string" || raw.length > 2048) throw new Error("invalid_url");
      let url;
      try { url = new URL(raw); } catch { throw new Error("invalid_url"); }
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
          url.hash || url.port || url.hostname === "localhost" ||
          url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
        throw new Error("unsafe_target");
      }
      const datalens=url.origin==='https://datalens.yandex-team.ru';
      const tabs=url.searchParams.getAll('tab');
      if(url.search && (!datalens || tabs.length!==1 || !/^[A-Za-z0-9_-]{1,64}$/.test(tabs[0]) ||
          [...url.searchParams.keys()].some(key=>!['tab','state'].includes(key)) ||
          url.searchParams.getAll('state').length>1 ||
          (url.searchParams.has('state') && !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('state'))))) {
        throw new Error('unsafe_target');
      }
      // This dashboard's Orders route was supplied by the account owner.
      // Repair existing path-only bindings without asking them to set up again.
      const tab=datalens && url.pathname==='/94srinatuhls4-sc'?'qmM':tabs[0];
      result[role] = url.origin + url.pathname + (datalens && tab?'?tab='+tab:'');
    }
    return result;
  }
  function sourceUrl(raw) {
    const url=new URL(raw);
    if(url.username || url.password) throw new Error('unsafe_target');
    const tabs=url.searchParams.getAll('tab');
    if(url.origin==='https://datalens.yandex-team.ru' &&
        (tabs.length>1 || (tabs.length && !/^[A-Za-z0-9_-]{1,64}$/.test(tabs[0])))) throw new Error('unsafe_target');
    const candidate=url.origin+url.pathname+
      (url.origin==='https://datalens.yandex-team.ru' && tabs.length?'?tab='+tabs[0]:'');
    return normalizeTargets(Object.fromEntries(ROLES.map(role=>[role,candidate]))).datalens;
  }
  const origins = targets => [...new Set(ROLES.map(role => new URL(targets[role]).origin + "/*"))];

  async function waitLoaded(chromeApi, tabId, timeoutMs = 20000) {
    const signal=chromeApi.auditSignal;
    return new Promise((resolve, reject) => {
      let finished = false;
      const settle = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chromeApi.tabs.onUpdated.removeListener(onUpdated);
        signal?.removeEventListener('abort',onAbort);
        if (error) reject(error); else resolve();
      };
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === "complete") settle();
      };
      const onAbort=()=>settle(new Error(signal.reason==='audit_progress_unavailable'?'audit_progress_unavailable':'audit_cancelled'));
      const timer = setTimeout(() => settle(new Error("page_timeout")), timeoutMs);
      chromeApi.tabs.onUpdated.addListener(onUpdated);
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted){onAbort();return;}
      chromeApi.tabs.get(tabId).then(tab => {
        if (tab.status === "complete") settle();
      }).catch(() => settle(new Error("tab_closed")));
    });
  }

  const MAX_PAGES = 5;
  function nextPage(current, raw) {
    if (typeof raw !== "string" || !raw || raw.length > 2048) throw new Error("invalid_next_page");
    const from = new URL(current);
    const to = new URL(raw, from);
    if (to.protocol !== "https:" || to.origin !== from.origin ||
        to.username || to.password || to.hash || to.port) throw new Error("unsafe_next_page");
    return to.href;
  }

  // Public, fixed diagnostic codes: never persist raw site exceptions or URLs.
  const SAFE_FAILURE_CODES = new Set([
    "invalid_inventory_search_keys", "unmapped_search_form", "invalid_search",
    "unsafe_search_target", "unverified_search_result_identity", "unmapped_search_results",
    "changed_search_schema", "too_many_search_rows", "virtualized_or_incomplete_grid",
    "navigation_outside_allowed_origin", "search_origin_mismatch", "unexpected_document",
    "empty_page", "unmapped_paginated_table", "pagination_cycle",
    "pagination_limit", "changed_table_schema", "too_many_rows",
    "native_host_rejected", "page_timeout", "tab_closed",
    "unsupported_search_form", "dynamic_search_ui", "unsupported_dynamic_search",
    "dynamic_search_no_result_update", "dynamic_search_unchanged_table", "search_field_missing",
    "search_field_ambiguous", "search_filters_not_empty", "search_button_missing",
    "search_button_ambiguous", "search_navigation_ambiguous", "search_results_unconfirmed",
    "site_or_browser_error", "inventa_writeback_required", "inventa_writeback_failed",
    "inventa_writeback_source_changed", "inventa_writeback_formula_protected",
    "inventa_writeback_reauthorization_required", "inventa_writeback_permission_denied",
    "inventa_writeback_verification_failed", "audit_cancelled", "audit_progress_unavailable",
  ]);
  function reasonCode(error) {
    return error instanceof Error && SAFE_FAILURE_CODES.has(error.message) ?
      error.message : "site_or_browser_error";
  }

  const MAX_SEARCHES = 20;
  const MAX_BATCH_SCAN_ROWS = MAX_SEARCHES * 100;
  const MAX_DATALENS_HISTORY_ROWS = 1000;
  // Optimization only: the Python reconciliation engine remains authoritative.
  // We may avoid sending a cargo code to Asgard only with complete, exact
  // evidence of a later successful scan at the approved SC.
  function asgardSearchKeys(inventory, datalens) {
    if (!inventory || !datalens || !Array.isArray(inventory.rows) ||
        !Array.isArray(datalens.rows) || !Array.isArray(inventory.columns) ||
        !Array.isArray(datalens.columns)) return null;
    const invFields = ["cargo_place", "inventory_date"];
    const scanFields = ["main_partner_code_original", "sc_id", "result", "scanned_at"];
    if (!invFields.every(x => inventory.columns.includes(x)) ||
        !scanFields.every(x => datalens.columns.includes(x))) return null;
    const col = (table, field) => table.columns.indexOf(field);
    const unresolved = [];
    for (const row of inventory.rows) {
      if (!Array.isArray(row)) return null;
      const cargo = row[col(inventory, "cargo_place")];
      const cutoff = row[col(inventory, "inventory_date")];
      if (typeof cargo !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(cargo) ||
          typeof cutoff !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff) ||
          !Number.isFinite(Date.parse(cutoff)) ||
          new Date(cutoff).toISOString().slice(0, 10) !== cutoff) return null;
      const matching = datalens.rows.filter(scan => Array.isArray(scan) &&
        scan[col(datalens, "main_partner_code_original")] === cargo &&
        scan[col(datalens, "sc_id")] === "101366" &&
        scan[col(datalens, "result")] === "OK");
      const valid = matching.every(scan => {
        const raw = scan[col(datalens, "scanned_at")];
        return typeof raw === "string" &&
          /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(raw) &&
          Number.isFinite(Date.parse(raw));
      });
      if (!valid || !matching.some(scan => scan[col(datalens, "scanned_at")].slice(0, 10) > cutoff)) {
        unresolved.push(cargo);
      }
    }
    return unresolved;
  }
  async function exactGetSearch(chromeApi, tabId, role, cargo, origin) {
    if (!["datalens", "asgard"].includes(role) ||
        typeof cargo !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(cargo)) {
      throw new Error("invalid_search");
    }
    const results = await chromeApi.scripting.executeScript({
      target: {tabId},
      func: (resourceRole, code) => {
        const fieldName = resourceRole === "datalens" ?
          "main_partner_code_original" : "cargo_place";
        const allForms = [...document.querySelectorAll("form")];
        const forms = allForms.filter(form =>
          form.method.toLowerCase() === "get" &&
          form.querySelectorAll('input[type="password"],input[type="hidden"]').length === 0 &&
          form.querySelectorAll('input[name="' + fieldName + '"]').length === 1 &&
          form.querySelectorAll("input[name]").length === 1);
        if (forms.length !== 1) {
          // Report the type of unsupported UI, never labels, form values or URLs.
          const standaloneSearch = [...document.querySelectorAll(
            'input[type="search"],input[role="searchbox"]'
          )].some(input => !input.closest("form") &&
            (input.getAttribute("aria-label") || input.getAttribute("name") || "").trim() ===
              fieldName);
          const kind = standaloneSearch ? "dynamic_search_ui" :
            allForms.length ? "unsupported_search_form" : "unmapped_search_form";
          return {origin: location.origin, kind};
        }
        const form = forms[0];
        const input = form.querySelector('input[name="' + fieldName + '"]');
        if (!["search", "text"].includes(input.type.toLowerCase())) return null;
        const action = new URL(form.getAttribute("action") || location.href, location.href);
        if (action.origin !== location.origin || action.protocol !== "https:" ||
            action.username || action.password || action.hash || action.search) return null;
        action.searchParams.set(fieldName, code);
        return {origin: location.origin, url: action.href};
      },
      args: [role, cargo]
    });
    const result = results?.[0]?.result;
    if (!result || result.origin !== origin || typeof result.url !== "string") {
      const kind = result?.origin === origin && [
        "unsupported_search_form", "dynamic_search_ui"
      ].includes(result.kind) ? result.kind : "unmapped_search_form";
      throw new Error(kind);
    }
    const target = new URL(result.url);
    if (target.protocol !== "https:" || target.origin !== origin ||
        target.username || target.password || target.hash ||
        target.searchParams.size !== 1 ||
        target.searchParams.get(role === "datalens" ?
          "main_partner_code_original" : "cargo_place") !== cargo) {
      throw new Error("unsafe_search_target");
    }
    await chromeApi.tabs.update(tabId, {url: target.href});
  }

  async function reactiveSearch(chromeApi, tabId, role, cargo, origin) {
    if (!["datalens", "asgard"].includes(role) ||
        typeof cargo !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(cargo)) {
      throw new Error("invalid_search");
    }
    const results = await chromeApi.scripting.executeScript({
      target: {tabId},
      func: async (resourceRole, code) => {
        const fieldName = resourceRole === "datalens" ?
          "main_partner_code_original" : "cargo_place";
        // No form submission, Enter/keyboard shortcuts, clicks or scripts from the site.
        // Accept ONLY a standalone, visible, labelled search-as-you-type field.
        const matches = [...document.querySelectorAll(
          'input[type="search"],input[role="searchbox"]'
        )].filter(input => {
          if (input.closest("form") || input.disabled || input.readOnly ||
              input.type.toLowerCase() === "password") return false;
          const label = (input.getAttribute("aria-label") ||
            input.getAttribute("name") || "").trim();
          return label === fieldName && input.getClientRects().length > 0;
        });
        if (matches.length !== 1) return {origin: location.origin, status: "ambiguous"};
        const input = matches[0];
        // Observe a matching result table, not unrelated spinners/navigation.
        const expected = resourceRole === "datalens" ?
          ["main_partner_code_original", "sc_id", "result", "scanned_at"] :
          ["cargo_place", "status"];
        const containers = [...document.querySelectorAll(
          'table,[role="grid"],[role="table"]'
        )].filter(node => {
          const heads = [...node.querySelectorAll(
            'th,[role="columnheader"]'
          )].map(cell => cell.innerText.trim());
          return expected.every(header => heads.includes(header));
        });
        if (containers.length !== 1) {
          return {origin: location.origin, status: "unsupported"};
        }
        // Prove the result table actually changed; a loading-spinner or
        // unrelated mutation is not evidence of an updated result set.
        const before = containers[0].innerText;
        if (typeof before !== "string" || before.length > 16000) {
          return {origin: location.origin, status: "unsupported"};
        }
        // Use the native setter so common controlled React/Vue inputs see the update.
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, "value")?.set;
        if (typeof setter !== "function") {
          return {origin: location.origin, status: "unsupported"};
        }
        const result = await new Promise(resolve => {
          let settled = false, changed = false, settleTimer;
          const finish = status => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            clearTimeout(settleTimer);
            observer.disconnect();
            const after = containers[0].innerText;
            resolve({origin: location.origin, status:
              status === "updated" && typeof after === "string" && after !== before ?
                "updated" : status === "updated" ? "unchanged_table" : status});
          };
          const observer = new MutationObserver(() => {
            if (settled) return;
            changed = true;
            clearTimeout(settleTimer);
            // Wait for the grid to settle instead of reading its loading frame.
            settleTimer = setTimeout(() => finish("updated"), 400);
          });
          observer.observe(containers[0], {subtree: true, childList: true,
            characterData: true});
          const deadline = setTimeout(() => finish(changed ? "updated" : "unchanged"), 6000);
          setter.call(input, code);
          input.dispatchEvent(new Event("input", {bubbles: true}));
        });
        return result;
      },
      args: [role, cargo]
    });
    const outcome = results?.[0]?.result;
    if (!outcome || outcome.origin !== origin ||
        outcome.status !== "updated") {
      throw new Error(outcome?.status === "unchanged" ?
        "dynamic_search_no_result_update" :
        outcome?.status === "unchanged_table" ?
          "dynamic_search_unchanged_table" : "unsupported_dynamic_search");
    }
  }

  // The reverse-flow list describes different boxes, not duplicate evidence.
  // Reuse the task-owned tab; verify each linked card before using its history.
  async function asgardWorkplaceSearch(chromeApi, tabId, code, origin) {
    const start=await chromeApi.tabs.get(tabId);
    let result;
    try {
      result=await asgardSearchAttempt(chromeApi,tabId,code,origin,'barcode');
    } catch(error) {
      if(error.message!=='asgard_no_exact_cargo'||!/^\d{1,20}$/.test(code)) {
        if(error.message==='asgard_no_exact_cargo')throw new Error('unverified_search_result_identity');
        throw error;
      }
    }
    if(result && (result.rows[0]?.[5]!=='not_found'||!/^\d{1,20}$/.test(code)))return result;
    // A bare numeric inventory key can be an external order ID. A barcode
    // miss is not proof that this order has no return boxes.
    const target=new URL(start.url);
    if(target.origin!==origin||target.username||target.password)throw new Error('search_origin_mismatch');
    await chromeApi.tabs.update(tabId,{url:target.href});await waitLoaded(chromeApi,tabId);
    return asgardSearchAttempt(chromeApi,tabId,code,origin,'order');
  }

  async function asgardSearchAttempt(chromeApi, tabId, code, origin, searchKind) {
    if(origin!=="https://asgard.market.yandex-team.ru"||!/^[A-Za-z0-9_.-]{1,128}$/.test(code))throw new Error("unsupported_dynamic_search");
    const probe=async(action)=>{
      const response=await chromeApi.scripting.executeScript({target:{tabId},world:'ISOLATED',
        func:async(action,code,origin,searchKind)=>{
          if(location.origin!==origin)return {error:'search_origin_mismatch'};
          const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
          const text=el=>clean(el?.innerText??el?.textContent);
          const canonicalStatuses=['В пути','Готов для отгрузки в заборную логистику','Готов для выдачи','Выдан','Принят на ФФ'];
          const normalizeStatus=value=>canonicalStatuses.find(status=>status.toLowerCase()===clean(value).toLowerCase())||clean(value);
          const visible=el=>el.getClientRects().length>0;
          const failure=(error,step)=>({error,...(step?{step}:{})});
          const required=['Статус грузоместа','ID возврата','ID партнера','ID коробки','Точка назначения'];
          const resultTable=table=>table?.matches?.('table')&&required.every(name=>Array.from(table.querySelectorAll('tr')[0]?.querySelectorAll('th')||[]).map(text).includes(name));
          const emptyMessage=s=>/^(Нет данных|Ничего не найдено|Нет результатов|Данные не найдены|Коробки не найдены)$/i.test(clean(s));
          // The corporate page uses custom message wrappers, not necessarily
          // Ant classes/ARIA roles. Its exact reverse-flow empty message is
          // sufficient markup evidence; freshness and live query still apply.
          const noticeNodes='div,span,p,strong,b,h1,h2,h3,h4,h5,h6,section,output';
          const emptyNotice=el=>el?.nodeType===1 && visible(el) &&
            !el.closest('table,nav,header,footer,[role="dialog"],[role="tooltip"],[aria-hidden="true"]') &&
            (/^Коробки не найдены$/i.test(text(el)) ||
              !!el.closest('.ant-alert,[role="alert"],[role="status"]') && emptyMessage(text(el))) &&
            ![...el.children].some(child=>emptyMessage(text(child)));
          const containsEmptyNotice=el=>!!el && (emptyNotice(el)||[...el.querySelectorAll(noticeNodes)].some(emptyNotice));
          const withinResults=node=>{
            const el=node?.nodeType===1?node:node?.parentElement;
            return !!el&&(resultTable(el)||resultTable(el.closest?.('table'))||emptyNotice(el));
          };
          const touchesResults=node=>{
            const el=node?.nodeType===1?node:node?.parentElement;
            return withinResults(el)||!!el&&([...el.querySelectorAll('table')].some(resultTable)||containsEmptyNotice(el));
          };
          const loading=()=>[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],.ant-spin-spinning')].some(visible)||
            [...document.querySelectorAll('button')].some(el=>visible(el)&&el.disabled&&text(el)==='Найти');
          const controls=()=>{
            const inputs=[...document.querySelectorAll('input')].filter(el=>visible(el)&&!el.disabled&&!el.readOnly);
            const matches=inputs.filter(el=>{
              const captions=[el.placeholder,el.getAttribute('aria-label'),...Array.from(el.labels||[]).map(x=>x.textContent)];
              for(const id of (el.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean))captions.push(document.getElementById(id)?.textContent);
              let parent=el.parentElement;
              for(let i=0;parent&&i<6;i++,parent=parent.parentElement){
                if([...parent.querySelectorAll('input')].filter(x=>visible(x)&&!x.disabled&&!x.readOnly).length!==1)break;
                captions.push(parent.textContent);
                for(const label of parent.querySelectorAll('label,span,div'))if(visible(label))captions.push(label.textContent);
              }
              return captions.some(s=>(searchKind==='order'?/^Внешний ID заказа\s*[:*]?$/i:/^Штрихкод коробки\s*[:*]?$/i).test(clean(s)));
            });
            return {inputs,matches};
          };
          if(action==='cleanup'){globalThis.__maleniaAsgardSearch?.observer?.disconnect();delete globalThis.__maleniaAsgardSearch;return true;}
          if(action==='submit'){
            const {inputs,matches}=controls();
            if(matches.length!==1)return failure(matches.length?'search_field_ambiguous':'search_field_missing');
            const input=matches[0];
            if(inputs.some(el=>el!==input&&el.value.trim()))return failure('search_filters_not_empty');
            const buttons=[...document.querySelectorAll('button')].filter(el=>visible(el)&&!el.disabled&&text(el)==='Найти');
            if(buttons.length!==1)return failure('search_button_missing');
            const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
            if(!setter)return failure('unmapped_search_results');
            setter.call(input,code);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
            // Give React's change event a render turn before the one search click.
            await new Promise(resolve=>setTimeout(resolve,0));
            const live=controls();
            if(live.matches.length!==1||live.matches[0].value!==code)return failure('unmapped_search_results','input_value_reset');
            globalThis.__maleniaAsgardSearch?.observer?.disconnect();
            const state={code,changed:false,loadingSeen:false};
            state.observer=new MutationObserver(records=>{
              if(loading()||records.some(r=>r.type==='attributes'&&r.attributeName==='disabled'&&r.oldValue!==null&&text(r.target)==='Найти'))state.loadingSeen=true;
              if(records.some(r=>r.type!=='attributes'&&(withinResults(r.target)||[...r.addedNodes,...r.removedNodes].some(touchesResults))))state.changed=true;
            });
            // React may replace the whole table, or mount it only after searching.
            // Observe its stable ancestor, but only result mutations count as fresh.
            state.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['disabled','aria-busy','class','style']});
            globalThis.__maleniaAsgardSearch=state;
            buttons[0].click();if(loading())state.loadingSeen=true;return {submitted:true};
          }
          if(loading()){
            if(globalThis.__maleniaAsgardSearch)globalThis.__maleniaAsgardSearch.loadingSeen=true;
            return {pending:true,step:'asgard_wait_loading'};
          }
          if([...document.querySelectorAll('[role="alert"],.ant-alert-error,.ant-message-error')].some(el=>visible(el)&&/ошиб|не удалось|недоступ|error|failed/i.test(text(el))))return failure('search_results_unconfirmed');
          if(action==='results'){
            const tables=[...document.querySelectorAll('table')].filter(visible).map(table=>{
              const heads=Array.from(table.querySelectorAll('tr')[0]?.querySelectorAll('th')||[]).map(el=>text(el));
              return {table,heads};
            }).filter(({heads})=>['Статус грузоместа','ID возврата','ID партнера','ID коробки','Точка назначения'].every(h=>heads.filter(x=>x===h).length===1));
            const state=globalThis.__maleniaAsgardSearch,live=controls();
            const accepted=live.matches.length===1&&live.matches[0].value===code;
            const fresh=state?.code===code&&accepted&&(state.changed||state.loadingSeen);
            const freshness={fresh,step:accepted?'asgard_result_not_refreshed':'asgard_input_unconfirmed'};
            const notices=[...document.querySelectorAll(noticeNodes)].filter(emptyNotice);
            if(!tables.length && notices.length===1)return {empty:true,...freshness};
            if(tables.length!==1 || notices.length>1)return {pending:true,step:tables.length||notices.length>1?'asgard_table_ambiguous':'asgard_table_missing'};
            const {table,heads}=tables[0];
            const rows=[...table.querySelectorAll('tr')].filter(tr=>tr.querySelectorAll('td').length);
            if(notices.length && rows.length)return {pending:true,step:'asgard_table_ambiguous'};
            const empty=rows.length===1&&rows[0].querySelectorAll('td').length===1&&emptyMessage(rows[0].textContent) || rows.length===0&&[...table.parentElement.querySelectorAll('div,span,p')].some(el=>visible(el)&&emptyMessage(el.textContent));
            if(!rows.length&&!empty)return {pending:true,step:'asgard_table_incomplete'};
            if(empty)return {empty:true,...freshness};
            if(rows.length>100)return failure('unmapped_search_results');
            const result=[];
            for(const tr of rows){
              const cells=[...tr.querySelectorAll('td')];if(cells.length!==heads.length)return {pending:true,step:'asgard_table_incomplete'};
              const cell=name=>cells[heads.indexOf(name)];
              const links=[...cell('ID коробки').querySelectorAll('a[href]')];
              const box=text(cell('ID коробки')),status=normalizeStatus(text(cell('Статус грузоместа'))),destination=text(cell('Точка назначения'));
              if(links.length!==1||!/^\d{1,20}$/.test(box)||destination.length>256)return failure('unmapped_search_results');
              const url=new URL(links[0].href,location.href);
              if(url.origin!==origin||url.username||url.password||url.pathname===location.pathname)return failure('search_origin_mismatch');
              result.push({box,status,destination,url:url.href});
            }
            return {matches:result,...freshness};
          }
          if(action==='card'){
            const cargoText=el=>text(el).match(/^Грузоместо\s*([A-Za-z0-9_.-]{1,128})$/)?.[1];
            let headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(el=>visible(el)&&cargoText(el));
            if(!headings.length)headings=[...document.querySelectorAll('div,span,p,strong,b')].filter(el=>visible(el)&&!el.closest('table')&&cargoText(el)&&![...el.children].some(child=>cargoText(child)));
            const cargo=[...new Set(headings.map(cargoText))];
            if(cargo.length!==1)return {pending:true,step:'asgard_card_heading'};
            if(searchKind!=='order'&&cargo[0]!==code)return {other:true};
            const pageText=clean(document.body.innerText||document.body.textContent);
            const ids=[...new Set([...pageText.matchAll(/ID\s*грузоместа\s*(\d{1,20})(?!\d)/g)].map(match=>match[1]))];
            if(ids.length!==1)return {pending:true,step:'asgard_card_box'};
            const box=ids[0];
            const titles=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,strong,b')].filter(el=>visible(el)&&text(el)==='История изменения статусов'&&![...el.children].some(child=>text(child)==='История изменения статусов'));
            // Header and table may be in deeply nested sibling wrappers. Require
            // a unique titled history table following its visible section title.
            const tables=[...document.querySelectorAll('table')].filter(table=>{
              const heads=[...table.querySelectorAll('tr')[0]?.querySelectorAll('th')||[]].map(text);
              return visible(table)&&heads.length===2&&heads.includes('Дата')&&heads.includes('Статус')&&titles.some(title=>title.compareDocumentPosition(table)&4);
            });
            if(tables.length!==1)return {pending:true,step:'asgard_card_history'};
            const table=tables[0],heads=[...table.querySelectorAll('tr')[0].querySelectorAll('th')].map(text);
            const data=[...table.querySelectorAll('tr')].filter(tr=>tr.querySelectorAll('td').length);
            if(!data.length||data.length>100)return {pending:true,step:'asgard_card_history'};
            const history=[];
            for(const tr of data){const cells=[...tr.querySelectorAll('td')];if(cells.length!==2)return {pending:true,step:'asgard_card_history'};const status=normalizeStatus(text(cells[heads.indexOf('Статус')]));if(!status||status.length>100)return {pending:true,step:'asgard_card_history'};history.push(status);}
            const statuses=[...new Set([...document.querySelectorAll('span,button,div,p,strong,b,a,[role="status"]')].filter(el=>visible(el)&&!el.closest('table')&&canonicalStatuses.includes(normalizeStatus(text(el)))).map(el=>normalizeStatus(text(el))))];
            if(statuses.length!==1)return {pending:true,step:'asgard_card_status'};
            return {box,history,status:statuses[0],kupishuz:/купишуз/i.test(pageText)};
          }
          return null;
        },args:[action,code,origin,searchKind]});
      const result=response?.[0]?.result;
      if(result?.error){const error=new Error(result.error);if(SEARCH_STEPS.has(result.step))error.step=result.step;throw error;}
      return result;
    };
    const before=JSON.stringify(await probe('results'));
    let ack;const readyUntil=Date.now()+10000;
    do{try{ack=await probe('submit');break;}catch(error){
      if(!['search_field_missing','search_button_missing'].includes(error.message)||Date.now()>=readyUntil)throw error;
      await new Promise(r=>setTimeout(r,250));
    }}while(true);
    if(!ack?.submitted)throw new Error('unmapped_search_results');
    let result,last='',stable=0,lastStep='asgard_result_not_refreshed';const until=Date.now()+15000;
    try{
      while(Date.now()<until){
        const now=await probe('results'),serialized=JSON.stringify(now);
        if(SEARCH_STEPS.has(now?.step))lastStep=now.step;
        if(now?.fresh===true&&!now.pending&&serialized!==before){if(serialized!==last){last=serialized;stable=Date.now();}else if(Date.now()-stable>=750){result=now;break;}}
        else stable=0;
        await new Promise(r=>setTimeout(r,250));
      }
    }finally{try{await probe('cleanup');}catch{ /* A page redirect must not hide the original error. */ }}
    if(!result){const error=new Error('search_results_unconfirmed');error.step=lastStep;throw error;}
    const columns=['cargo_place','status','box_id','destination','history_json','verification'];
    if(result.empty)return {columns,rows:[[code,'Не найден','','','[]','not_found']]};
    // Order association is proved by an acknowledged exact external-ID query,
    // refreshed results and each linked card's box ID. Only a uniform FF group
    // has a reviewed order-level decision; mixed statuses remain ambiguous.
    if(searchKind==='order' && (!result.matches.length || result.matches.some(row=>row.status!=='Принят на ФФ')))
      throw new Error('unverified_search_result_identity');
    // The owner authorizes Lamoda directly from a uniformly Купишуз destination
    // in the fresh, exact-barcode result. Do not infer a company in a mixed list.
    if(searchKind==='barcode' && result.matches.length && result.matches.every(row=>/купишуз/i.test(row.destination)))
      return {columns,rows:[[code,'Купишуз','',result.matches[0].destination,'[]','search_destination']]};
    const active=['В пути','Готов для отгрузки в заборную логистику','Готов для выдачи'];
    const rank=status=>active.includes(status)?active.indexOf(status):status==='Выдан'?active.length:active.length+1;
    const matches=result.matches.sort((a,b)=>rank(a.status)-rank(b.status));
    if(matches.length>20)throw new Error('unmapped_search_results');
    if(new Set(matches.map(row=>row.box)).size!==matches.length)throw new Error('unverified_search_result_identity');
    const confirmed=[];let foreignActive=0;
    for(const match of matches){
      // A verified transit card wins; a foreign transit card must not hide a matching issued card.
      if(confirmed.some(row=>active.includes(row[1]))&&!active.includes(match.status))continue;
      await chromeApi.tabs.update(tabId,{url:match.url});await waitLoaded(chromeApi,tabId);
      let card=null,cardStep='asgard_card_heading';const deadline=Date.now()+15000;
      while(Date.now()<deadline){
        const snapshot=await probe('card');
        if(snapshot&&!snapshot.pending){card=snapshot;break;}
        if(SEARCH_STEPS.has(snapshot?.step))cardStep=snapshot.step;
        await new Promise(r=>setTimeout(r,250));
      }
      if(!card){const error=new Error('unverified_search_result_identity');error.step=cardStep;throw error;}
      if(card?.other){if(active.includes(match.status))foreignActive++;continue;}
      if(!card||card.box!==match.box)throw new Error('unverified_search_result_identity');
      if(card.status!==match.status||!card.history.includes(match.status))throw new Error('unverified_search_result_identity');
      const company=/купишуз/i.test(match.destination);
      if(company!==card.kupishuz)throw new Error('unverified_search_result_identity');
      confirmed.push([code,match.status,match.box,match.destination,JSON.stringify(card.history),'card']);
    }
    if(confirmed.length===matches.length && confirmed.length>0 &&
        confirmed.every(row=>row[1]==='Принят на ФФ' && /купишуз/i.test(row[3])===/купишуз/i.test(confirmed[0][3])))
      return {columns,rows:[confirmed[0]]};
    if(searchKind==='barcode'&&!confirmed.length&&foreignActive===0 &&
        matches.every(row=>row.status==='Принят на ФФ'))
      throw new Error('asgard_no_exact_cargo');
    // Several exact-cargo issued cards all support the same issued decision.
    // No history from a foreign active card contributes to this outcome.
    if(confirmed.length>1 && confirmed.every(row=>row[1]==='Выдан'))return {columns,rows:[confirmed[0]]};
    // Explicit owner rule: active boxes have different cargo headings, and
    // every remaining result is issued. Preserve this as group evidence,
    // not a fabricated matching card or fabricated status history.
    if(!confirmed.length && foreignActive>0 && foreignActive===matches.filter(row=>active.includes(row.status)).length &&
        matches.some(row=>row.status==='Выдан') && matches.every(row=>active.includes(row.status)||row.status==='Выдан'))
      return {columns,rows:[[code,'Выдан','', '',JSON.stringify(matches.map(row=>row.status)),'issued_group']]};
    if(confirmed.length!==1)throw new Error('unverified_search_result_identity');
    return {columns,rows:confirmed};
  }

  async function workplaceSearch(chromeApi, tabId, role, code, origin, verifyAsgard = false) {
    if(role==='asgard' && verifyAsgard)return asgardWorkplaceSearch(chromeApi,tabId,code,origin);
    const hosts = {datalens:"https://datalens.yandex-team.ru",asgard:"https://asgard.market.yandex-team.ru"};
    if (origin !== hosts[role] || !/^[A-Za-z0-9_.-]{1,128}$/.test(code)) throw new Error("unsupported_dynamic_search");
    const response = await chromeApi.scripting.executeScript({target:{tabId},world:role==='datalens'?'MAIN':'ISOLATED',
      func: async (role, code, expectedOrigin, maxScanRows) => {
        if (location.origin !== expectedOrigin) return null;
        const clean = s => String(s || "").replace(/\s+/g," ").trim();
        const visible = el => el.getClientRects().length > 0;
        const eligible = el => ['text','search'].includes(String(el.type).toLowerCase()) &&
          visible(el) && !el.disabled && !el.readOnly;
        const wanted = role === 'asgard' ? /^Штрихкод коробки$/i : /^ID заказа\s*\/\s*ЛОТа\s*\/\s*ТОТа\s*\/\s*Тележки$/i;
        const labelMatches = text => wanted.test(clean(text).replace(/[\s:*＊]+$/g,''));
        const findControls = () => {
          const visibleInputs=[...document.querySelectorAll('input')].filter(visible);
          const inputs=visibleInputs.filter(eligible);
          let boundInputs=0;
          const failure=(error,matched=0)=>({error,surface:{visible_inputs:visibleInputs.length,
            editable_inputs:inputs.length,bound_inputs:boundInputs,matched_inputs:matched}});
          // Owner-supplied DOM identifies this exact Orders widget on this dashboard.
          // Bind its native input directly; do not infer a field by page-wide order.
          if(role==='datalens' && location.pathname==='/94srinatuhls4-sc' &&
              new URL(location.href).searchParams.get('tab')==='qmM') {
            const bound=[...document.querySelectorAll(
              '[data-qa="dashkit-grid-item"][data-dashkit-grid-id="13"] [data-qa="chartkit-control-input"] input.g-text-input__control'
            )].filter(visible);
            boundInputs=bound.length;
            if(bound.length>1) return failure('search_field_ambiguous',bound.length);
            if(bound.length===1) return eligible(bound[0])?{input:bound[0],buttons:[]}:failure('search_field_missing');
          }
          const matches=inputs.filter(el=>{
            const labels=[el.getAttribute('aria-label'),el.getAttribute('placeholder'),
              ...Array.from(el.labels || []).map(x=>x.textContent)];
            if(role==='datalens') {
              // DataLens's published withWrapForControls component owns the
              // caption and input through these stable QA/class boundaries.
              const widget=el.closest?.('[data-qa="chartkit-control"], .chartkit-control-item__control');
              if(widget && [...widget.querySelectorAll('input')].filter(eligible).length===1) {
                for(const caption of widget.querySelectorAll('[data-qa="chartkit-control-title"], .chartkit-control-item__title-text')) {
                  labels.push(caption.getAttribute('title'),caption.textContent);
                  for(const full of caption.querySelectorAll('[title]')) labels.push(full.getAttribute('title'));
                }
              }
            }
            // React forms often render the caption as a sibling, without label/for.
            for(const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
              labels.push(document.getElementById(id)?.textContent);
            }
            let parent=el.parentElement;
            for(let i=0;parent && i<6;i++,parent=parent.parentElement) {
              // Hidden widgets must not prevent reading a visible field's caption.
              // Stop before a container owning more than one editable field.
              if([...parent.querySelectorAll('input')].filter(eligible).length!==1) break;
              labels.push(parent.textContent);
              for(const caption of parent.querySelectorAll('label,span,div,p')) {
                if(visible(caption) && labelMatches(caption.textContent)) labels.push(caption.textContent);
              }
            }
            return labels.some(labelMatches);
          });
          if(matches.length!==1) return failure(matches.length?'search_field_ambiguous':'search_field_missing',matches.length);
          const input=matches[0];
          if(role==='asgard' && inputs.some(el=>el!==input && el.value.trim())) return {error:'search_filters_not_empty'};
          const buttons=role==='asgard' ? [...document.querySelectorAll('button')]
            .filter(el=>visible(el) && !el.disabled && clean(el.textContent)==='Найти') : [];
          if(role==='asgard' && buttons.length!==1) return {error:buttons.length?'search_button_ambiguous':'search_button_missing'};
          return {input,buttons};
        };
        // DataLens renders BaseControlInput even before /api/run supplies its
        // parameter. That stub accepts local text but its commit is a no-op.
        // Inspect only bounded owner ancestry of this already-bound input; never
        // enumerate other fibers, hooks, state, or dashboard contents.
        const controlLoadState=el=>{
          if(role!=='datalens')return 'unknown';
          const keys=Object.getOwnPropertyNames(el).filter(key=>key.startsWith('__reactFiber$'));
          if(keys.length!==1)return 'unknown';
          const start=Object.getOwnPropertyDescriptor(el,keys[0])?.value;
          let loading=false;
          for(const branch of [start,start?.alternate]){
            let fiber=branch;
            const seen=new Set();
            for(let depth=0;fiber && depth<16 && !seen.has(fiber);depth++,fiber=fiber.return){
              seen.add(fiber);
              const props=fiber.memoizedProps;
              if(props && props.type==='input' && typeof props.param==='string' &&
                  typeof props.onChange==='function' && Object.hasOwn(props,'value')){
                loading=true;
                if(props.param.trim() && String(props.value ?? '')===String(el.value))return 'ready';
              }
              // The nearest widget is the limit of the selected control's scope.
              if(fiber!==branch && fiber.stateNode?.getAttribute?.('data-qa')==='dashkit-grid-item')break;
            }
          }
          return loading?'loading':'unknown';
        };
        // tabs.status=complete does not mean an SPA has rendered its search form.
        const readyUntil=Date.now()+12000;
        let readyInput=null,readyValue=null,readyAt=0;
        let controls, reverseSelected=false,
          ordersSelected=role==='datalens' && location.pathname==='/94srinatuhls4-sc' &&
            new URL(location.href).searchParams.get('tab')==='qmM';
        const ordersTabs = () => {
          // Prefer semantic controls. Some dashboard tab captions are plain spans
          // whose click bubbles to a React handler on the surrounding strip.
          const caption=el=>visible(el) && !el.disabled && clean(el.textContent)==='Заказы';
          const outer=nodes=>nodes.filter(el=>!nodes.some(other=>other!==el && other.contains?.(el)));
          const roles=[...document.querySelectorAll('[role="tab"]')].filter(caption);
          if(roles.length) return outer(roles);
          const inStrip=el=>{
            let parent=el.parentElement;
            for(let i=0;parent && i<4;i++,parent=parent.parentElement) {
              const text=clean(parent.textContent);
              if(text.length>1500) break;
              if(['Статистика','Массовые сканы','Многоместка'].filter(label=>text.includes(label)).length>=2) return true;
            }
            return false;
          };
          const semantic=[...document.querySelectorAll('a,button,[role="tab"],[tabindex]')]
            .filter(el=>caption(el) && inStrip(el));
          if(semantic.length) return outer(semantic);
          return [...document.querySelectorAll('span,div')].filter(el=>caption(el) && inStrip(el) &&
            ![...(el.children || [])].some(child=>clean(child.textContent)==='Заказы'));
        };
        do {
          if(location.origin!==expectedOrigin) return {error:'search_origin_mismatch'};
          if(role==='datalens' && !ordersSelected) {
            controls=findControls();
            if(!controls.error) {
              // A saved deep link can already have the correct search form.
              ordersSelected=true;
            } else {
              const tabs=ordersTabs();
              if(tabs.length>1) {
                if(Date.now()>=readyUntil) return {error:'search_navigation_ambiguous'};
                await new Promise(resolve=>setTimeout(resolve,200));
                continue;
              }
              if(tabs.length===1) {
                const tab=tabs[0], link=tab.closest?.('a[href]');
                if(link && new URL(link.href,location.href).origin!==expectedOrigin) return {error:'search_origin_mismatch'};
                ordersSelected=true;
                if(tab.getAttribute('aria-selected')!=='true') {
                  tab.click();
                  await new Promise(resolve=>setTimeout(resolve,200));
                  continue;
                }
              }
            }
          }
          if(role==='asgard' && !reverseSelected) {
            const reverseTabs=[...document.querySelectorAll('a,button,[role="tab"]')]
              .filter(el=>visible(el) && clean(el.textContent)==='Обратный поток');
            if(reverseTabs.length>1) return {error:'search_navigation_ambiguous'};
            if(reverseTabs.length===1) {
              reverseSelected=true;
              if(reverseTabs[0].getAttribute('aria-selected')!=='true') {
                reverseTabs[0].click();
                await new Promise(resolve=>setTimeout(resolve,200));
                continue;
              }
            }
          }
          controls=findControls();
          if(!controls.error){
            const state=controlLoadState(controls.input);
            if(state==='unknown')break;
            if(state==='ready'){
              if(readyInput!==controls.input || readyValue!==controls.input.value){
                readyInput=controls.input;readyValue=controls.input.value;readyAt=Date.now();
              }else if(Date.now()-readyAt>=400)break;
            }else {readyInput=null;readyValue=null;}
            if(Date.now()>=readyUntil)return {error:'unmapped_search_results',step:'input_loading_timeout'};
            await new Promise(resolve=>setTimeout(resolve,200));
            continue;
          }
          if(!['search_field_missing','search_button_missing'].includes(controls.error)) return controls;
          if(Date.now()>=readyUntil) return controls;
          await new Promise(resolve=>setTimeout(resolve,200));
        } while(true);
        let {input,buttons}=controls;
        // Empty results are meaningful only inside the named scan widget.
        // Other dashboard widgets routinely show No Data for a found cargo.
        const caption='История сканов по заказу';
        const labelText=el=>clean(String(el?.innerText??el?.textContent??'').replace(/[\u200B-\u200D\uFEFF\u00AD]/g,''));
        const historyVisible=el=>{
          if(!visible(el) || el.closest?.('[aria-hidden="true"], [hidden], .dl-table__background-table, .gc-adaptive-tabs__select-switcher'))return false;
          for(let node=el;node;node=node.parentElement){
            const style=getComputedStyle(node);
            if(style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse')return false;
          }
          return true;
        };
        const leafLabel=(el,label)=>historyVisible(el) && labelText(el)===label &&
          !Array.from(el.children||[]).some(child=>historyVisible(child)&&labelText(child)===label);
        const historyWidgets=()=>{
          if(role!=='datalens')return [];
          // Owner DOM: chart titles live here; AdaptiveTabs also mounts an
          // offscreen select-switcher with measurable duplicate title text.
          // Bind the named chart to its own grid item, never to those copies.
          const chartTitles=[...document.querySelectorAll('.dl-widget__chart-title-text')]
            .filter(el=>historyVisible(el) && labelText(el)===caption);
          const chartRoots=[...new Set(chartTitles.map(el=>el.closest(
            '[data-qa="dashkit-grid-item"], .dashkit-grid-item')).filter(Boolean))];
          if(chartRoots.length)return chartRoots.length<=12?chartRoots:[];
          // Titles and empty cells can be links, paragraphs or custom typography.
          // Use rendered labels rather than a guessed set of element tags.
          const titles=[...document.querySelectorAll('*')].filter(el=>
            labelText(el)===caption && leafLabel(el,caption));
          if(titles.length!==1)return [];
          const title=titles[0];
          const known=title.closest?.('[data-qa="dashkit-grid-item"], .dashkit-grid-item, .react-grid-item, [data-dashkit-grid-id]');
          if(known)return [known];
          // Legacy layouts need no CSS-specific wrapper. Only a compact section
          // containing this caption and its empty/loading content can qualify;
          // never adopt an ancestor containing other widgets or search controls.
          let root=title.parentElement;
          for(let i=0;root&&i<8;i++,root=root.parentElement){
            if(root===document.body || root===document.documentElement || root.querySelector('input'))break;
            const rest=clean(labelText(root).replace(caption,'').replace(/Нет данных|Загрузка/gi,''));
            if(!rest && (root.querySelector('[aria-busy="true"],[role="progressbar"],.g-loader,.g-spin') ||
                [...root.querySelectorAll('*')].some(el=>leafLabel(el,'Нет данных'))))return [root];
          }
          return [];
        };
        const historyBusy=root=>root && (root.getAttribute('aria-busy')==='true' ||
          [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"], .g-loader, .g-spin')].some(visible));
        const explicitEmpty=root=>{
          if(!root || historyBusy(root))return false;
          if([...root.querySelectorAll('[role="alert"], .chartkit-error, .chartkit-widget-error')].some(visible))return false;
          if([...root.querySelectorAll('td')].some(el=>visible(el) && labelText(el) && labelText(el)!=='Нет данных'))return false;
          return [...root.querySelectorAll('*')].some(el=>leafLabel(el,'Нет данных'));
        };
        const freshHistoryRoots=new WeakSet(),busyHistoryRoots=new WeakSet();
        const scrolledHistoryRoots=new WeakSet();
        let historyScrollAttempts=0;
        let expectedHistoryCount=historyWidgets().length;
        let readFailure='scan_table_missing',scanShape=null;
        const read = () => {
          readFailure='scan_table_missing';scanShape=null;
          const roots=historyWidgets();
          expectedHistoryCount=Math.max(expectedHistoryCount,roots.length);
          if(role==='datalens' && !roots.length)readFailure='scan_history_widget_missing';
          if(expectedHistoryCount>1 && roots.length<expectedHistoryCount){readFailure='scan_table_ambiguous';return null;}
          if(roots.length>1 && roots.some(root=>historyBusy(root) ||
              [...root.querySelectorAll('[role="alert"], .chartkit-error, .chartkit-widget-error')].some(visible))){
            readFailure='scan_empty_unconfirmed';return null;
          }
          if(roots.length && roots.every(explicitEmpty)){
            readFailure='scan_empty_unconfirmed';
            return {columns:['main_partner_code_original','sc_id','result','scanned_at'],rows:[]};
          }
          const candidates=[],candidateTables=[];
          for(const table of document.querySelectorAll('table')) {
            // DataLens renders measurement copies through a portal offscreen.
            // They have dimensions, so getClientRects alone cannot exclude them.
            if(table.closest?.('.dl-table__background-table') ||
                table.getAttribute?.('aria-hidden')==='true' ||
                (typeof table.getClientRects==='function' && !visible(table)))continue;
            const trs=[...table.querySelectorAll('tr')];
            const heads=trs[0]?[...trs[0].querySelectorAll('th')].map(el=>clean(el.textContent)):[];
            const required=role==='datalens'?['scanned_at','sc_id','result','place_external_id']:
              ['Статус грузоместа','ID возврата','ID партнера','ID коробки'];
            if(!required.every(name=>heads.includes(name))) continue;
            // Read body sections, excluding repeated header/footer/sizing rows.
            // Some HTML puts a th-only header in tbody; it is not a scan row.
            const bodyTrs=table.tBodies?Array.from(table.tBodies).flatMap(body=>Array.from(body.rows)):
              trs.slice(1);
            const dataTrs=bodyTrs.filter(tr=>!(tr.querySelectorAll('th').length && !tr.querySelectorAll('td').length));
            if(!dataTrs.length)continue;
            const duplicateRequired=required.filter(name=>heads.filter(h=>h===name).length!==1).length;
            scanShape={rows:dataTrs.length,columns:heads.length,min_cells:0,max_cells:0,
              duplicate_required_headers:duplicateRequired,max_required_chars:0};
            if(dataTrs.length>(role==='datalens'?maxScanRows:100)){readFailure='scan_row_limit';return null;}
            if(duplicateRequired || (role!=='datalens' && new Set(heads).size!==heads.length)){
              readFailure='scan_header_ambiguous';return null;
            }
            const cells=dataTrs.map(tr=>Array.from(tr.querySelectorAll('td')));
            scanShape.min_cells=Math.min(...cells.map(row=>row.length));
            scanShape.max_cells=Math.max(...cells.map(row=>row.length));
            if(cells.some(row=>row.length!==heads.length) || dataTrs.some(tr=>tr.querySelectorAll('th').length)){
              readFailure='scan_row_width';return null;
            }
            // Only the required evidence columns affect reconciliation. Unused
            // columns can have duplicate labels or large descriptive content.
            const indexes=role==='datalens'?required.map(name=>heads.indexOf(name)):heads.map((_,i)=>i);
            const rows=cells.map(row=>row.map((cell,index)=>indexes.includes(index)?clean(cell.textContent):''));
            scanShape.max_required_chars=Math.max(...rows.flatMap(row=>indexes.map(i=>row[i].length)));
            if(scanShape.max_required_chars>256){readFailure='scan_cell_limit';return null;}
            if(role==='datalens') {
              const col=name=>heads.indexOf(name);
              // Some scans describe the sortable/container, with a rendered
              // null place identifier. They are not evidence for this cargo.
              // Ignore only absent identities; a different explicit cargo still
              // invalidates the snapshot rather than being silently filtered.
              const identified=rows.filter(row=>{
                const id=row[col('place_external_id')];
                return id!=='' && id!=='null';
              });
              if(!identified.length || identified.some(row=>row[col('place_external_id')]!==code)){
                readFailure='scan_table_identity_mismatch';return null;
              }
              candidateTables.push(table);
              candidates.push({columns:['main_partner_code_original','sc_id','result','scanned_at'],
                rows:identified.map(row=>[code,row[col('sc_id')].replace(/\s/g,''),row[col('result')],row[col('scanned_at')].replace(/\//g,'-')])});
            } else {
              // A result is bound only to the exact barcode search completed below.
              if(rows.length!==1) return null;
              candidates.push({columns:['cargo_place','status','box_id'],
                rows:[[code,rows[0][heads.indexOf('Статус грузоместа')],rows[0][heads.indexOf('ID коробки')]]]});
            }
          }
          if(role==='datalens' && roots.length>1){
            // Every named widget must be either explicitly empty or parsed.
            // Never let an empty shard hide another shard's exact-cargo scans.
            const complete=roots.every(root=>explicitEmpty(root)||candidateTables.some(table=>root.contains(table))) &&
              candidateTables.every(table=>roots.some(root=>root.contains(table)));
            if(!complete){readFailure='scan_table_incomplete';return null;}
            if(candidates.length){
              const rows=[...new Map(candidates.flatMap(table=>table.rows).map(row=>[JSON.stringify(row),row])).values()];
              if(rows.length>maxScanRows){readFailure='scan_row_limit';return null;}
              readFailure=null;
              return {columns:candidates[0].columns,rows};
            }
          }
          if(candidates.length>1)readFailure='scan_table_ambiguous';
          if(candidates.length===1)readFailure=null;
          return candidates.length===1?candidates[0]:null;
        };
        const before=JSON.stringify(read());
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(!setter) return {error:'unmapped_search_results',step:'input_setter_unavailable'};
        // DataLens owns a controlled React input. A DOM value alone is not an
        // acknowledgement: React can restore its previous value on Enter/blur.
        // Read only this selected node's current props, never the component tree.
        const currentProps=()=>{
          if(role!=='datalens')return null;
          const keys=Object.getOwnPropertyNames(input).filter(key=>key.startsWith('__reactProps$'));
          if(keys.length!==1)return null;
          const props=Object.getOwnPropertyDescriptor(input,keys[0])?.value;
          return props && typeof props==='object'?props:null;
        };
        const accepted=()=>{
          const props=currentProps();
          return input.value===code && (!props || props.value==null || String(props.value)===code);
        };
        return await new Promise(resolve=>{
          let timer, deadline, trigger, observer, last='', stableAt=0, mismatchAt=null, done=false;
          let submitted=false, recovered=false, ready=false;
          const finish=value=>{if(done)return;done=true;clearInterval(timer);clearTimeout(deadline);clearTimeout(trigger);observer.disconnect();resolve(value);};
          const check=()=>{
            if(location.origin!==expectedOrigin) return finish({error:'search_origin_mismatch',step:'page_changed'});
            if(!ready)return;
            if(input.isConnected===false){
              const live=findControls();
              if(!submitted)return finish({error:'unmapped_search_results',step:'input_replaced_before_submit'});
              if(live.error){stableAt=0;last='';return;}
              input=live.input;
            }
            if(!accepted()){
              stableAt=0;last='';
              // Reloading controls can temporarily restore/replace their input.
              // After submission wait for the whole result deadline, without
              // another write or another query, then require live acknowledgement.
              if(submitted)return;
              if(!submitted && !recovered){
                recovered=true;
                const props=currentProps();
                if(typeof props?.onChange==='function'){
                  // Synthetic DOM events may not reach React's change plugin.
                  // Use the bound input handler once, then wait for its render.
                  setter.call(input,code);
                  try {
                    props.onChange({type:'change',target:input,currentTarget:input,
                      nativeEvent:new Event('input',{bubbles:true,composed:true}),
                      bubbles:true,defaultPrevented:false,isTrusted:false,
                      preventDefault(){this.defaultPrevented=true;},stopPropagation(){},persist(){},
                      isDefaultPrevented(){return this.defaultPrevented;},isPropagationStopped(){return false;}});
                  } catch {return finish({error:'unmapped_search_results',step:'input_handler_failed'});}
                  return;
                }
              }
              if(mismatchAt===null)mismatchAt=Date.now();
              if(Date.now()-mismatchAt>=3000)finish({error:'unmapped_search_results',
                step:typeof currentProps()?.onChange==='function'?'input_value_reset':'input_handler_unavailable'});
              return;
            }
            mismatchAt=null;
            if(!submitted){
              submitted=true;
              const props=currentProps();
              // Newer Gravity TextInput versions forward onBlur but omit the
              // deprecated onKeyPress prop. Pick one supported commit path.
              if(role==='datalens' && props && typeof props.onKeyPress!=='function' &&
                  typeof props.onBlur==='function'){
                input.blur?.();
                return;
              }
              const enter={key:'Enter',code:'Enter',keyCode:13,charCode:13,which:13,bubbles:true,composed:true};
              input.dispatchEvent(new KeyboardEvent('keydown',enter));
              input.dispatchEvent(new KeyboardEvent('keypress',enter));
              input.dispatchEvent(new KeyboardEvent('keyup',enter));
              // DataLens BaseControlInput submits on Enter AND on blur.
              // Keep focus: calling blur here can submit twice with stale props.
              return;
            }
            const liveRoots=historyWidgets();
            for(const root of liveRoots){
              if(historyBusy(root))busyHistoryRoots.add(root);
              if(busyHistoryRoots.has(root) && explicitEmpty(root))freshHistoryRoots.add(root);
            }
            // DataLens defaults to loading charts only when they enter the
            // viewport. A titled grid with no table/empty message is not an
            // empty history. Wake each pending named widget once in this
            // task-owned tab, then require its actual post-submit DOM update.
            const pendingRoot=liveRoots.find(root=>{
              const hasBody=explicitEmpty(root)||[...root.querySelectorAll('table')].some(table=>
                !table.closest?.('.dl-table__background-table') && visible(table) && table.querySelector('td'));
              return (!hasBody||!freshHistoryRoots.has(root))&&!scrolledHistoryRoots.has(root) &&
                typeof root.scrollIntoView==='function';
            });
            if(pendingRoot && historyScrollAttempts<12){
              scrolledHistoryRoots.add(pendingRoot);historyScrollAttempts++;
              pendingRoot.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
              stableAt=0;last='';return;
            }
            const table=read(), serialized=JSON.stringify(table);
            const empty=table && role==='datalens' && table.rows.length===0;
            const allFresh=liveRoots.length>0 && liveRoots.every(root=>freshHistoryRoots.has(root));
            if(!table || (empty?!allFresh:serialized===before) || (liveRoots.length>1&&!allFresh)){stableAt=0;return;}
            if(serialized!==last){last=serialized;stableAt=Date.now();return;}
            if(stableAt && Date.now()-stableAt>=750) finish(table);
          };
          observer=new MutationObserver(records=>{
            if(submitted && role==='datalens'){
              for(const root of historyWidgets()){
                // Track freshness independently. A refresh in one named widget
                // must never authorize a cached empty/result in its neighbour.
                if(records.some(record=>record.type!=='attributes' && (
                    root===record.target || root.contains(record.target) ||
                    [...record.addedNodes].some(node=>node===root || node.contains?.(root))
                )))freshHistoryRoots.add(root);
                if(historyBusy(root))busyHistoryRoots.add(root);
              }
            }
            check();
          });
          observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-busy']});
          deadline=setTimeout(()=>{
            if(!submitted)return finish({error:'unmapped_search_results',
              step:typeof currentProps()?.onChange==='function'?'input_value_reset':'input_handler_unavailable'});
            finish({error:'search_results_unconfirmed',
              step:input.isConnected===false || !accepted()?'input_changed_after_submit':role==='datalens' && readFailure?readFailure:'result_wait_timeout',
              ...(role==='datalens' && scanShape?{scan_shape:scanShape}:{})});
          },15000);
          input.focus?.();
          setter.call(input,code);
          const inputEvent=typeof InputEvent==='function'
            ?new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:code})
            :new Event('input',{bubbles:true,composed:true});
          input.dispatchEvent(inputEvent);
          input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
          ready=true;
          if(role==='asgard'){submitted=true;buttons[0].click();}
          else trigger=setTimeout(check,0);
          timer=setInterval(check,250);
        });
      },args:[role,code,origin,MAX_DATALENS_HISTORY_ROWS]});
    const table=response?.[0]?.result;
    if(table?.error) {
      const error=new Error(table.error);
      if(SEARCH_STEPS.has(table.step))error.step=table.step;
      const shape=safeScanShape(table.scan_shape);
      if(shape)error.scanShape=shape;
      const surface=table.surface, fields=['visible_inputs','editable_inputs','bound_inputs','matched_inputs'];
      if(surface && Object.keys(surface).length===fields.length &&
          fields.every(key=>Number.isInteger(surface[key]) && surface[key]>=0 && surface[key]<=10000)) {
        error.surface=Object.fromEntries(fields.map(key=>[key,surface[key]]));
      }
      throw error;
    }
    if(!table) throw new Error("unmapped_search_results");
    return table;
  }

  // Temporary recovery for numeric barcodes whose leading zeros were lost in
  // the inventory sheet. Retry only a confirmed empty history, never an error.
  // Keep the inventory key unchanged for native reconciliation/writeback.

  // The native batch protocol holds at most 100 scan rows per cargo. For a
  // longer fully-read history, its decision depends only on the latest OK
  // calendar date at SC 101366. Keep an actual source row with that date.
  function compactDatalensHistory(rows) {
    if(!Array.isArray(rows)||rows.length>MAX_DATALENS_HISTORY_ROWS)throw new Error('too_many_search_rows');
    if(rows.length<=100)return rows;
    if(rows.some(row=>!Array.isArray(row)||row.length!==4||row.some(cell=>typeof cell!=='string'||cell.length>256)))
      throw new Error('unmapped_search_results');
    const eligible=rows.filter(row=>row[1]==='101366'&&row[2]==='OK');
    if(!eligible.length)return [rows[0]]; // Nonempty history must stop zero retries.
    const valid=raw=>{
      if(!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(raw)||
          Number(raw.slice(0,4))===0||!Number.isFinite(Date.parse(raw)))return false;
      const day=raw.slice(0,10),dayTime=Date.parse(day+'T00:00:00Z');
      return Number.isFinite(dayTime)&&new Date(dayTime).toISOString().slice(0,10)===day&&
        Number(raw.slice(11,13))<24&&Number(raw.slice(14,16))<60&&Number(raw.slice(17,19))<60;
    };
    // A malformed eligible row might be the latest: never drop it to mark Found.
    if(eligible.some(row=>!valid(row[3])))throw new Error('unmapped_search_results');
    return [eligible.reduce((latest,row)=>row[3].slice(0,10)>latest[3].slice(0,10)?row:latest)];
  }

  async function datalensSearchWithPadding(chromeApi,tabId,original,origin) {
    const columns=['main_partner_code_original','sc_id','result','scanned_at'];
    let candidate=original;
    for(let added=0;;added++){
      const table=await workplaceSearch(chromeApi,tabId,'datalens',candidate,origin);
      if(!table || JSON.stringify(table.columns)!==JSON.stringify(columns) || !Array.isArray(table.rows))
        throw new Error('unmapped_search_results');
      if(table.rows.length>MAX_DATALENS_HISTORY_ROWS)throw new Error('too_many_search_rows');
      if(table.rows.some(row=>!Array.isArray(row) || row.length!==columns.length || row[0]!==candidate)){
        throw new Error('unverified_search_result_identity');
      }
      if(table.rows.length){
        // workplaceSearch already checked the exact padded identity in the DOM.
        // Associate that verified answer only with the original requested row.
        return {columns,rows:compactDatalensHistory(table.rows).map(row=>[original,...row.slice(1)])};
      }
      if(!/^\d+$/.test(original) || added>=10 || candidate.length>=128)return {columns,rows:[]};
      candidate='0'+candidate;
    }
  }

  async function visit(chromeApi, role, url, sendNative, searchKey = null, verifyAsgard = false) {
    let tabId, keepForReview=false;
    try {
      const workplace=searchKey!==null && (
        (role==='datalens' && new URL(url).origin==='https://datalens.yandex-team.ru') ||
        (role==='asgard' && new URL(url).origin==='https://asgard.market.yandex-team.ru'));
      // SPA controls may hydrate only in a selected tab. Activate before reading,
      // not just after a failure when the untouched dashboard defaults become visible.
      const tab = await chromeApi.tabs.create({url, active: workplace});
      if (!Number.isInteger(tab.id)) throw new Error("invalid_tab");
      tabId = tab.id;
      if(workplace && Number.isInteger(tab.windowId) && tab.windowId>=0 && chromeApi.windows?.update) {
        try { await chromeApi.windows.update(tab.windowId,{focused:true}); } catch { /* Tab activation remains effective if window focus is denied. */ }
      }
      if (searchKey !== null) {
        await waitLoaded(chromeApi, tabId);
        const current = await chromeApi.tabs.get(tabId);
        if (new URL(current.url || "").origin !== new URL(url).origin) {
          throw new Error("search_origin_mismatch");
        }
        if (workplace) {
          try {
            const table = role==='datalens'
              ?await datalensSearchWithPadding(chromeApi,tabId,searchKey,new URL(url).origin)
              :await workplaceSearch(chromeApi, tabId, role, searchKey, new URL(url).origin, verifyAsgard);
            return {table,characters:0,pages:1};
          } catch(error) {
            if(error?.message==='audit_cancelled'||error?.message==='audit_progress_unavailable')throw error;
            // Keep only a failed page on the explicitly authorized service origin.
            // Never close the user's existing tabs; these IDs were created here.
            try {
              const failed=await chromeApi.tabs.get(tabId);
              if(new URL(failed.url || '').origin===new URL(url).origin) {
                keepForReview=true;
                const prior=reviewTabs.get(role);
                if(prior && prior.id!==tabId) {
                  try {
                    const old=await chromeApi.tabs.get(prior.id);
                    if(old.url===prior.url)await chromeApi.tabs.remove(prior.id);
                  } catch { /* Previous review page was closed or navigated away. */ }
                }
                reviewTabs.set(role,{id:tabId,url:failed.url});
                try { await chromeApi.tabs.update(tabId,{active:true}); } catch { /* Keep visible on the tab strip if activation failed. */ }
                if(error && typeof error==='object')error.reviewAvailable=true;
              }
            } catch { /* Closed or redirected tabs still follow regular cleanup. */ }
            throw error;
          }
        }
        try {
          await exactGetSearch(chromeApi, tabId, role, searchKey, new URL(url).origin);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "dynamic_search_ui") {
            throw error;
          }
          await reactiveSearch(chromeApi, tabId, role, searchKey, new URL(url).origin);
        }
      }
      const visited = new Set();
      let expected = url;
      let combinedTable = null;
      let characters = 0;
      let pages = 0;
      for (let index = 0; index < MAX_PAGES; index++) {
        await waitLoaded(chromeApi, tabId);
        const current = await chromeApi.tabs.get(tabId);
        const finalUrl = new URL(current.url || "");
        if (finalUrl.origin !== new URL(url).origin || finalUrl.protocol !== "https:" ||
            finalUrl.username || finalUrl.password) throw new Error("navigation_outside_allowed_origin");
        const currentKey = finalUrl.href;
        if (visited.has(currentKey)) throw new Error("pagination_cycle");
        visited.add(currentKey);
        const results = await chromeApi.scripting.executeScript({
          target: {tabId},
          func: (resourceRole) => {
            // Only visible table text, not input values/cookies.
            const text = document.body ? document.body.innerText : "";
            const required = {
              inventory: ["cargo_place", "inventory_date"],
              datalens: ["main_partner_code_original", "sc_id", "result", "scanned_at"],
              asgard: ["cargo_place", "status"]
            }[resourceRole];
            let table = null;
            for (const element of document.querySelectorAll("table")) {
              const rows = [...element.querySelectorAll("tr")];
              const header = rows[0] ?
                [...rows[0].querySelectorAll("th")].map(c => resourceRole === "datalens" && c.innerText.trim() === "place_external_id" ?
                  "main_partner_code_original" : c.innerText.trim()) : [];
              if (!required.every(name => header.includes(name)) || header.length > 20) continue;
              if (rows.length > 101 || header.some(c => c.length > 256)) continue;
              const entries = [];
              let malformed = false;
              for (const row of rows.slice(1)) {
                const cells = [...row.querySelectorAll("td")];
                if (cells.length !== header.length) { malformed = true; break; }
                entries.push(cells.map((cell, i) => {
                  const value = cell.innerText.trim().slice(0, 256);
                  const name = header[i];
                  return resourceRole !== "datalens" ? value : name === "sc_id" ?
                    value.replace(/\s+/g, "") : name === "scanned_at" ? value.replace(/\//g, "-") : value;
                }));
              }
              if (malformed) continue;
              table = {columns: header, rows: entries};
              break;
            }
            // Accessible ARIA grids are common in SPA dashboards. Read only
            // fully rendered rows with exact headers; never invent missing rows.
            let incomplete = false;
            if (!table) {
              for (const grid of document.querySelectorAll('[role="grid"],[role="table"]')) {
                const rows = [...grid.querySelectorAll('[role="row"]')];
                const head = rows[0] ?
                  [...rows[0].querySelectorAll('[role="columnheader"]')]
                    .map(cell => resourceRole === "datalens" && cell.innerText.trim() === "place_external_id" ?
                      "main_partner_code_original" : cell.innerText.trim()) : [];
                if (!required.every(name => head.includes(name)) || head.length > 20) continue;
                const declared = grid.getAttribute("aria-rowcount");
                const count = declared === null ? null : Number(declared);
                // ARIA grids frequently virtualize unseen rows. Only an
                // explicit matching total count is acceptable evidence.
                if (declared === null || !Number.isInteger(count) || count !== rows.length) {
                  incomplete = true; break;
                }
                const bodyRows = rows.slice(1);
                if (bodyRows.length > 100) {
                  incomplete = true; break;
                }
                const entries = [];
                let malformed = false;
                for (const row of bodyRows) {
                  const cells = [...row.querySelectorAll('[role="gridcell"],[role="cell"]')];
                  if (cells.length !== head.length) { malformed = true; break; }
                  entries.push(cells.map((cell, i) => {
                  const value = cell.innerText.trim().slice(0, 256);
                  const name = head[i];
                  return resourceRole !== "datalens" ? value : name === "sc_id" ?
                    value.replace(/\s+/g, "") : name === "scanned_at" ? value.replace(/\//g, "-") : value;
                }));
                }
                if (malformed || head.some(c => c.length > 256)) {
                  incomplete = true; break;
                }
                table = {columns: head, rows: entries};
                break;
              }
            }
            const nextAnchor = document.querySelector("a[rel~='next'][href]");
            return {
              origin: location.origin,
              text: typeof text === "string" ? text.slice(0, 16000) : "",
              table,
              incomplete,
              next: nextAnchor ? nextAnchor.href : null
            };
          },
          args: [role]
        });
        const snapshot = results?.[0]?.result;
        if (!snapshot || snapshot.origin !== finalUrl.origin ||
            typeof snapshot.text !== "string" || !snapshot.text.trim()) {
          throw new Error("unexpected_document");
        }
        if (snapshot.incomplete) throw new Error("virtualized_or_incomplete_grid");
        const text = snapshot.text;
        const response = await sendNative({
          type: "inspect_active_page",
          page: {url: finalUrl.origin + finalUrl.pathname, text},
        });
        if (!response || !response.ok || response.type !== "page_inspected" ||
            response.persisted !== false || response.characters !== text.length) {
          throw new Error("native_host_rejected");
        }
        pages++;
        characters += text.length;
        if (snapshot.table) {
          const table = snapshot.table;
          if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
            throw new Error("invalid_table");
          }
          if (!combinedTable) {
            combinedTable = {columns: table.columns, rows: [...table.rows]};
          } else {
            if (combinedTable.columns.length !== table.columns.length ||
                combinedTable.columns.some((col, i) => col !== table.columns[i])) {
              throw new Error("changed_table_schema");
            }
            combinedTable.rows.push(...table.rows);
          }
          if (combinedTable.rows.length > 100) throw new Error("too_many_rows");
        }
        if (!snapshot.next) {
          return {role, status: "read", characters, pages, table: combinedTable};
        }
        // A pagination signal without the expected table must never produce a partial audit.
        if (!combinedTable || !snapshot.table) throw new Error("unmapped_paginated_table");
        const next = nextPage(finalUrl.href, snapshot.next);
        if (visited.has(next) || index === MAX_PAGES - 1) throw new Error("pagination_limit");
        expected = next;
        await chromeApi.tabs.update(tabId, {url: expected});
      }
      throw new Error("pagination_limit");
    } finally {
      if (tabId !== undefined && !keepForReview) {
        try { await chromeApi.tabs.remove(tabId); } catch { /* Tab already closed. */ }
      }
    }
  }

  async function runAudit(chromeApi, input, sendNative, onProgress, options = {}) {
    const targets = normalizeTargets(input);
    const results = [];
    const snapshots = {};
    let writeback=null;
    if (options.seedInventory !== undefined) {
      const seed = options.seedInventory;
      if (!seed || JSON.stringify(seed.columns) !== JSON.stringify(["cargo_place", "inventory_date"]) ||
          !Array.isArray(seed.rows) || seed.rows.length < 1 ||
          seed.rows.length > MAX_SEARCHES ||
          seed.rows.some(row => !Array.isArray(row) || row.length !== 2 ||
            typeof row[0] !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(row[0]) ||
            typeof row[1] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row[1]) ||
            !Number.isFinite(Date.parse(row[1])) ||
            new Date(row[1]).toISOString().slice(0,10) !== row[1]) ||
          new Set(seed.rows.map(row => row[0])).size !== seed.rows.length) {
        throw new Error("invalid_inventory_search_keys");
      }
      snapshots.inventory = {columns:["cargo_place","inventory_date"],
        rows:seed.rows.map(row => [...row])};
    }
    for (const role of ROLES) {
      await onProgress({phase: "reading", role, results: [...results]});
      if (role === "inventory" && snapshots.inventory) {
        results.push({role,status:"read",characters:0,pages:0});
        await onProgress({phase:"reading",role,results:[...results]});
        continue;
      }
      try {
        const inventoryKeys = snapshots.inventory?.rows?.map(row =>
          row[snapshots.inventory.columns.indexOf("cargo_place")]);
        const searchKeys = role !== "inventory" && options.exactGetSearch ?
          (role === "asgard" ? asgardSearchKeys(snapshots.inventory, snapshots.datalens) : inventoryKeys) : null;
        if (role !== "inventory" && options.exactGetSearch &&
            (!Array.isArray(searchKeys) || (role !== "asgard" && !searchKeys.length) ||
             searchKeys.length > MAX_SEARCHES || new Set(searchKeys).size !== searchKeys.length ||
             searchKeys.some(key => typeof key !== "string" ||
               !/^[A-Za-z0-9_.-]{1,128}$/.test(key)))) {
          throw new Error("invalid_inventory_search_keys");
        }
        if (role === "asgard" && Array.isArray(searchKeys) && !searchKeys.length) {
          snapshots.asgard = {columns:options.asgardWriteback?['cargo_place','status','box_id','destination','history_json','verification']:["cargo_place", "status"],rows:[]};
          if(options.asgardWriteback){
            const marked=await sendNative({type:'mark_inventa_asgard',job_id:options.writebackJobId,inventory:snapshots.inventory,datalens:snapshots.datalens,asgard:snapshots.asgard});
            if(!marked?.ok||marked.verified!==true||marked.type!=='inventa_asgard_marked'||marked.written!==0)throw new Error('inventa_writeback_failed');
          }
          results.push({role, status:"read", characters:0, pages:0});
          await onProgress({phase:"reading",role,results:[...results]});
          continue;
        }
        const keys = searchKeys || [null];
        let table = null, characters = 0, pages = 0;
        for (const key of keys) {
          const visitResult = await visit(chromeApi, role, targets[role], sendNative, key, options.asgardWriteback===true);
          if (options.exactGetSearch && !visitResult.table) {
            throw new Error("unmapped_search_results");
          }
          if (key !== null) {
            const codeField = role === "datalens" ?
              "main_partner_code_original" : "cargo_place";
            const column = visitResult.table.columns.indexOf(codeField);
            if (column < 0 || visitResult.table.rows.some(row =>
                !Array.isArray(row) || row[column] !== key)) {
              throw new Error("unverified_search_result_identity");
            }
          }
          if (visitResult.table?.rows?.length > 100) throw new Error("too_many_search_rows");
          characters += visitResult.characters;
          pages += visitResult.pages;
          if (visitResult.table) {
            if (!table) table = {columns: visitResult.table.columns,
              rows: [...visitResult.table.rows]};
            else {
              if (table.columns.length !== visitResult.table.columns.length ||
                  table.columns.some((col, i) => col !== visitResult.table.columns[i])) {
                throw new Error("changed_search_schema");
              }
              table.rows.push(...visitResult.table.rows);
              if (table.rows.length > (role === "datalens" ? MAX_BATCH_SCAN_ROWS : 100)) throw new Error("too_many_search_rows");
            }
          }
        }
        if (table) snapshots[role] = table;
        if(role==='datalens' && options.writebackJobId){
          const marked=await sendNative({type:'mark_inventa_found',job_id:options.writebackJobId,
            inventory:snapshots.inventory,datalens:snapshots.datalens});
          if(!marked?.ok || marked.type!=='inventa_found_marked' || marked.verified!==true ||
              !Number.isInteger(marked.written) || marked.written<0 || marked.written>snapshots.inventory.rows.length){
            throw new Error(SAFE_FAILURE_CODES.has(marked?.error)?marked.error:'inventa_writeback_failed');
          }
          writeback={written:marked.written,verified:true};
        }
        if(role==='asgard' && options.asgardWriteback){
          const marked=await sendNative({type:'mark_inventa_asgard',job_id:options.writebackJobId,
            inventory:snapshots.inventory,datalens:snapshots.datalens,asgard:snapshots.asgard});
          if(!marked?.ok||marked.type!=='inventa_asgard_marked'||marked.verified!==true||!Number.isInteger(marked.written)||marked.written<0||marked.written>searchKeys.length)
            throw new Error(SAFE_FAILURE_CODES.has(marked?.error)?marked.error:'inventa_writeback_failed');
          writeback={...writeback,asgard_written:marked.written};
        }
        if (role === "datalens" && options.exactGetSearch &&
            asgardSearchKeys(snapshots.inventory, snapshots.datalens) === null) {
          throw new Error("unmapped_search_results");
        }
        results.push({role, status: "read", characters, pages});
      } catch (error) {
        // Only constant known codes are allowed in persisted progress. Browser errors
        // often contain a URL, which may include cargo identifiers or session data.
        const fields=['visible_inputs','editable_inputs','bound_inputs','matched_inputs'];
        const surface=error?.surface;
        const safe=surface && Object.keys(surface).length===fields.length &&
          fields.every(key=>Number.isInteger(surface[key]) && surface[key]>=0 && surface[key]<=10000);
        results.push({role, status: "needs_attention", reason: reasonCode(error),
          ...(SEARCH_STEPS.has(error?.step)?{step:error.step}:{}),
          ...(error?.reviewAvailable===true?{review_available:true}:{}),
          ...(safeScanShape(error?.scanShape)?{scan_shape:safeScanShape(error.scanShape)}:{}),
          ...(safe?{surface:Object.fromEntries(fields.map(key=>[key,surface[key]]))}:{})});
      }
      await onProgress({phase: "reading", role, results: [...results]});
      // A failed DataLens batch is not evidence that its orders were not found.
      // Stop before Asgard instead of discarding confirmed scans and searching all keys.
      if (options.exactGetSearch && results.some(item => item.status === "needs_attention")) break;
    }
    const complete = results.every(item => item.status === "read");
    let reconciliation = null;
    if (complete && ROLES.every(role => snapshots[role])) {
      try {
        const response = await sendNative({type: "reconcile_site_tables", snapshots});
        if (response?.ok && response.type === "site_tables_reconciled" &&
            response.read_only === true && response.write_enabled === false &&
            response.persisted === false) {
          reconciliation = {total: response.total, summary: response.summary};
        }
      } catch { /* Schema mismatch or old host: report no reconciliation. */ }
    }
    const summary = {phase: !complete ? "needs_attention" :
      reconciliation ? "reconciled" : "read_only", results,
      ...(writeback?{writeback}:{}),
      ...(!reconciliation && complete ? {reason:"reconciliation_unavailable"} : {}),
      ...(reconciliation ? {reconciliation} : {})};
    await onProgress(summary);
    return summary;
  }
  async function run(chromeApi,input,sendNative,onProgress,options={}) {
    const signal=options.signal;
    if(!signal)return runAudit(chromeApi,input,sendNative,onProgress,options);
    const owned=new Set();let rejectStop,stopped=false;
    const stopError=()=>new Error(signal.reason==='audit_progress_unavailable'?'audit_progress_unavailable':'audit_cancelled');
    const check=()=>{if(stopped||signal.aborted)throw stopError();};
    const cancelled=new Promise((_,reject)=>{rejectStop=reject;});
    const closeOwned=async()=>{const ids=[...owned];owned.clear();await Promise.allSettled(ids.map(id=>chromeApi.tabs.remove(id)));};
    const stop=()=>{stopped=true;rejectStop(stopError());void closeOwned();};
    const race=promise=>Promise.race([promise,cancelled]);
    const active=async()=>{check();if(options.checkActive&&await options.checkActive()===false){stop();throw stopError();}check();};
    signal.addEventListener('abort',stop,{once:true});
    // Every action is scoped to this run's tabs. A cancelled generation cannot
    // act under a newer job ID, and closing a task tab interrupts its page script.
    const taskChrome={...chromeApi,auditSignal:signal,windows:chromeApi.windows,tabs:{...chromeApi.tabs,onUpdated:chromeApi.tabs.onUpdated,
      async create(args){
        await active();const tab=await chromeApi.tabs.create(args);
        if(Number.isInteger(tab.id))owned.add(tab.id);
        if(stopped||signal.aborted){await closeOwned();throw stopError();}return tab;
      },
      async update(id,args){await active();return race(chromeApi.tabs.update(id,args));},
      async get(id){check();return race(chromeApi.tabs.get(id));},
      async remove(id){if(!owned.delete(id)&&(stopped||signal.aborted))return;return chromeApi.tabs.remove(id);}
    },scripting:{...chromeApi.scripting,
      async executeScript(args){check();return race(chromeApi.scripting.executeScript(args));}
    }};
    try{
      check();
      return await race(runAudit(taskChrome,input,async message=>{await active();return race(sendNative(message));},
        async report=>{check();return race(onProgress(report));},options));
    }finally{
      signal.removeEventListener('abort',stop);
      if(stopped||signal.aborted)await closeOwned();
    }
  }
  return {ROLES, MAX_TEXT, MAX_PAGES, MAX_SEARCHES, normalizeTargets, sourceUrl, origins, nextPage, exactGetSearch, reactiveSearch, workplaceSearch, compactDatalensHistory, asgardSearchKeys, reasonCode, waitLoaded, run};
})();

