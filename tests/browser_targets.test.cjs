const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const automation = fs.readFileSync(path.resolve(__dirname,'../browser-extension/automation.js'),'utf8');
const setup = fs.readFileSync(path.resolve(__dirname,'../browser-extension/targets.js'),'utf8');
const flush = () => new Promise(resolve=>setImmediate(resolve));
function screen(granted=true, audit=null, openTabs=null) {
  const names = ['targetInventory','targetDatalens','targetAsgard','saveTargets','targetsStatus','orderAuditStatus',
    'discoverTargets','selectinventory','selectdatalens','selectasgard'];
  const nodes=Object.fromEntries(names.map(name=>[name,{value:'',textContent:'',className:'',disabled:false,
    options:[],replaceChildren(){this.options=[];},append(option){this.options.push(option);},
    addEventListener(event,handler){this[event]=handler;}}]));
  let stored=null, requested=0;
  const chrome={storage:{local:{async get(){return {};},async set(value){stored=value;}},
    session:{async get(){return {maleniaAudit:audit};}}},
    permissions:{async request({origins}){requested++; assert.equal(origins.length,3);return granted;}}};
  chrome.tabs={async query(){return openTabs || [
    {title:'ИНВента',url:'https://docs.google.com/spreadsheets/d/example/edit#gid=42'},
    {title:'DataLens',url:'https://analytics.example/dashboard?token=secret'},
    {title:'Asgard',url:'https://asgard.example/returns'},
    {title:'Duplicate',url:'https://asgard.example/returns#private'},
    {title:'Internal',url:'chrome://settings'},
    {title:'Credentials',url:'https://user:pass@secret.example/'},
    {title:'Local',url:'https://localhost/'},
  ];}};
  const ctx={URL,chrome,document:{getElementById:id=>nodes[id],createElement:()=>({})}};
  vm.createContext(ctx);vm.runInContext(automation,ctx);vm.runInContext(setup,ctx);
  nodes.targetInventory.value='https://docs.google.com/spreadsheets/d/example';
  nodes.targetDatalens.value='https://analytics.example/dashboard';
  nodes.targetAsgard.value='https://asgard.example/returns';
  return {nodes,click:async()=>{await nodes.saveTargets.click();await flush();},
    get stored(){return stored;},get requested(){return requested;}};
}
test('user explicitly saves three read-only sources and requests scoped permission',async()=>{
  const ui=screen();await ui.click();
  assert.equal(ui.requested,1);
  assert.equal(ui.stored.maleniaTargets.datalens,'https://analytics.example/dashboard');
  assert.equal(ui.stored.maleniaExactGetSearch,true);
  assert.match(ui.nodes.targetsStatus.textContent,/Готово/);
});

test('open-tab picker needs no typed URLs and reads no page content before permission',async()=>{
  const ui=screen();
  await ui.nodes.discoverTargets.click();
  assert.equal(ui.requested,0);assert.equal(ui.stored,null);
  assert.equal(ui.nodes.selectinventory.options.length,4);
  assert.ok(ui.nodes.selectinventory.options.every(option=>!/[?#]|secret|user:pass/.test(option.value)));
  for (const [role,url] of Object.entries({inventory:'https://docs.google.com/spreadsheets/d/example/edit',
    datalens:'https://analytics.example/dashboard',asgard:'https://asgard.example/returns'})) {
    ui.nodes['select'+role].value=url;
    ui.nodes['select'+role].change();
  }
  await ui.click();
  assert.equal(ui.requested,1);
  assert.equal(ui.stored.maleniaTargets.inventory,'https://docs.google.com/spreadsheets/d/example/edit');
});
test('denied permission never persists target URLs',async()=>{
  const ui=screen(false);await ui.click();
  assert.equal(ui.stored,null);
  assert.match(ui.nodes.targetsStatus.textContent,/не предоставлены/);
});
test('URLs with embedded credentials or query parameters fail before permission request',async()=>{
  const ui=screen();ui.nodes.targetAsgard.value='https://username:password@asgard.example/orders?token=secret';
  await ui.click();
  assert.equal(ui.requested,0);assert.equal(ui.stored,null);
  assert.doesNotMatch(ui.nodes.targetsStatus.textContent,/username|secret/);
});
test('diagnostic explains why DataLens failed without exposing cargo or site URLs',async()=>{
  const ui=screen(true,{phase:'needs_attention',results:[
    {role:'inventory',status:'read'},
    {role:'datalens',status:'needs_attention',reason:'dynamic_search_no_result_update'}]});
  await flush();
  assert.match(ui.nodes.orderAuditStatus.textContent,/DataLens: Таблица не обновилась/);
  assert.doesNotMatch(ui.nodes.orderAuditStatus.textContent,/BOX-1|https:/);
});

test('unique known corporate tabs are preselected without granting permissions or storing anything',async()=>{
 const tabs=[{title:'ИНВента',url:'https://docs.google.com/spreadsheets/d/example/edit'},
 {title:'DataLens',url:'https://datalens.yandex-team.ru/orders'},
 {title:'Asgard',url:'https://asgard.market.yandex-team.ru/'}];
 const ui=screen(true,null,tabs);
 for(const name of ['targetInventory','targetDatalens','targetAsgard'])ui.nodes[name].value='';
 await ui.nodes.discoverTargets.click();
 assert.equal(ui.nodes.targetInventory.value,tabs[0].url);
 assert.equal(ui.nodes.targetDatalens.value,tabs[1].url);
 assert.equal(ui.nodes.targetAsgard.value,tabs[2].url);
 assert.equal(ui.requested,0);assert.equal(ui.stored,null);
 await ui.click();assert.equal(ui.requested,1);assert.ok(ui.stored);
});
test('ambiguous corporate tabs remain unselected',async()=>{
 const ui=screen(true,null,[{title:'A',url:'https://datalens.yandex-team.ru/a'},
 {title:'B',url:'https://datalens.yandex-team.ru/b'}]);
 ui.nodes.targetDatalens.value='';await ui.nodes.discoverTargets.click();
 assert.equal(ui.nodes.targetDatalens.value,'');assert.equal(ui.stored,null);
});


test('automatic search failure displays the failed tab counts separately from active-tab diagnostics',async()=>{
 const ui=screen(true,{phase:'needs_attention',results:[{role:'datalens',status:'needs_attention',
   reason:'search_field_missing',surface:{visible_inputs:10,editable_inputs:10,bound_inputs:0,matched_inputs:0}}]});
 await flush();assert.match(ui.nodes.orderAuditStatus.textContent,/Вкладка разбора: видимых полей 10, доступных 10/);
});


test('failed-search popup explains a reset cargo value and retained review tab',async()=>{
 const ui=screen(true,{phase:'needs_attention',results:[{role:'datalens',status:'needs_attention',
   reason:'unmapped_search_results',step:'input_value_reset',review_available:true}]});
 await flush();assert.match(ui.nodes.orderAuditStatus.textContent,/не приняло номер до отправки/);
 assert.match(ui.nodes.orderAuditStatus.textContent,/Страница ошибки оставлена открытой/);
});


test('audit status identifies the extension version that actually executed the job',async()=>{
 const ui=screen(true,{bridge_version:'1.6.9',phase:'needs_attention',results:[]});
 await flush();assert.match(ui.nodes.orderAuditStatus.textContent,/Browser Bridge 1\.6\.9/);
});


test('popup distinguishes post-submit input reset from a failure to type or parse a table',async()=>{
 const ui=screen(true,{phase:'needs_attention',results:[{role:'datalens',status:'needs_attention',
  reason:'search_results_unconfirmed',step:'input_changed_after_submit'}]});
 await flush();
 assert.match(ui.nodes.orderAuditStatus.textContent,/После отправки поиска/);
 assert.doesNotMatch(ui.nodes.orderAuditStatus.textContent,/до отправки|распознать таблицу/);
});


test('loading-filter failure explicitly says no search was sent',async()=>{
 const ui=screen(true,{phase:'needs_attention',results:[{role:'datalens',status:'needs_attention',
  reason:'unmapped_search_results',step:'input_loading_timeout'}]});
 await flush();
 assert.match(ui.nodes.orderAuditStatus.textContent,/Фильтр DataLens не завершил загрузку; поиск не отправлен/);
 assert.doesNotMatch(ui.nodes.orderAuditStatus.textContent,/распознать таблицу/);
});


test('scan-structure diagnostics show bounded counts and the specific reason',async()=>{
 const ui=screen(true,{phase:'needs_attention',results:[{role:'datalens',status:'needs_attention',
  reason:'search_results_unconfirmed',step:'scan_row_width',scan_shape:{
   rows:23,columns:11,min_cells:1,max_cells:11,duplicate_required_headers:0,max_required_chars:24}}]});
 await flush();
 assert.match(ui.nodes.orderAuditStatus.textContent,/Число ячеек строки/);
 assert.match(ui.nodes.orderAuditStatus.textContent,/строк 23, колонок 11, ячеек в строке 1–11/);
});


test('verified writeback count is shown without claiming the run was read-only',async()=>{
 const ui=screen(true,{phase:'reconciled',results:[],writeback:{written:2,verified:true}});
 await flush();
 assert.match(ui.nodes.orderAuditStatus.textContent,/отмечено зелёным: 2/);
 assert.doesNotMatch(ui.nodes.orderAuditStatus.textContent,/без изменений сайтов/);
});
