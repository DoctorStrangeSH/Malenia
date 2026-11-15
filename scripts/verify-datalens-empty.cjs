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
  const [value,setValue]=React.useState('DEFAULT'),[generation,setGeneration]=React.useState(0),[result,setResult]=React.useState(options.initialEmpty?'empty':'old'),[busy,setBusy]=React.useState(false),[other,setOther]=React.useState(0);
  const submit=()=>{submits++;
   if(options.stale){setOther(x=>x+1);return;}
   setBusy(true);
   timer=window.setTimeout(()=>{setResult(options.positive?'positive':'empty');setGeneration(x=>x+1);setOther(x=>x+1);if(!options.busyForever)setBusy(false);if(options.wrongInput)setValue('OTHER');},200);
  };
  const empty=React.createElement('div',{key:generation},React.createElement('span',null,'Нет данных'));
  const table=React.createElement('table',null,React.createElement('tbody',null,
   React.createElement('tr',null,...['scanned_at','sc_id','result','place_external_id'].map(s=>React.createElement('th',{key:s},s))),
   React.createElement('tr',null,...['2026/10/05 16:51:32','101366','OK',result==='positive'?'TEST-1':'OLD'].map((s,i)=>React.createElement('td',{key:i},s)))));
  return React.createElement(React.Fragment,null,
   React.createElement('div',{'data-qa':'dashkit-grid-item','data-dashkit-grid-id':'13'},React.createElement('span',{'data-qa':'chartkit-control-input'},React.createElement('input',{className:'g-text-input__control',type:'text',value,onChange:e=>setValue(e.target.value),onKeyPress:e=>{if(e.charCode===13)submit();}}))),
   React.createElement('div',{'data-qa':'dashkit-grid-item',key:options.replaceWidget?generation:'history'},
    React.createElement('h3',null,options.noTitle?'Другой виджет':'История сканов по заказу'),
    busy?React.createElement('div',{role:'progressbar'},'Загрузка'):null,
    options.error&&generation?React.createElement('div',{role:'alert'},'Ошибка загрузки'):null,
    result==='empty'?empty:table),
   React.createElement('div',{'data-qa':'dashkit-grid-item'},React.createElement('h3',null,'Инфо (Шард 1)'),React.createElement('span',null,'Нет данных'),React.createElement('span',null,other)));
 }
 flushSync(()=>root.render(React.createElement(Dashboard,{key:JSON.stringify(options)})));
 const chrome={scripting:{async executeScript({world,func,args}){assert.equal(world,'MAIN');window.args=args;return [{result:await window.eval('('+func.toString()+')(...args)')}];}}};
 try{
  const search=()=>api.workplaceSearch(chrome,7,'datalens','TEST-1',window.location.origin);
  if(options.stale||options.error||options.busyForever||options.wrongInput||options.noTitle)await assert.rejects(search,/search_results_unconfirmed|unmapped_search_results/);
  else{
   const result=await search();assert.equal(result.rows.length,options.positive?1:0);
   assert.deepEqual(Array.from(api.asgardSearchKeys({columns:['cargo_place','inventory_date'],rows:[['TEST-1','2026-10-03']]},result)),options.positive?[]:['TEST-1']);
  }
  assert.equal(submits,1);
 }finally{window.clearTimeout(timer);flushSync(()=>root.render(null));}
}
const cases=[{}, {initialEmpty:true},{initialEmpty:true,replaceWidget:true},{initialEmpty:true,stale:true},
 {initialEmpty:true,error:true},{initialEmpty:true,busyForever:true},{initialEmpty:true,wrongInput:true},{noTitle:true},{positive:true}];
(async()=>{try{for(const c of cases)await check(c);console.log(`DataLens empty React integration: ${cases.length} scenarios passed`);}finally{root.unmount();window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
