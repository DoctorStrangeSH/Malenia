// Real React controlled-input checks, no corporate site/account needed.
// NODE_PATH=<jsdom/react/react-dom directory> node scripts/verify-datalens-empty.cjs
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const dom=new JSDOM('<div id="root"></div>',{url:'https://datalens.yandex-team.ru/94srinatuhls4-sc?tab=qmM',runScripts:'outside-only',pretendToBeVisual:true});
const {window}=dom;
Object.assign(global,{window,document:window.document,HTMLElement:window.HTMLElement});
Object.defineProperty(global,'navigator',{value:window.navigator,configurable:true});
window.HTMLElement.prototype.getClientRects=function(){for(let el=this;el;el=el.parentElement)if(el.style?.display==='none')return [];return [{}];};
const timeout=window.setTimeout.bind(window),interval=window.setInterval.bind(window),NativeDate=window.Date;
window.setTimeout=(fn,ms,...args)=>timeout(fn,ms/10,...args);
window.setInterval=(fn,ms,...args)=>interval(fn,ms/10,...args);
window.Date=class extends NativeDate {static now(){return NativeDate.now()*10;}};
const React=require('react'),{createRoot}=require('react-dom/client'),{flushSync}=require('react-dom');
const root=createRoot(window.document.getElementById('root'));
window.eval(fs.readFileSync('browser-extension/automation.js','utf8'));const api=window.eval('MaleniaAutomation');
async function check(options){
 let submits=0,timer;
 function Dashboard(){
  const [evidence,setEvidence]=React.useState(''),[value,setValue]=React.useState('DEFAULT'),[generation,setGeneration]=React.useState(0),[result,setResult]=React.useState(options.initialEmpty?'empty':'old'),[busy,setBusy]=React.useState(false),[other,setOther]=React.useState(0);
  const submit=()=>{submits++;
   if(options.stale){setOther(x=>x+1);return;}
   setBusy(true);
   timer=window.setTimeout(()=>{setResult(options.positive||(options.padding&&value==='0000012345678')?'positive':'empty');setEvidence(value);setGeneration(x=>x+1);setOther(x=>x+1);if(!options.busyForever)setBusy(false);if(options.wrongInput)setValue('OTHER');},200);
  };
  const empty=React.createElement('div',{key:generation},React.createElement(options.emptyTag||'span',null,'��� ������'));
  const table=React.createElement('table',null,React.createElement('tbody',null,
   React.createElement('tr',null,...['scanned_at','sc_id','result','place_external_id'].map(s=>React.createElement('th',{key:s},s))),
   React.createElement('tr',null,...['2026/10/05 16:51:32','101366','OK',result==='positive'?(options.padding?evidence:'TEST-1'):'OLD'].map((s,i)=>React.createElement('td',{key:i},s)))));
  return React.createElement(React.Fragment,null,
   React.createElement('div',{'data-qa':'dashkit-grid-item','data-dashkit-grid-id':'13'},React.createElement('span',{'data-qa':'chartkit-control-input'},React.createElement('input',{className:'g-text-input__control',type:'text',value,onChange:e=>setValue(e.target.value),onKeyPress:e=>{if(e.charCode===13)submit();}}))),
   React.createElement('section',{'data-qa':options.noWidgetAttributes?undefined:'dashkit-grid-item',key:options.replaceWidget?generation:'history'},
    React.createElement(options.titleTag||'h3',null,options.noTitle?'��㣮� ������':options.spacedTitle?'�����\u00a0᪠���\n��\u00a0������':'����� ᪠��� �� ������'),
    busy?React.createElement('div',{role:'progressbar'},'����㧪�'):null,
    options.error&&generation?React.createElement('div',{role:'alert'},'�訡�� ����㧪�'):null,
    result==='empty'?empty:table),
   React.createElement('div',{'data-qa':'dashkit-grid-item'},React.createElement('h3',null,'��� (��� 1)'),React.createElement(options.emptyTag||'span',null,'��� ������'),React.createElement('span',null,other)),
   options.hiddenCaption?React.createElement('section',{'aria-hidden':'true'},React.createElement('p',null,'����� ᪠��� �� ������'),React.createElement('em',null,'��� ������')):null,
   options.duplicateCaption?React.createElement('section',null,React.createElement('p',null,'����� ᪠��� �� ������'),React.createElement('em',null,'��� ������')):null);
 }
 flushSync(()=>root.render(React.createElement(Dashboard,{key:JSON.stringify(options)})));
 const chrome={tabs:{onUpdated:{addListener(){},removeListener(){}},async create({url}){return {id:7,url,status:'complete'};},async get(){return {id:7,url:window.location.href,status:'complete'};},async remove(){}},scripting:{async executeScript({world,func,args}){assert.equal(world,'MAIN');window.args=args;return [{result:await window.eval('('+func.toString()+')(...args)')}];}}};
 try{
  const search=()=>api.workplaceSearch(chrome,7,'datalens','TEST-1',window.location.origin);
  if(options.padding){
   const targets={inventory:'https://docs.google.com/spreadsheets/d/example/edit',datalens:window.location.href,asgard:'https://asgard.market.yandex-team.ru/returnBox/search'};
   let marked=false;
   const result=await api.run(chrome,targets,async msg=>{
    if(msg.type==='mark_inventa_found'){
     assert.equal(msg.inventory.rows[0][0],'12345678');assert.equal(msg.datalens.rows[0][0],'12345678');marked=true;
     return {ok:true,type:'inventa_found_marked',verified:true,written:1};
    }
    return {ok:true,type:'site_tables_reconciled',read_only:true,write_enabled:false,persisted:false,total:1,summary:{found:1,in_progress:0,manual_review:0}};
   },async()=>{},{exactGetSearch:true,seedInventory:{columns:['cargo_place','inventory_date'],rows:[['12345678','2026-10-03']]},writebackJobId:'job'});
   assert.equal(result.phase,'reconciled');assert.ok(marked);assert.equal(submits,6);assert.equal(window.document.querySelector('input').value,'0000012345678');return;
  }
  if(options.stale||options.error||options.busyForever||options.wrongInput||options.noTitle||options.duplicateCaption)await assert.rejects(search,/search_results_unconfirmed|unmapped_search_results/);
  else{
   const result=await search();assert.equal(result.rows.length,options.positive?1:0);
   assert.deepEqual(Array.from(api.asgardSearchKeys({columns:['cargo_place','inventory_date'],rows:[['TEST-1','2026-10-03']]},result)),options.positive?[]:['TEST-1']);
  }
  assert.equal(submits,1);
 }finally{window.clearTimeout(timer);flushSync(()=>root.render(null));}
}
const cases=[{initialEmpty:true,spacedTitle:true,padding:true},{initialEmpty:true,noWidgetAttributes:true,titleTag:'a',emptyTag:'em',padding:true},{initialEmpty:true,noWidgetAttributes:true,stale:true},{initialEmpty:true,noWidgetAttributes:true,busyForever:true},{initialEmpty:true,noWidgetAttributes:true,error:true},{initialEmpty:true,noWidgetAttributes:true,wrongInput:true},{noWidgetAttributes:true,noTitle:true},{initialEmpty:true,noWidgetAttributes:true,replaceWidget:true},{initialEmpty:true,noWidgetAttributes:true,duplicateCaption:true},{initialEmpty:true,titleTag:'a',emptyTag:'em'},{initialEmpty:true,noWidgetAttributes:true,titleTag:'p'},{}, {initialEmpty:true},{initialEmpty:true,replaceWidget:true},{initialEmpty:true,stale:true},
 {initialEmpty:true,error:true},{initialEmpty:true,busyForever:true},{initialEmpty:true,wrongInput:true},{noTitle:true},{positive:true},{initialEmpty:true,padding:true}];
cases.push({initialEmpty:true,spacedTitle:true,noWidgetAttributes:true,padding:true},
 {initialEmpty:true,hiddenCaption:true,padding:true},
 {initialEmpty:true,spacedTitle:true,stale:true},
 {initialEmpty:true,spacedTitle:true,busyForever:true},
 {initialEmpty:true,spacedTitle:true,error:true},
 {initialEmpty:true,spacedTitle:true,wrongInput:true},
 {initialEmpty:true,spacedTitle:true,duplicateCaption:true});
(async()=>{try{for(const c of cases)await check(c);console.log(`DataLens empty React integration: ${cases.length} scenarios passed`);}finally{root.unmount();window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
