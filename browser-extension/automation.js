/* An allowlisted, read-only browser visit runner. No page actions or form access. */
var MaleniaAutomation = (() => {
  const ROLES = ["inventory", "datalens", "asgard"];
  const MAX_TEXT = 16000;
  const reviewTabs = new Map();
  const SEARCH_STEPS = new Set(["page_changed","input_setter_unavailable","input_value_reset","result_wait_timeout"]);
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
    return new Promise((resolve, reject) => {
      let finished = false;
      const settle = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chromeApi.tabs.onUpdated.removeListener(onUpdated);
        if (error) reject(error); else resolve();
      };
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === "complete") settle();
      };
      const timer = setTimeout(() => settle(new Error("page_timeout")), timeoutMs);
      chromeApi.tabs.onUpdated.addListener(onUpdated);
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
    "site_or_browser_error",
  ]);
  function reasonCode(error) {
    return error instanceof Error && SAFE_FAILURE_CODES.has(error.message) ?
      error.message : "site_or_browser_error";
  }

  const MAX_SEARCHES = 20;
  const MAX_BATCH_SCAN_ROWS = MAX_SEARCHES * 100;
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

  async function workplaceSearch(chromeApi, tabId, role, code, origin) {
    const hosts = {datalens:"https://datalens.yandex-team.ru",asgard:"https://asgard.market.yandex-team.ru"};
    if (origin !== hosts[role] || !/^[A-Za-z0-9_.-]{1,128}$/.test(code)) throw new Error("unsupported_dynamic_search");
    const response = await chromeApi.scripting.executeScript({target:{tabId},
      func: async (role, code, expectedOrigin) => {
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
        // tabs.status=complete does not mean an SPA has rendered its search form.
        const readyUntil=Date.now()+12000;
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
          if(!controls.error) break;
          if(!['search_field_missing','search_button_missing'].includes(controls.error)) return controls;
          if(Date.now()>=readyUntil) return controls;
          await new Promise(resolve=>setTimeout(resolve,200));
        } while(true);
        const {input,buttons}=controls;
        const read = () => {
          const candidates=[];
          for(const table of document.querySelectorAll('table')) {
            const trs=[...table.querySelectorAll('tr')];
            const heads=trs[0]?[...trs[0].querySelectorAll('th')].map(el=>clean(el.textContent)):[];
            const required=role==='datalens'?['scanned_at','sc_id','result','place_external_id']:
              ['Статус грузоместа','ID возврата','ID партнера','ID коробки'];
            if(!required.every(name=>heads.includes(name))) continue;
            if(trs.length<2 || trs.length>101 || new Set(heads).size!==heads.length) return null;
            const rows=trs.slice(1).map(tr=>[...tr.querySelectorAll('td')].map(el=>clean(el.textContent)));
            if(rows.some(row=>row.length!==heads.length || row.some(v=>v.length>256))) return null;
            if(role==='datalens') {
              const col=name=>heads.indexOf(name);
              if(rows.some(row=>row[col('place_external_id')]!==code)) return null;
              candidates.push({columns:['main_partner_code_original','sc_id','result','scanned_at'],
                rows:rows.map(row=>[code,row[col('sc_id')].replace(/\s/g,''),row[col('result')],row[col('scanned_at')].replace(/\//g,'-')])});
            } else {
              // A result is bound only to the exact barcode search completed below.
              if(rows.length!==1) return null;
              candidates.push({columns:['cargo_place','status','box_id'],
                rows:[[code,rows[0][heads.indexOf('Статус грузоместа')],rows[0][heads.indexOf('ID коробки')]]]});
            }
          }
          return candidates.length===1?candidates[0]:null;
        };
        const before=JSON.stringify(read());
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(!setter) return {error:'unmapped_search_results',step:'input_setter_unavailable'};
        return await new Promise(resolve=>{
          let timer, deadline, trigger, observer, last='', stableAt=0, mismatchAt=null, done=false;
          const finish=value=>{if(done)return;done=true;clearInterval(timer);clearTimeout(deadline);clearTimeout(trigger);observer.disconnect();resolve(value);};
          const check=()=>{
            if(location.origin!==expectedOrigin) return finish({error:'search_origin_mismatch',step:'page_changed'});
            if(input.value!==code){
              if(mismatchAt===null)mismatchAt=Date.now();
              if(Date.now()-mismatchAt>=1000)finish({error:'unmapped_search_results',step:'input_value_reset'});
              return;
            }
            mismatchAt=null;
            const table=read(), serialized=JSON.stringify(table);
            if(!table || serialized===before){stableAt=0;return;}
            if(serialized!==last){last=serialized;stableAt=Date.now();return;}
            if(stableAt && Date.now()-stableAt>=750) finish(table);
          };
          observer=new MutationObserver(check);
          observer.observe(document.body,{subtree:true,childList:true,characterData:true});
          deadline=setTimeout(()=>finish({error:'search_results_unconfirmed',step:'result_wait_timeout'}),15000);
          input.focus?.();
          setter.call(input,code);
          input.dispatchEvent(new Event('input',{bubbles:true}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
          if(role==='asgard') buttons[0].click();
          else {
            // The published DataLens BaseControlInput commits on keypress
            // charCode=13 or blur. Let React apply onUpdate before committing.
            trigger=setTimeout(()=>{
              if(done || location.origin!==expectedOrigin || input.value!==code) return;
              const enter={key:'Enter',code:'Enter',keyCode:13,charCode:13,which:13,bubbles:true};
              input.dispatchEvent(new KeyboardEvent('keydown',enter));
              input.dispatchEvent(new KeyboardEvent('keypress',enter));
              input.dispatchEvent(new KeyboardEvent('keyup',enter));
              input.blur?.();
            },0);
          }
          timer=setInterval(check,250);
        });
      },args:[role,code,origin]});
    const table=response?.[0]?.result;
    if(table?.error) {
      const error=new Error(table.error);
      if(SEARCH_STEPS.has(table.step))error.step=table.step;
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

  async function visit(chromeApi, role, url, sendNative, searchKey = null) {
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
            const table = await workplaceSearch(chromeApi, tabId, role, searchKey, new URL(url).origin);
            return {table,characters:0,pages:1};
          } catch(error) {
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

  async function run(chromeApi, input, sendNative, onProgress, options = {}) {
    const targets = normalizeTargets(input);
    const results = [];
    const snapshots = {};
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
          snapshots.asgard = {columns:["cargo_place", "status"],rows:[]};
          results.push({role, status:"read", characters:0, pages:0});
          await onProgress({phase:"reading",role,results:[...results]});
          continue;
        }
        const keys = searchKeys || [null];
        let table = null, characters = 0, pages = 0;
        for (const key of keys) {
          const visitResult = await visit(chromeApi, role, targets[role], sendNative, key);
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
      ...(!reconciliation && complete ? {reason:"reconciliation_unavailable"} : {}),
      ...(reconciliation ? {reconciliation} : {})};
    await onProgress(summary);
    return summary;
  }
  return {ROLES, MAX_TEXT, MAX_PAGES, MAX_SEARCHES, normalizeTargets, sourceUrl, origins, nextPage, exactGetSearch, reactiveSearch, workplaceSearch, asgardSearchKeys, reasonCode, waitLoaded, run};
})();
