// Optional integration check: NODE_PATH=<directory containing react, react-dom,
// jsdom> node scripts/verify-datalens-react-input.cjs
// Uses real React controlled inputs and timers; no corporate site/data needed.
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{
 url:'https://datalens.yandex-team.ru/94srinatuhls4-sc?tab=qmM',runScripts:'outside-only',pretendToBeVisual:true
});
const {window}=dom;
Object.assign(global,{window,document:window.document,HTMLElement:window.HTMLElement});
Object.defineProperty(global,'navigator',{value:window.navigator,configurable:true});
window.HTMLElement.prototype.getClientRects=function(){return [{}];};
const React=require('react');
const {createRoot}=require('react-dom/client');
const {flushSync}=require('react-dom');
window.eval(fs.readFileSync(path.join(__dirname,'../browser-extension/automation.js'),'utf8'));
const api=window.eval('MaleniaAutomation');
const root=createRoot(window.document.getElementById('root'));
async function check({blockEvents=false,refuse=false,reload=false,blurOnly=false}){
 let changes=0,submits=0,blurSubmits=0;
 function Dashboard(){
  const [value,setValue]=React.useState('DEFAULT-EXAMPLE');
  const [result,setResult]=React.useState('OLD');
  const [generation,setGeneration]=React.useState(0);
  return React.createElement(React.Fragment,null,
   React.createElement('div',{'data-qa':'dashkit-grid-item','data-dashkit-grid-id':'13'},
    React.createElement('span',{'data-qa':'chartkit-control-input'},
     React.createElement('input',{key:generation,className:'g-text-input__control',type:'text',value,
      onChange:event=>{changes++;if(!refuse)setValue(event.target.value);},
      onKeyPress:blurOnly?undefined:event=>{if(event.charCode===13){
       submits++;setResult(value);
       if(reload){
        const requested=value;
        setValue('');setGeneration(x=>x+1);
        // Simulate reload replacing the node while a result already looks fresh.
        setTimeout(()=>setValue(requested),2200);
       }
      }},
      // DataLens also commits on blur; Enter must not be followed by blur.
      onBlur:()=>{blurSubmits++;if(blurOnly){submits++;setTimeout(()=>setResult(value),0);}else setResult('STALE-BLUR');}
     }))),
   React.createElement('table',null,React.createElement('tbody',null,
    React.createElement('tr',null,...['scanned_at','sc_id','result','place_external_id'].map(x=>React.createElement('th',{key:x},x))),
    React.createElement('tr',null,...['2026/10/05 16:51:32','101 366','OK',result].map((x,i)=>React.createElement('td',{key:i},x)))
   )));
 }
 flushSync(()=>root.render(React.createElement(Dashboard)));
 const block=event=>event.stopImmediatePropagation();
 if(blockEvents)for(const type of ['input','change'])window.document.addEventListener(type,block,true);
 const chrome={scripting:{executeScript:async({world,func,args})=>{
  assert.equal(world,'MAIN');
  return [{result:await window.eval('('+func.toString()+')(...'+JSON.stringify(args)+')')}];
 }}};
 try{
  if(refuse){
   await assert.rejects(()=>api.workplaceSearch(chrome,1,'datalens','TEST-1',window.location.origin),
    error=>error.step==='input_value_reset');
   assert.equal(submits,0);
  }else{
   const result=await api.workplaceSearch(chrome,1,'datalens','TEST-1',window.location.origin);
   assert.equal(result.rows[0][0],'TEST-1');
   assert.equal(submits,1);
   assert.equal(window.document.querySelector('input').value,'TEST-1');
  }
  assert.equal(changes,1);
  assert.equal(blurSubmits,blurOnly?1:0);
 }finally{
  if(blockEvents)for(const type of ['input','change'])window.document.removeEventListener(type,block,true);
 }
}
(async()=>{
 try{
  await check({});
  await check({blockEvents:true});
  await check({blockEvents:true,refuse:true});
  await check({reload:true});
  await check({blurOnly:true});
  console.log('PASS: React 18 controlled input: normal events, rejected DOM events, refused state, 2.2s input replacement, blur-only control, no double submit.');
 }finally{root.unmount();window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
