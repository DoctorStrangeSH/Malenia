const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../browser-extension/automation.js'), 'utf8');
function runner() {
  const ctx = {URL, setTimeout, clearTimeout};
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx.MaleniaAutomation;
}
function fakeBrowser(finalUrl = null) {
  let current = null;
  const events = {listener:null,addListener(fn){this.listener=fn;},removeListener(){this.listener=null;}};
  const stats = {created:0,removed:0,executed:0,activated:0,opened:[]};
  return {stats, tabs:{
    onUpdated:events,
    async create({url,active}) {assert.equal(typeof active,'boolean');stats.opened.push({url,active}); stats.created++; current={id:7,url:finalUrl || url,status:'complete'};return current;},
    async get(id){assert.equal(id,7);return current;},
    async remove(id){assert.equal(id,7);stats.removed++;},
    async update(id,patch){assert.equal(id,7);if(patch.active)stats.activated++;return {...current,...patch};}
  }, scripting:{
    async executeScript({target}) {
      assert.equal(target.tabId,7);stats.executed++;
      return [{result:{origin:new URL(current.url).origin,text:'Тестовая строка'}}];
    }
  }};
}
test('only exact three user-configured HTTPS pages, no URL secrets', () => {
  const api=runner();
  const good=api.normalizeTargets({
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  });
  assert.equal(Object.keys(good).length,3);
  assert.equal(api.origins(good).length,3);
  for(const unsafe of ['http://example.com/','https://example.com/?token=secret',
     'https://example.com/#token','https://name:password@example.com/',
     'file:///C:/private','https://localhost/orders','https://example.com:9443/orders']) {
    assert.throws(()=>api.normalizeTargets({...good,inventory:unsafe}));
  }
  assert.throws(()=>api.normalizeTargets({...good,extra:'https://example.com/'}));
});
test('automated traversal opens and closes separate background tabs without writing page data', async () => {
  const api=runner(), chrome=fakeBrowser();
  const reports=[], sent=[];
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async msg=>{
    sent.push(msg);
    return {ok:true,type:'page_inspected',persisted:false,characters:msg.page.text.length};
  },async snapshot=>reports.push(snapshot));
  assert.equal(result.phase,'read_only');
  assert.equal(chrome.stats.created,3);
  assert.equal(chrome.stats.removed,3);
  assert.equal(sent.length,3);
  assert.ok(chrome.stats.opened.every(tab=>tab.active===false));
  assert.ok(sent.every(msg=>msg.type==='inspect_active_page'));
  assert.ok(reports.every(report=>!JSON.stringify(report).includes('Тестовая строка')));
});
test('navigation to another origin is rejected before page text is read and tab is closed', async () => {
  const api=runner(), chrome=fakeBrowser('https://login.example/auth');
  let sent=0;
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async ()=>{sent++;return {};},async ()=>{});
  assert.equal(result.phase,'needs_attention');
  assert.equal(chrome.stats.executed,0);
  assert.equal(chrome.stats.removed,3);
  assert.equal(sent,0);
});
test('the site data is not persisted and a native rejection fails closed',async()=>{
  const api=runner(),chrome=fakeBrowser();
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async()=>({ok:true,type:'page_inspected',persisted:true,characters:16}),async()=>{});
  assert.equal(result.phase,'needs_attention');
  assert.equal(result.results.length,3);
  assert.equal(chrome.stats.removed,3);
});

test('exact table evidence triggers one ephemeral reconciliation, without exposing identifiers in progress', async () => {
  const api=runner(), chrome=fakeBrowser();
  chrome.scripting.executeScript=async ({args})=>({
    inventory:{columns:['cargo_place','inventory_date'],rows:[['TEST-001','2026-09-12']]},
    datalens:{columns:['main_partner_code_original','sc_id','result','scanned_at'],
      rows:[['TEST-001','101366','OK','2026-09-15T08:00:00']]},
    asgard:{columns:['cargo_place','status'],rows:[]}
  }[args[0]] ? [{result:{origin:'https://' + ({
    inventory:'inventory.example',datalens:'analytics.example',asgard:'asgard.example'
  }[args[0]]),text:'Тестовая строка',table:{
    inventory:{columns:['cargo_place','inventory_date'],rows:[['TEST-001','2026-09-12']]},
    datalens:{columns:['main_partner_code_original','sc_id','result','scanned_at'],
      rows:[['TEST-001','101366','OK','2026-09-15T08:00:00']]},
    asgard:{columns:['cargo_place','status'],rows:[]}
  }[args[0]]}}] : []);
  const sent=[],progress=[];
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async message=>{
    sent.push(message);
    if(message.type==='reconcile_site_tables')return {
      ok:true,type:'site_tables_reconciled',persisted:false,read_only:true,
      write_enabled:false,total:1,summary:{found:1,in_progress:0,manual_review:0}
    };
    return {ok:true,type:'page_inspected',persisted:false,characters:message.page.text.length};
  },async snapshot=>progress.push(snapshot));
  assert.equal(result.phase,'reconciled');
  assert.equal(sent.filter(x=>x.type==='reconcile_site_tables').length,1);
  assert.ok(progress.every(snapshot=>!JSON.stringify(snapshot).includes('TEST-001')));
  assert.equal(result.reconciliation.summary.found,1);
});

test('next-page URL is restricted to same HTTPS origin', () => {
  const api=runner();
  assert.equal(api.nextPage('https://inventory.example/orders',
      '?page=2'), 'https://inventory.example/orders?page=2');
  for (const unsafe of ['https://outside.example/orders', 'http://inventory.example/',
      'https://user:pass@inventory.example/', 'https://inventory.example/orders#secret',
      'https://inventory.example:9443/orders']) {
    assert.throws(() => api.nextPage('https://inventory.example/orders', unsafe));
  }
});

test('automatically follows rel-next pages and merges exact schema before read-only reconciliation', async () => {
  const api=runner(), chrome=fakeBrowser();
  const originalGet=chrome.tabs.get;
  chrome.tabs.update=async (id, {url})=>{
    const current=await originalGet(id);
    current.url=url;
    current.status='complete';
    return current;
  };
  chrome.scripting.executeScript=async ({args})=>{
    const current=await chrome.tabs.get(7);
    const page=new URL(current.url);
    const role=args[0];
    const table=role==='inventory' ? {
      columns:['cargo_place','inventory_date'],
      rows:[[page.search ? 'TEST-002' : 'TEST-001','2026-09-12']]
    } : role==='datalens' ? {
      columns:['main_partner_code_original','sc_id','result','scanned_at'],
      rows:[['TEST-001','101366','OK','2026-09-15T10:00:00'],
            ['TEST-002','101366','OK','2026-09-15T10:00:00']]
    } : {columns:['cargo_place','status'],rows:[]};
    return [{result:{origin:page.origin,text:'Видимая страница',table,
      next:role==='inventory'&&!page.search?'https://inventory.example/orders?page=2':null}}];
  };
  const calls=[],progress=[];
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async message=>{
    calls.push(message);
    if(message.type==='reconcile_site_tables') {
      assert.equal(message.snapshots.inventory.rows.length,2);
      return {ok:true,type:'site_tables_reconciled',read_only:true,
        write_enabled:false,persisted:false,total:2,
        summary:{found:2,in_progress:0,manual_review:0}};
    }
    return {ok:true,type:'page_inspected',persisted:false,characters:message.page.text.length};
  },async snapshot=>progress.push(snapshot));
  assert.equal(result.phase,'reconciled');
  assert.equal(result.results[0].pages,2);
  assert.equal(calls.filter(x=>x.type==='inspect_active_page').length,4);
  assert.equal(chrome.stats.removed,3);
  assert.ok(progress.every(x=>!JSON.stringify(x).includes('TEST-001')));
});

test('pagination cycle never produces a partial reconciliation', async () => {
  const api=runner(), chrome=fakeBrowser();
  chrome.scripting.executeScript=async ({args})=>[{
    result:{origin:'https://' + ({
      inventory:'inventory.example',datalens:'analytics.example',asgard:'asgard.example'
    }[args[0]]),text:'Содержимое',
    table:{columns:args[0]==='inventory'?['cargo_place','inventory_date']:
      args[0]==='datalens'?['main_partner_code_original','sc_id','result','scanned_at']:
      ['cargo_place','status'],rows:[]},
    next:args[0]==='inventory'?'https://inventory.example/orders':null}
  }];
  let reconciles=0;
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async msg=>{
    if(msg.type==='reconcile_site_tables')reconciles++;
    return {ok:true,type:'page_inspected',persisted:false,characters:msg.page.text.length};
  },async ()=>{});
  assert.equal(result.phase,'needs_attention');
  assert.equal(reconciles,0);
  assert.equal(chrome.stats.removed,3);
});

test('virtualized grid with missing rows fails closed without reconciliation', async () => {
  const api=runner(), chrome=fakeBrowser();
  chrome.scripting.executeScript=async ({args})=>[{
    result:{origin:'https://' + ({
      inventory:'inventory.example',datalens:'analytics.example',asgard:'asgard.example'
    }[args[0]]),text:'Visible rows',
      incomplete:args[0]==='inventory',
      table:{columns:args[0]==='inventory'?['cargo_place','inventory_date']:
        args[0]==='datalens'?['main_partner_code_original','sc_id','result','scanned_at']:
        ['cargo_place','status'],rows:[]},next:null}
  }];
  let reconciles=0;
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/reports',
    asgard:'https://asgard.example/history'
  },async msg=>{
    if(msg.type==='reconcile_site_tables')reconciles++;
    return {ok:true,type:'page_inspected',persisted:false,
      characters:msg.page?.text?.length??0};
  },async()=>{});
  assert.equal(result.phase,'needs_attention');
  assert.equal(result.results[0].status,'needs_attention');
  assert.equal(reconciles,0);
  assert.equal(chrome.stats.removed,3);
});

test('ARIA grid extractor rejects known rowcount larger than rendered rows', () => {
  assert.match(source, /querySelectorAll\('\[role="grid"\],\[role="table"\]'\)/);
  assert.match(source, /count !== rows\.length/);
  assert.match(source, /virtualized_or_incomplete_grid/);
  assert.match(source, /\[role="columnheader"\]/);
});

test('opted-in GET search skips Asgard for confirmed post-inventory scans', async () => {
  const api=runner(), chrome=fakeBrowser();
  const originalGet=chrome.tabs.get, urls=[];
  chrome.tabs.update=async (id,{url})=>{
    const tab=await originalGet(id);
    tab.url=url;tab.status='complete';urls.push(url);
    return tab;
  };
  chrome.scripting.executeScript=async ({args})=>{
    const tab=await originalGet(7), url=new URL(tab.url);
    if(args?.length===2) {
      const role=args[0],code=args[1];
      const field=role==='datalens'?'main_partner_code_original':'cargo_place';
      const search=new URL(url.origin + '/search');
      search.searchParams.set(field,code);
      return [{result:{origin:url.origin,url:search.href}}];
    }
    const role=args[0];
    const code=url.searchParams.get('main_partner_code_original') ||
      url.searchParams.get('cargo_place');
    const table=role==='inventory'?{
      columns:['cargo_place','inventory_date'],
      rows:[['ABC-1','2026-09-12'],['ABC-2','2026-09-12']]
    }:role==='datalens'?{
      columns:['main_partner_code_original','sc_id','result','scanned_at'],
      rows:[[code,'101366','OK','2026-09-14T08:30:00']]
    }:{columns:['cargo_place','status'],rows:[[code,'Принят на ФФ']]};
    return [{result:{origin:url.origin,text:'Visible table',table,next:null}}];
  };
  const calls=[];
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',
    asgard:'https://asgard.example/orders'
  },async msg=>{
    calls.push(msg);
    if(msg.type==='reconcile_site_tables') {
      assert.equal(msg.snapshots.datalens.rows.length,2);
      assert.equal(msg.snapshots.asgard.rows.length,0);
      return {ok:true,type:'site_tables_reconciled',read_only:true,write_enabled:false,
        persisted:false,total:2,summary:{found:2,in_progress:0,manual_review:0}};
    }
    return {ok:true,type:'page_inspected',persisted:false,characters:msg.page.text.length};
  },async()=>{}, {exactGetSearch:true});
  assert.equal(result.phase,'reconciled');
  assert.equal(urls.length,2);
  assert.equal(chrome.stats.created,3);
  assert.equal(chrome.stats.removed,3);
  assert.equal(calls.filter(m=>m.type==='reconcile_site_tables').length,1);
  assert.ok(urls.every(url=>new URL(url).searchParams.size===1));
});

test('opted-in search rejects rows belonging to a different cargo place',async()=>{
  const api=runner(), chrome=fakeBrowser();
  const originalGet=chrome.tabs.get;
  chrome.tabs.update=async (id,{url})=>{
    const tab=await originalGet(id);tab.url=url;return tab;
  };
  chrome.scripting.executeScript=async ({args})=>{
    const tab=await originalGet(7),url=new URL(tab.url);
    if(args.length===2)return [{result:{
      origin:url.origin,
      url:url.origin+'/search?main_partner_code_original=ABC-1'
    }}];
    return [{result:{origin:url.origin,text:'Visible table',next:null,
      table:args[0]==='inventory'?
        {columns:['cargo_place','inventory_date'],rows:[['ABC-1','2026-09-12']]}:
        {columns:['main_partner_code_original','sc_id','result','scanned_at'],
         rows:[['SOMEONE-ELSE','101366','OK','2026-09-14T08:30:00']]}}}];
  };
  let reconciles=0;
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',
    asgard:'https://asgard.example/orders'
  },async msg=>{
    if(msg.type==='reconcile_site_tables')reconciles++;
    return {ok:true,type:'page_inspected',persisted:false,characters:msg.page.text.length};
  },async()=>{}, {exactGetSearch:true});
  assert.equal(result.phase,'needs_attention');
  assert.equal(result.results[1].status,'needs_attention');
  assert.equal(reconciles,0);
});

test('search limits and GET-only form guard are present',()=>{
  assert.match(source,/MAX_SEARCHES = 20/);
  assert.match(source,/form\.method\.toLowerCase\(\) === "get"/);
  assert.match(source,/querySelectorAll\('input\[type="password"\],input\[type="hidden"\]'\)/);
  assert.match(source,/unverified_search_result_identity/);
});

test('browser GET-search extractor only accepts an unambiguous read-only form', async () => {
  const api=runner();
  const current='https://analytics.example/orders';
  const normalForm = (method='get', extra=false) => ({
    method,
    getAttribute:()=>'/search',
    querySelectorAll(selector) {
      if (selector.includes('password') || selector.includes('hidden')) return extra?[{}]:[];
      if (selector.includes('main_partner_code_original')) return [{type:'search'}];
      if (selector==='input[name]') return [{type:'search'}];
      return [];
    },
    querySelector:()=>({type:'search'})
  });
  let form=normalForm();
  const chrome={
    scripting:{async executeScript({func,args}) {
      const document={querySelectorAll:selector=>selector==="form"?[form]:[]};
      const location={origin:'https://analytics.example',href:current};
      const context={document,location,URL};
      return [{result:vm.runInNewContext('('+func.toString()+')(...args)',{...context,args})}];
    }},
    tabs:{async update(_,{url}){return {url};}}
  };
  let result=await api.exactGetSearch(chrome,7,'datalens','ABC-1','https://analytics.example');
  assert.equal(result,undefined);
  for(const [method,extra] of [['post',false],['get',true]]) {
    form=normalForm(method,extra);
    await assert.rejects(
      ()=>api.exactGetSearch(chrome,7,'datalens','ABC-1','https://analytics.example'),
      /unsupported_search_form/);
  }
  await assert.rejects(
    ()=>api.exactGetSearch(chrome,7,'datalens','SECRET?','https://analytics.example'),
    /invalid_search/);
});

test('progress reports a stable safe reason code, never raw URLs or browser errors', async () => {
  const api=runner();
  const chrome=fakeBrowser('https://login.example/auth?token=SECRET');
  const reports=[];
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',
    asgard:'https://asgard.example/orders'
  },async()=>{throw Error('should not send');},async data=>reports.push(data));
  assert.equal(result.phase,'needs_attention');
  assert.equal(result.results[0].reason,'navigation_outside_allowed_origin');
  assert.ok(reports.every(data=>!JSON.stringify(data).includes('SECRET')));
  assert.ok(reports.every(data=>!JSON.stringify(data).includes('login.example')));
});

test('unexpected browser errors are reduced to generic safe reason', async () => {
  const api=runner();
  const chrome=fakeBrowser();
  chrome.scripting.executeScript=async()=>{throw new Error('Failed URL https://secret.example/?token=SENSITIVE');};
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',
    asgard:'https://asgard.example/orders'
  },async()=>{throw Error('should not send');},async()=>{});
  assert.equal(result.results[0].reason,'site_or_browser_error');
  assert.ok(!JSON.stringify(result).includes('SENSITIVE'));
});

test('dynamic search widget is recognized without reading its value or clicking it', async () => {
  const api=runner();
  const chrome={
    scripting:{async executeScript({func,args}) {
      const document={querySelectorAll:selector=>
        selector==='form'?[]:
        selector==='input[type="search"],input[role="searchbox"]'?
          [{type:'search',closest:()=>null,getAttribute:key=>
            key==='aria-label'?'main_partner_code_original':null}]:[]};
      const location={origin:'https://analytics.example',href:'https://analytics.example/orders'};
      return [{result:vm.runInNewContext('('+func.toString()+')(...args)',
        {document,location,URL,args})}];
    }},
    tabs:{async update(){throw Error('must not navigate');}}
  };
  await assert.rejects(()=>api.exactGetSearch(
    chrome,7,'datalens','ABC-1','https://analytics.example'),/dynamic_search_ui/);
});

test('reactive search enters exact cargo in one labelled standalone searchbox', async () => {
  const api=runner();
  let value='', dispatched=0, clicks=0, observed=false, disconnected=false;
  let notify;
  class MockInput {}
  Object.defineProperty(MockInput.prototype,'value',{set(v){value=v;},get(){return value;}});
  const input=new MockInput();
  input.type='search';input.disabled=false;input.readOnly=false;
  input.closest=()=>null;
  input.getAttribute=name=>name==='aria-label'?'main_partner_code_original':null;
  input.getClientRects=()=>[{}];
  input.dispatchEvent=()=>{dispatched++;queueMicrotask(()=>notify?.());};
  input.click=()=>{clicks++;};
  class Observer {
    constructor(fn){notify=fn;}
    observe(){observed=true;}
    disconnect(){disconnected=true;}
  }
  const chrome={
    scripting:{async executeScript({func,args}) {
      const table={get innerText(){return value ? 'result for '+value : 'initial result';},
        querySelectorAll:()=>[
        {innerText:'main_partner_code_original'},{innerText:'sc_id'},
        {innerText:'result'},{innerText:'scanned_at'}]};
      const context={document:{body:{},querySelectorAll:selector=>
        selector.includes('table,')?[table]:[input]},
        location:{origin:'https://analytics.example'},HTMLInputElement:MockInput,
        MutationObserver:Observer,Event:class{constructor(type){this.type=type;}},
        setTimeout,clearTimeout};
      return [{result:await vm.runInNewContext('('+func.toString()+')(...args)',
        {...context,args})}];
    }}
  };
  await api.reactiveSearch(chrome,7,'datalens','ABC-1','https://analytics.example');
  assert.equal(value,'ABC-1');
  assert.equal(dispatched,1);
  assert.equal(clicks,0);
  assert.equal(observed,true);
  assert.equal(disconnected,true);
});

test('dynamic search never writes into ambiguous or form-owned controls', async () => {
  const api=runner();
  let writes=0;
  class MockInput{}
  Object.defineProperty(MockInput.prototype,'value',{set(){writes++;}});
  const input=new MockInput();
  input.type='search';input.disabled=false;input.readOnly=false;
  input.closest=()=>({tagName:'FORM'});
  input.getAttribute=()=> 'cargo_place';
  input.getClientRects=()=>[{}];
  const chrome={
    scripting:{async executeScript({func,args}) {
      const context={document:{body:{},querySelectorAll:()=>[input]},
        location:{origin:'https://asgard.example'},HTMLInputElement:MockInput,
        MutationObserver:class{},Event:class{},setTimeout,clearTimeout};
      return [{result:await vm.runInNewContext('('+func.toString()+')(...args)',
        {...context,args})}];
    }}
  };
  await assert.rejects(()=>api.reactiveSearch(
    chrome,7,'asgard','ABC-1','https://asgard.example'),/unsupported_dynamic_search/);
  assert.equal(writes,0);
});

test('reactive search refuses result updates on a foreign origin', async () => {
  const api=runner();
  const chrome={scripting:{async executeScript(){
    return [{result:{origin:'https://other.example',status:'updated'}}];
  }}};
  await assert.rejects(()=>api.reactiveSearch(
    chrome,7,'asgard','ABC-1','https://asgard.example'),/unsupported_dynamic_search/);
});

test('full audit falls back from GET forms to reactive search per cargo',async()=>{
  const api=runner(),chrome=fakeBrowser();
  let reactive=0, native=0;
  chrome.scripting.executeScript=async ({func,args})=>{
    const role=args[0],origin='https://'+({
      inventory:'inventory.example',datalens:'analytics.example',asgard:'asgard.example'
    }[role]);
    if(args.length===2 && func.toString().includes('MutationObserver')) {
      reactive++;
      return [{result:{origin,status:'updated'}}];
    }
    if(args.length===2) return [{result:{origin,kind:'dynamic_search_ui'}}];
    const table=role==='inventory'?
      {columns:['cargo_place','inventory_date'],rows:[['ABC-1','2026-09-12']]}:
      role==='datalens'?
      {columns:['main_partner_code_original','sc_id','result','scanned_at'],
       rows:[['ABC-1','101366','OK','2026-09-14T08:30:00']]}:
      {columns:['cargo_place','status'],rows:[['ABC-1','Принят на ФФ']]};
    return [{result:{origin,text:'Rendered results',table,next:null}}];
  };
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',
    asgard:'https://asgard.example/orders'
  },async message=>{
    if(message.type==='reconcile_site_tables') {
      native++;
      assert.equal(message.snapshots.inventory.rows[0][0],'ABC-1');
      return {ok:true,type:'site_tables_reconciled',read_only:true,
        write_enabled:false,persisted:false,total:1,
        summary:{found:1,in_progress:0,manual_review:0}};
    }
    return {ok:true,type:'page_inspected',persisted:false,characters:message.page.text.length};
  },async()=>{},{exactGetSearch:true});
  assert.equal(result.phase,'reconciled');
  assert.equal(reactive,1);
  assert.equal(native,1);
  assert.equal(chrome.stats.removed,2);
});

test('Asgard search includes only cargo without a later successful scan at SC 101366', () => {
  const api=runner();
  const inventory={columns:['cargo_place','inventory_date'],rows:[
    ['LATER','2026-08-22'],['EARLIER','2026-08-22'],
    ['WRONG-SC','2026-08-22'],['SAME-DAY','2026-08-22']]};
  const datalens={columns:['main_partner_code_original','sc_id','result','scanned_at'],rows:[
    ['LATER','101366','OK','2026-08-23T09:00:00'],
    ['EARLIER','101366','OK','2026-08-21T09:00:00'],
    ['WRONG-SC','777','OK','2026-08-24T09:00:00'],
    ['SAME-DAY','101366','OK','2026-08-22T22:00:00']]};
  assert.deepEqual(Array.from(api.asgardSearchKeys(inventory,datalens)),
    ['EARLIER','WRONG-SC','SAME-DAY']);
  datalens.rows.push(['LATER','101366','OK','not-a-date']);
  assert.ok(Array.from(api.asgardSearchKeys(inventory,datalens)).includes('LATER'));
  assert.equal(api.asgardSearchKeys(inventory,{columns:['code'],rows:[]}),null);
});

test('Google Sheets seeded first order visits DataLens without revisiting inventory or Asgard when found',async()=>{
  const api=runner(),chrome=fakeBrowser();
  chrome.tabs.update=async (id,{url})=>({id,url,status:'complete'});
  chrome.scripting.executeScript=async ({args})=>{
    const role=args[0];
    if(args.length===2)return [{result:{origin:'https://analytics.example',
      url:'https://analytics.example/search?main_partner_code_original=BOX-1'}}];
    return [{result:{origin:'https://analytics.example',text:'Scanned table',next:null,
      table:{columns:['main_partner_code_original','sc_id','result','scanned_at'],
        rows:[['BOX-1','101366','OK','2026-08-23T08:00:00']]}}}];
  };
  const sent=[];
  const result=await api.run(chrome,{
    inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',asgard:'https://asgard.example/orders'
  },async msg=>{
    sent.push(msg);
    if(msg.type==='reconcile_site_tables')return {ok:true,type:'site_tables_reconciled',
      read_only:true,write_enabled:false,persisted:false,total:1,
      summary:{found:1,in_progress:0,manual_review:0}};
    return {ok:true,type:'page_inspected',persisted:false,characters:msg.page.text.length};
  },async()=>{},{exactGetSearch:true,seedInventory:{
    columns:['cargo_place','inventory_date'],rows:[['BOX-1','2026-08-22']]}});
  assert.equal(result.phase,'reconciled');
  assert.equal(chrome.stats.created,1);
  assert.equal(sent.find(x=>x.type==='reconcile_site_tables').snapshots.inventory.rows[0][1],'2026-08-22');
});

test('seeded browser batches reject duplicate and oversized cargo sets before visiting sites',async()=>{
  const api=runner(),chrome=fakeBrowser();
  const targets={inventory:'https://inventory.example/orders',
    datalens:'https://analytics.example/orders',asgard:'https://asgard.example/orders'};
  const invalid=[
    [['BOX-1','2026-08-22'],['BOX-1','2026-08-23']],
    Array.from({length:21},(_,i)=>[`BOX-${i}`,'2026-08-22']),
    [['BOX-1','invalid-date']]
  ];
  for(const rows of invalid){
    await assert.rejects(api.run(chrome,targets,async()=>({}),async()=>{},
      {seedInventory:{columns:['cargo_place','inventory_date'],rows}}),
      /invalid_inventory_search_keys/);
  }
  assert.equal(chrome.stats.created,0);
});

test('unrelated result-table mutations do not count as successful reactive search',async()=>{
  const api=runner();
  let notify;
  class MockInput {}
  Object.defineProperty(MockInput.prototype,'value',{set(){}});
  const input=new MockInput();
  input.type='search'; input.disabled=false; input.readOnly=false;
  input.closest=()=>null;
  input.getAttribute=key=>key==='name'?'cargo_place':null;
  input.getClientRects=()=>[{}];
  input.dispatchEvent=()=>queueMicrotask(()=>notify?.());
  const table={innerText:'same stale rows',querySelectorAll:()=>[
    {innerText:'cargo_place'},{innerText:'status'}]};
  class Observer{
    constructor(fn){notify=fn;}
    observe(){}
    disconnect(){}
  }
  const chrome={scripting:{async executeScript({func,args}){
    const document={body:{},querySelectorAll:selector=>
      selector.includes('table,')?[table]:[input]};
    return [{result:await vm.runInNewContext('('+func.toString()+')(...args)',
      {document,location:{origin:'https://asgard.example'},
        HTMLInputElement:MockInput,MutationObserver:Observer,
        Event:class{},setTimeout,clearTimeout,args})}];
  }}};
  await assert.rejects(()=>api.reactiveSearch(chrome,7,'asgard','ABC-1',
    'https://asgard.example'),/dynamic_search_unchanged_table/);
});

function workplaceFixture(role, {ambiguous=false, unchanged=false, wrongCode=false, missing=false, filters=false, noButton=false, delayed=false, caption=false, aria=false, hidden=false, multiField=false, reverse=false, orders=false, plainOrders=false, duplicateOrders=false, ordersAlreadyOpen=false, delayedOrders=false, unrelatedOrders=false, foreignOrders=false, ordersHeading=false, deepOrders=false, nativeControl=false, keypressOnly=false, duplicateNative=false, pinnedControl=false, pinnedCollision=false, pinnedDisabled=false, resetValue=false, initialValue='', controlled=false, refuseChange=false, domOnlyChange=false, normalReactEvents=false,handlerThrows=false,noReactHandler=false,detachedBeforeSubmit=false,loadingControl=false,neverReadyControl=false,foreignReadyOwner=false,stickyHeader=false,measurementCopy=false,hiddenCopy=false,duplicateScanTable=false}={}) {
  const host=role==='asgard'?'https://asgard.market.yandex-team.ru':'https://datalens.yandex-team.ru';
  const label=role==='asgard'?'Штрихкод коробки':'ID заказа / ЛОТа / ТОТа / Тележки';
  let updated=false, clicks=0, navigationClicks=0, committedEvents=0, handlerCalls=0, worldUsed, stateValue=initialValue, deadline, now=0, firstEditAt=null;
  class Input {
    constructor(){this.type='text';this._value=initialValue;this.disabled=false;this.readOnly=false;
      this.parentElement={textContent:label,querySelectorAll:selector=>selector==='input'?[this]:[],parentElement:null};}
    get value(){return this._value;} set value(v){this._value=v;}
    getAttribute(){return null;} getClientRects(){return [{}];}
    dispatchEvent(event){
      if(event.type==='input'){
        if(firstEditAt===null)firstEditAt=now;
        if(controlled){
          if(normalReactEvents)this.__reactProps$fixture.onChange({target:this});
          else queueMicrotask(()=>{this._value=stateValue;});
        }else queueMicrotask(()=>{stateValue=this.value;});
      }
      if(keypressOnly){
        if(event.type==='keypress' && event.charCode===13 && stateValue===this.value){committedEvents++;updated=!unchanged;}
      }else if(event.type==='keyup')updated=!unchanged;
      if(resetValue && event.type==='keyup')this._value='';
    }
  }
  const input=new Input();
  if(controlled){
    input.__reactProps$fixture={value:initialValue,onChange(event){
      handlerCalls++;
      if(handlerThrows)throw new Error('PRIVATE-PAGE-ERROR');
      const value=event.target.value;
      queueMicrotask(()=>{
        if(refuseChange)return;
        input._value=value;
        if(domOnlyChange){updated=true;return;}
        stateValue=value;
        input.__reactProps$fixture={...input.__reactProps$fixture,value};
      });
    }};
  }
  if(loadingControl){
    const owner={};
    Object.defineProperty(owner,'memoizedProps',{get:()=>({type:'input',
      param:!neverReadyControl && now>=2200?'barcode':'',value:input.value,onChange(){}})});
    input.__reactFiber$fixture={return:owner};
    if(foreignReadyOwner)owner.return={stateNode:{getAttribute:()=> 'dashkit-grid-item'},return:{
      memoizedProps:{type:'input',param:'unrelated',value:input.value,onChange(){}}
    }};
  }
  if(noReactHandler && controlled)input.__reactProps$fixture.onChange=undefined;
  if(detachedBeforeSubmit)input.isConnected=false;
  if(caption || hidden || multiField) {
    const captionNode={textContent:label+' : *',getClientRects:()=>[{}]};
    const hiddenInput={type:'hidden',getClientRects:()=>[]};
    input.parentElement={textContent:label+' : * Очистить',parentElement:null,
      querySelectorAll:selector=>selector==='input'?(multiField?[input,new Input()]:hidden?[input,hiddenInput]:[input]):[captionNode]};
  }
  if(aria){input.parentElement=null;input.getAttribute=name=>name==='aria-labelledby'?'barcode-caption':null;}
  let nativeInputs;
  if(nativeControl){
    const other=new Input();
    nativeInputs=duplicateNative?[input,other]:[input];
    const title={textContent:'ID заказа / ЛОТа / ТОТа / Тележки…',getAttribute:()=>null,
      querySelectorAll:()=>[{getAttribute:()=>label}]};
    const widget={querySelectorAll:selector=>selector==='input'?nativeInputs:[title]};
    for(const el of nativeInputs){el.parentElement=null;el.closest=()=>widget;}
  }
  if(pinnedControl){input.parentElement=null;input.closest=()=>null;input.disabled=pinnedDisabled;}
  const headers=role==='asgard'?['Статус грузоместа','ID возврата','ID партнера','ID коробки']:
    ['scanned_at','sc_id','result','place_external_id'];
  const table={querySelectorAll:()=>[
    {querySelectorAll:()=>headers.map(textContent=>({textContent}))},
    {querySelectorAll:()=> (role==='asgard'?
      [updated?'Выдан':'В пути','1','2',updated?'NEW-BOX':'OLD-BOX']:
      ['2026/10/05 20:35:36','101 366','OK',wrongCode?'OTHER':updated?'TEST-1':'OLD'])
      .map(textContent=>({textContent}))}
  ]};
  const tables=[
    ...(stickyHeader?[{querySelectorAll:()=>[table.querySelectorAll()[0]]}]:[]),
    table,
    ...(measurementCopy?[{...table,closest:selector=>selector==='.dl-table__background-table'?{}:null}]:[]),
    ...(hiddenCopy?[{...table,getClientRects:()=>[]}]:[]),
    ...(duplicateScanTable?[{...table}]:[])
  ];
  const button={textContent:'Найти',disabled:false,getClientRects:()=>[{}],click(){clicks++;updated=!unchanged;}};
  const ordersTab={textContent:'Заказы',closest:()=>foreignOrders?{href:'https://other.example/orders'}:null,children:[],parentElement:{textContent:unrelatedOrders?'Ссылки на Заказы':'СЦ Статистика Заказы Массовые сканы Многоместка',parentElement:null},getClientRects:()=>[{}],getAttribute:()=>null,click(){navigationClicks++;}};
  const heading={...ordersTab,parentElement:{textContent:'Заказы. Описание дашборда',parentElement:null}};
  const reverseTab={textContent:'Обратный поток',getClientRects:()=>[{}],getAttribute:()=>null,click(){navigationClicks++;}};
  const document={body:{},getElementById:id=>id==='barcode-caption'?{textContent:label}:null,querySelectorAll:selector=>selector==='input'?((missing || (reverse && !navigationClicks) || (orders && !ordersAlreadyOpen && !navigationClicks && !(deepOrders && now>=800)) || (delayed && now<800))?[]:nativeControl?nativeInputs:ambiguous?[input,new Input()]:filters?[input,Object.assign(new Input(),{_value:'OTHER',parentElement:null})]:[input]):
    selector==='[data-qa="dashkit-grid-item"][data-dashkit-grid-id="13"] [data-qa="chartkit-control-input"] input.g-text-input__control' && pinnedControl?(pinnedCollision?[input,new Input()]:[input]):
    selector==='button'?(noButton?[]:[button]):selector==='table'?tables:
    selector==='a,button,[role="tab"]' && reverse?[reverseTab]:
    selector==='a,button,[role="tab"],[tabindex]' && orders && !plainOrders && !(delayedOrders && now<800)?(duplicateOrders?[ordersTab,{...ordersTab}]:ordersHeading?[ordersTab,heading]:[ordersTab]):
    selector==='span,div' && orders && plainOrders?[ordersTab]:[]};
  const chrome={scripting:{async executeScript({func,args,world}){
    worldUsed=world;
    return [{result:await vm.runInNewContext('('+func.toString()+')(...args)',{
      document,URL,location:{origin:host,pathname:deepOrders?'/94srinatuhls4-sc':'/dashboard',href:host+(deepOrders?'/94srinatuhls4-sc?tab=qmM':'/dashboard')},HTMLInputElement:Input,args,
      Event:class {constructor(type){this.type=type;}},KeyboardEvent:class {constructor(type,options){this.type=type;Object.assign(this,options);}},
      MutationObserver:class {observe(){}disconnect(){}},
      Date:{now:()=>now},setTimeout:(fn,ms)=>{if(ms<=200){now+=ms;queueMicrotask(fn);}else deadline=fn;return 1;},clearTimeout(){},clearInterval(){},
      setInterval:fn=>{queueMicrotask(async()=>{for(let i=0;i<6;i++){now+=250;fn();await Promise.resolve();}deadline();});return 2;}
    })}];
  }}};
  return {chrome,host,clicks:()=>clicks,navigationClicks:()=>navigationClicks,committedEvents:()=>committedEvents,currentValue:()=>input.value,handlerCalls:()=>handlerCalls,world:()=>worldUsed,firstEditAt:()=>firstEditAt};
}

test('workplace adapters bind search results using observed labels and normalize source schemas',async()=>{
  const api=runner();
  for(const role of ['datalens','asgard']) {
    const f=workplaceFixture(role);
    const table=await api.workplaceSearch(f.chrome,7,role,'TEST-1',f.host);
    assert.equal(table.rows[0][0],'TEST-1');
    if(role==='datalens') {
      assert.equal(table.rows[0][1],'101366');
      assert.equal(table.rows[0][3],'2026-10-05 20:35:36');
      assert.equal(f.clicks(),0);
    } else {
      assert.equal(table.rows[0][1],'Выдан');
      assert.equal(table.rows[0][2],'NEW-BOX');
      assert.equal(f.clicks(),1);
    }
  }
});

test('workplace adapters reject ambiguous fields, stale results, foreign hosts and foreign scan identity',async()=>{
  const api=runner();
  for(const role of ['datalens','asgard']) {
    for(const config of [{ambiguous:true},{unchanged:true}]) {
      const f=workplaceFixture(role,config);
      await assert.rejects(()=>api.workplaceSearch(f.chrome,7,role,'TEST-1',f.host),/search_field_ambiguous|search_results_unconfirmed/);
    }
  }
  const f=workplaceFixture('datalens',{wrongCode:true});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),/search_results_unconfirmed/);
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'asgard','TEST-1','https://evil.example'),/unsupported_dynamic_search/);
});

test('queued seeded orders route through workplace searches and skip Asgard for found cargo',async()=>{
  const api=runner(),chrome=fakeBrowser(),searched=[];
  chrome.scripting.executeScript=async({args})=>{
    const [role,code]=args;searched.push([role,code]);
    return [{result:role==='datalens'?{
      columns:['main_partner_code_original','sc_id','result','scanned_at'],
      rows:[[code,'101366','OK',code==='FOUND'?'2026-10-05 20:35:36':'2026-08-01 10:00:00']]
    }:{columns:['cargo_place','status','box_id'],rows:[[code,'Выдан','BOX-1']]}}];
  };
  let reconciled;
  const result=await api.run(chrome,{
    inventory:'https://docs.google.com/spreadsheets/d/example/edit',
    datalens:'https://datalens.yandex-team.ru/orders',asgard:'https://asgard.market.yandex-team.ru/search'
  },async message=>{assert.equal(message.type,'reconcile_site_tables');reconciled=message.snapshots;
    return {ok:true,type:'site_tables_reconciled',persisted:false,read_only:true,write_enabled:false,total:2,summary:{found:1,in_progress:1,manual_review:0}};
  },async()=>{}, {exactGetSearch:true,seedInventory:{columns:['cargo_place','inventory_date'],
    rows:[['FOUND','2026-09-26'],['CHECK','2026-09-26']]}});
  assert.deepEqual(searched,[['datalens','FOUND'],['datalens','CHECK'],['asgard','CHECK']]);
  assert.equal(result.phase,'reconciled');
  assert.equal(reconciled.asgard.rows[0][0],'CHECK');
  assert.equal(chrome.stats.created,chrome.stats.removed);
});

 test('Asgard reports actionable setup failures before submitting a search',async()=>{
  const api=runner();
  for(const [config,reason] of [[{missing:true},'search_field_missing'],[{filters:true},'search_filters_not_empty'],[{noButton:true},'search_button_missing']]) {
    const f=workplaceFixture('asgard',config);
    await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'asgard','TEST-1',f.host),new RegExp(reason));
    assert.equal(f.clicks(),0);
  }
});

 test('workplace search waits for SPA form hydration and accepts visible sibling or ARIA captions',async()=>{
  const api=runner();
  for(const config of [{delayed:true},{caption:true},{aria:true},{hidden:true},{caption:true,delayed:true},{reverse:true,caption:true}]) {
    const f=workplaceFixture('asgard',config);
    const table=await api.workplaceSearch(f.chrome,7,'asgard','TEST-1',f.host);
    assert.equal(table.rows[0][0],'TEST-1');assert.equal(f.clicks(),1);
    assert.equal(f.navigationClicks(),config.reverse?1:0);
  }
});
 test('caption near multiple editable fields never licenses guessing the barcode field',async()=>{
  const api=runner(),f=workplaceFixture('asgard',{multiField:true});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'asgard','TEST-1',f.host),/search_field_missing/);
  assert.equal(f.clicks(),0);
});

function scanBatch(codes, count=24) {
  return {columns:['main_partner_code_original','sc_id','result','scanned_at'],
    rows:codes.flatMap(code=>Array.from({length:count},(_,i)=>[code,'101366','OK',
      i<2?'2026-10-05 16:51:32':'2026-09-29 14:59:51']))};
}
const workTargets={inventory:'https://docs.google.com/spreadsheets/d/example/edit',
  datalens:'https://datalens.yandex-team.ru/orders',asgard:'https://asgard.market.yandex-team.ru/returnBox/search'};
function inventorySeed(codes){return {columns:['cargo_place','inventory_date'],rows:codes.map(code=>[code,'2026-10-03'])};}

test('03.10 inventory and 05.10 successful scan find VOZ_MK_TEST_001 without opening Asgard',async()=>{
  const api=runner(),chrome=fakeBrowser(),calls=[],code='VOZ_MK_TEST_001';
  chrome.scripting.executeScript=async({args:[role,key]})=>{
    calls.push([role,key]);assert.equal(role,'datalens');assert.equal(key,code);
    return [{result:scanBatch([code])}];
  };
  const result=await api.run(chrome,workTargets,async message=>{
    assert.equal(message.type,'reconcile_site_tables');assert.equal(message.snapshots.asgard.rows.length,0);
    return {ok:true,type:'site_tables_reconciled',persisted:false,read_only:true,write_enabled:false,total:1,summary:{found:1,in_progress:0,manual_review:0}};
  },async()=>{}, {exactGetSearch:true,seedInventory:inventorySeed([code])});
  assert.equal(result.phase,'reconciled');assert.deepEqual(calls,[['datalens',code]]);
});

test('20 scan histories may exceed 100 rows together without sending found orders to Asgard',async()=>{
  const api=runner(),chrome=fakeBrowser(),codes=['VOZ_MK_TEST_001',...Array.from({length:19},(_,i)=>'TEST-'+i)],calls=[];
  chrome.scripting.executeScript=async({args:[role,key]})=>{
    calls.push([role,key]);assert.equal(role,'datalens');return [{result:scanBatch([key])}];
  };
  const result=await api.run(chrome,workTargets,async message=>{
    assert.equal(message.snapshots.datalens.rows.length,480);assert.equal(message.snapshots.asgard.rows.length,0);
    return {ok:true,type:'site_tables_reconciled',persisted:false,read_only:true,write_enabled:false,total:20,summary:{found:20,in_progress:0,manual_review:0}};
  },async()=>{}, {exactGetSearch:true,seedInventory:inventorySeed(codes)});
  assert.equal(result.phase,'reconciled');assert.equal(calls.length,20);
});

test('a later DataLens failure stops the batch without searching found orders in Asgard',async()=>{
  const api=runner(),chrome=fakeBrowser(),codes=['VOZ_MK_TEST_001','BROKEN'],calls=[];
  chrome.scripting.executeScript=async({args:[role,key]})=>{
    calls.push([role,key]);assert.equal(role,'datalens');
    if(key==='BROKEN')throw new Error('site failed');
    return [{result:scanBatch([key])}];
  };
  const result=await api.run(chrome,workTargets,async()=>{throw Error('must not reconcile partial results');},async()=>{},
    {exactGetSearch:true,seedInventory:inventorySeed(codes)});
  assert.equal(result.phase,'needs_attention');assert.deepEqual(calls,codes.map(c=>['datalens',c]));
  assert.equal(result.results.at(-1).role,'datalens');
});

test('a single oversized scan history is rejected before Asgard',async()=>{
  const api=runner(),chrome=fakeBrowser();
  chrome.scripting.executeScript=async({args:[role,key]})=>{
    assert.equal(role,'datalens');return [{result:scanBatch([key],101)}];
  };
  const result=await api.run(chrome,workTargets,async()=>{},async()=>{},
    {exactGetSearch:true,seedInventory:inventorySeed(['TEST'])});
  assert.equal(result.phase,'needs_attention');assert.equal(result.results.at(-1).reason,'too_many_search_rows');
});

test('Asgard in a mixed 03.10 batch receives only the other order, never the found VOZ order',async()=>{
  const api=runner(),chrome=fakeBrowser(),calls=[],codes=['VOZ_MK_TEST_001','UNRESOLVED'];
  chrome.scripting.executeScript=async({args:[role,key]})=>{
    calls.push([role,key]);
    if(role==='asgard')return [{result:{columns:['cargo_place','status'],rows:[[key,'Выдан']]}}];
    const table=scanBatch([key]);
    if(key==='UNRESOLVED')table.rows.forEach(row=>row[3]='2026-09-29 14:59:51');
    return [{result:table}];
  };
  const result=await api.run(chrome,workTargets,async()=>({ok:true,type:'site_tables_reconciled',persisted:false,
    read_only:true,write_enabled:false,total:2,summary:{found:1,in_progress:1,manual_review:0}}),async()=>{},
    {exactGetSearch:true,seedInventory:inventorySeed(codes)});
  assert.equal(result.phase,'reconciled');
  assert.deepEqual(calls,[['datalens',codes[0]],['datalens',codes[1]],['asgard',codes[1]]]);
});

test('unmapped DataLens columns never fall back to searching all orders in Asgard',async()=>{
  const api=runner(),chrome=fakeBrowser(),calls=[];
  chrome.scripting.executeScript=async({args:[role,key]})=>{
    calls.push([role,key]);return [{result:{columns:['main_partner_code_original'],rows:[[key]]}}];
  };
  const result=await api.run(chrome,workTargets,async()=>{},async()=>{},
    {exactGetSearch:true,seedInventory:inventorySeed(['VOZ_MK_TEST_001'])});
  assert.equal(result.phase,'needs_attention');assert.equal(result.results.at(-1).role,'datalens');
  assert.equal(result.results.at(-1).reason,'unmapped_search_results');assert.equal(calls.length,1);
});


test('DataLens selects Orders on the dashboard home before searching, including lazy/plain tab captions',async()=>{
  const api=runner();
  for(const config of [{orders:true},{orders:true,delayedOrders:true},{orders:true,plainOrders:true}]) {
    const f=workplaceFixture('datalens',config);
    const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
    assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.navigationClicks(),1);
  }
});

test('an Orders deep link with a ready form is searched without resetting its tab',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{orders:true,ordersAlreadyOpen:true});
  const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
  assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.navigationClicks(),0);
});

test('ambiguous Orders tabs and unrelated Orders text never trigger a guessed click',async()=>{
  const api=runner();
  for(const config of [{orders:true,duplicateOrders:true},{orders:true,plainOrders:true,unrelatedOrders:true}]) {
    const f=workplaceFixture('datalens',config);
    await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),/search_navigation_ambiguous|search_field_missing/);
    assert.equal(f.navigationClicks(),0);
  }
});

 test('Orders navigation rejects a link outside the authorized DataLens origin',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{orders:true,foreignOrders:true});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),/search_origin_mismatch/);
  assert.equal(f.navigationClicks(),0);
});


test('DataLens Orders deep link preserves tab, drops state, and repairs saved dashboard-only bindings',()=>{
  const api=runner(),url='https://datalens.yandex-team.ru/94srinatuhls4-sc';
  for(const raw of [url,url+'?tab=qmM&state=example-state']) {
    const normalized=api.normalizeTargets({...workTargets,datalens:raw});
    assert.equal(normalized.datalens,url+'?tab=qmM');
  }
  assert.equal(api.sourceUrl(url+'?tab=qmM&state=private&token=secret'),url+'?tab=qmM');
  assert.equal(api.sourceUrl('https://datalens.yandex-team.ru/other?tab=Safe_2&state=x'),
    'https://datalens.yandex-team.ru/other?tab=Safe_2');
  for(const raw of [url+'?tab=qmM&token=secret',url+'?tab=qmM&tab=bad',url+'?tab=%2Fother']) {
    assert.throws(()=>api.normalizeTargets({...workTargets,datalens:raw}));
  }
});

test('Orders heading is not mistaken for a second navigation tab',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{orders:true,ordersHeading:true});
  const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
  assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.navigationClicks(),1);
});

test('an explicit qmM route waits for its form rather than clicking duplicate captions during hydration',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{orders:true,duplicateOrders:true,deepOrders:true});
  const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
  assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.navigationClicks(),0);
});

test('queued search opens the supplied qmM Orders route even from an old dashboard-only source',async()=>{
  const api=runner(),base='https://datalens.yandex-team.ru/94srinatuhls4-sc';
  for(const raw of [base,base+'?tab=qmM&state=example-state']) {
    const chrome=fakeBrowser(),opened=[],create=chrome.tabs.create;
    chrome.tabs.create=async args=>{opened.push(args.url);return create(args);};
    chrome.scripting.executeScript=async({args:[role,key]})=>{
      assert.equal(role,'datalens');return [{result:scanBatch([key])}];
    };
    const result=await api.run(chrome,{...workTargets,datalens:raw},async()=>({ok:true,type:'site_tables_reconciled',
      persisted:false,read_only:true,write_enabled:false,total:1,summary:{found:1,in_progress:0,manual_review:0}}),async()=>{},
      {exactGetSearch:true,seedInventory:inventorySeed(['TEST-ORDER'])});
    assert.equal(result.phase,'reconciled');assert.deepEqual(opened,[base+'?tab=qmM']);
  }
});


test('published DataLens control wrapper identifies a truncated caption and commits after React state update',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{nativeControl:true,keypressOnly:true});
  const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
  assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.committedEvents(),1);
});

test('DataLens commit uses keypress charCode 13, not only keydown/keyup',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{keypressOnly:true});
  const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
  assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.committedEvents(),1);
});

test('a native DataLens wrapper containing two editable inputs is never used to guess the field',async()=>{
  const api=runner(),f=workplaceFixture('datalens',{nativeControl:true,duplicateNative:true,keypressOnly:true});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),/search_field_missing/);
  assert.equal(f.committedEvents(),0);
});


test('owner-supplied Orders widget 13 binds its exact native input even without a usable label',async()=>{
 const api=runner(),f=workplaceFixture('datalens',{pinnedControl:true,deepOrders:true,keypressOnly:true});
 const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
 assert.equal(result.rows[0][0],'TEST-1');assert.equal(f.committedEvents(),1);
});

test('widget 13 binding is scoped to the supplied dashboard route and refuses duplicates or disabled fields',async()=>{
 const api=runner();
 for(const config of [{pinnedControl:true},{pinnedControl:true,deepOrders:true,pinnedCollision:true},
   {pinnedControl:true,deepOrders:true,pinnedDisabled:true}]) {
   const f=workplaceFixture('datalens',{...config,keypressOnly:true});
   await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),/search_field_missing|search_field_ambiguous/);
   assert.equal(f.committedEvents(),0);
 }
});


test('failed automatic-page diagnostics carry only bounded input counts, not page text or identifiers',async()=>{
 const api=runner(),chrome=fakeBrowser(),reports=[];
 chrome.scripting.executeScript=async()=>[{result:{error:'search_field_missing',surface:
   {visible_inputs:10,editable_inputs:10,bound_inputs:0,matched_inputs:0}}}];
 const result=await api.run(chrome,workTargets,async()=>{},async report=>reports.push(report),
   {exactGetSearch:true,seedInventory:inventorySeed(['TEST-PRIVATE'])});
 assert.equal(result.phase,'needs_attention');assert.equal(result.results.at(-1).surface.visible_inputs,10);
 assert.ok(!JSON.stringify(reports).includes('TEST-PRIVATE'));
 chrome.scripting.executeScript=async()=>[{result:{error:'search_field_missing',surface:{private_text:'SECRET'}}}];
 const rejected=await api.run(chrome,workTargets,async()=>{},async()=>{},
   {exactGetSearch:true,seedInventory:inventorySeed(['TEST-PRIVATE'])});
 assert.equal(rejected.results.at(-1).surface,undefined);assert.ok(!JSON.stringify(rejected).includes('SECRET'));
});


test('a failed workplace search leaves its owned page open for review and reports a bounded failure step',async()=>{
 const api=runner(),chrome=fakeBrowser(),reports=[];
 chrome.scripting.executeScript=async()=>[{result:{error:'unmapped_search_results',step:'input_value_reset'}}];
 const result=await api.run(chrome,workTargets,async()=>{},async s=>reports.push(s),
   {exactGetSearch:true,seedInventory:inventorySeed(['TEST-PRIVATE'])});
 assert.equal(result.phase,'needs_attention');assert.equal(chrome.stats.created,1);
 assert.equal(chrome.stats.removed,0);assert.equal(chrome.stats.activated,1);
 assert.equal(result.results.at(-1).step,'input_value_reset');assert.equal(result.results.at(-1).review_available,true);
 assert.ok(!JSON.stringify(reports).includes('TEST-PRIVATE'));
});

test('a page that resets the entered cargo is distinguished from a table parse failure',async()=>{
 const api=runner(),f=workplaceFixture('datalens',{resetValue:true});
 await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),
   error=>error.message==='search_results_unconfirmed' && error.step==='input_changed_after_submit');
});

test('repeated failures replace only an unchanged extension-owned review page',async()=>{
 const api=runner(),chrome=fakeBrowser(),tabs=new Map([[99,{id:99,url:workTargets.datalens,status:'complete'}]]),removed=[];
 let nextId=10;
 chrome.tabs.create=async({url})=>{const tab={id:nextId++,url,status:'complete'};tabs.set(tab.id,tab);return tab;};
 chrome.tabs.get=async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);};
 chrome.tabs.remove=async id=>{removed.push(id);tabs.delete(id);};
 chrome.tabs.update=async(id,patch)=>{Object.assign(tabs.get(id),patch);return tabs.get(id);};
 chrome.scripting.executeScript=async()=>[{result:{error:'unmapped_search_results',step:'input_value_reset'}}];
 const run=()=>api.run(chrome,workTargets,async()=>{},async()=>{},
   {exactGetSearch:true,seedInventory:inventorySeed(['TEST'])});
 await run();await run();assert.deepEqual(removed,[10]);assert.ok(tabs.has(99));
 tabs.get(11).url='https://datalens.yandex-team.ru/user-selected-other-dashboard';
 await run();assert.deepEqual(removed,[10]);assert.ok(tabs.has(11));assert.ok(tabs.has(12));
});

test('failed search redirected away from the authorized origin is cleaned up rather than retained',async()=>{
 const api=runner(),chrome=fakeBrowser(),get=chrome.tabs.get;let redirected=false;
 chrome.tabs.get=async id=>{const tab=await get(id);return redirected?{...tab,url:'https://login.example/'}:tab;};
 chrome.scripting.executeScript=async()=>{redirected=true;return [{result:{error:'search_origin_mismatch',step:'page_changed'}}];};
 const result=await api.run(chrome,workTargets,async()=>{},async()=>{},
   {exactGetSearch:true,seedInventory:inventorySeed(['TEST'])});
 assert.equal(result.phase,'needs_attention');assert.equal(chrome.stats.removed,1);
 assert.equal(result.results.at(-1).review_available,undefined);
});


test('workplace SPA is selected before its search controls are inspected',async()=>{
 const api=runner(),chrome=fakeBrowser();let active=false,focused=false;
 const create=chrome.tabs.create;
 chrome.tabs.create=async args=>{active=args.active;return {...await create(args),windowId:5};};
 chrome.windows={async update(id,patch){assert.equal(id,5);focused=patch.focused;}};
 chrome.scripting.executeScript=async({args:[role,key]})=>{
   if(!active || !focused)return [{result:{error:'search_field_missing'}}];
   assert.equal(role,'datalens');assert.equal(key,'FROM-INVENTORY');
   return [{result:scanBatch([key])}];
 };
 const result=await api.run(chrome,workTargets,async()=>({ok:true,type:'site_tables_reconciled',persisted:false,
   read_only:true,write_enabled:false,total:1,summary:{found:1,in_progress:0,manual_review:0}}),async()=>{},
   {exactGetSearch:true,seedInventory:inventorySeed(['FROM-INVENTORY'])});
 assert.equal(result.phase,'reconciled');assert.equal(chrome.stats.opened[0].active,true);
});

test('dashboard default cargo is replaced by the requested inventory cargo before Enter',async()=>{
 const api=runner(),f=workplaceFixture('datalens',{initialValue:'DEFAULT-EXAMPLE',keypressOnly:true});
 const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
 assert.equal(f.currentValue(),'TEST-1');assert.equal(f.committedEvents(),1);assert.equal(result.rows[0][0],'TEST-1');
});


test('DataLens waits for controlled React state after a rejected synthetic input event',async()=>{
 const api=runner(),f=workplaceFixture('datalens',{controlled:true,initialValue:'DEFAULT-EXAMPLE',keypressOnly:true});
 const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
 assert.equal(f.world(),'MAIN');
 assert.equal(f.handlerCalls(),1);
 assert.equal(f.currentValue(),'TEST-1');
 assert.equal(f.committedEvents(),1);
 assert.equal(result.rows[0][0],'TEST-1');
});

test('DataLens does not call the React handler twice when ordinary input events are accepted',async()=>{
 const api=runner(),f=workplaceFixture('datalens',{controlled:true,normalReactEvents:true,keypressOnly:true});
 await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
 assert.equal(f.handlerCalls(),1);
 assert.equal(f.committedEvents(),1);
});

test('DataLens never submits or accepts a DOM-only value when controlled state refuses the cargo',async()=>{
 const api=runner();
 for(const options of [{refuseChange:true},{domOnlyChange:true}]){
  const f=workplaceFixture('datalens',{controlled:true,keypressOnly:true,...options});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),
    error=>error.message==='unmapped_search_results' && error.step==='input_value_reset');
  assert.equal(f.handlerCalls(),1);
  assert.equal(f.committedEvents(),0);
 }
});

test('Asgard search remains isolated from page JavaScript',async()=>{
 const api=runner(),f=workplaceFixture('asgard');
 await api.workplaceSearch(f.chrome,7,'asgard','TEST-1',f.host);
 assert.equal(f.world(),'ISOLATED');
});


test('DataLens distinguishes an absent handler, a throwing handler and pre-submit replacement',async()=>{
 const api=runner();
 for(const [options,step] of [
  [{controlled:true,noReactHandler:true},'input_handler_unavailable'],
  [{controlled:true,handlerThrows:true},'input_handler_failed'],
  [{detachedBeforeSubmit:true},'input_replaced_before_submit']
 ]){
  const f=workplaceFixture('datalens',{keypressOnly:true,...options});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),
   error=>error.step===step && !error.message.includes('PRIVATE-PAGE-ERROR'));
  assert.equal(f.committedEvents(),0);
 }
});


test('DataLens waits for the loaded parameter before editing a locally editable loading stub',async()=>{
 const api=runner(),f=workplaceFixture('datalens',{loadingControl:true,keypressOnly:true});
 const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
 assert.equal(result.rows[0][0],'TEST-1');
 assert.ok(f.firstEditAt()>=2600);
 assert.equal(f.committedEvents(),1);
});

test('a never-ready DataLens stub is neither edited nor submitted; other widgets cannot make it ready',async()=>{
 const api=runner();
 for(const foreignReadyOwner of [false,true]){
  const f=workplaceFixture('datalens',{loadingControl:true,neverReadyControl:true,foreignReadyOwner,
   initialValue:'DEFAULT-EXAMPLE',keypressOnly:true});
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),
   error=>error.step==='input_loading_timeout');
  assert.equal(f.firstEditAt(),null);
  assert.equal(f.currentValue(),'DEFAULT-EXAMPLE');
  assert.equal(f.committedEvents(),0);
 }
});


test('DataLens ignores a sticky header, offscreen measurement copy, and hidden table copies',async()=>{
 const api=runner();
 for(const options of [{stickyHeader:true},{measurementCopy:true},{hiddenCopy:true},
  {stickyHeader:true,measurementCopy:true,hiddenCopy:true}]){
  const f=workplaceFixture('datalens',options);
  const result=await api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0][0],'TEST-1');
  assert.equal(result.rows[0][1],'101366');
 }
});

test('two real scan tables remain ambiguous and a wrong cargo remains rejected',async()=>{
 const api=runner();
 for(const [options,step] of [[{duplicateScanTable:true},'scan_table_ambiguous'],
  [{wrongCode:true},'scan_table_identity_mismatch']]){
  const f=workplaceFixture('datalens',options);
  await assert.rejects(()=>api.workplaceSearch(f.chrome,7,'datalens','TEST-1',f.host),
   error=>error.step===step);
 }
});
