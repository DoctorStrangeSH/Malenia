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
async function check({blockEvents=false,refuse=false,reload=false,blurOnly=false,tableDecorations=false,tableStructure=false,nullIdentityRow=false}){
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
 const extras=[];
 if(nullIdentityRow){
  const raw=window.document.createElement('tr');
  raw.innerHTML='<td>2026/10/09 18:15:10</td><td>101 366</td><td>OK</td><td><i>null</i></td>';
  window.document.querySelector('table tbody').append(raw);extras.push(raw);
 }

 if(tableStructure){
  const table=window.document.querySelector('table');
  const footer=window.document.createElement('tfoot');
  footer.innerHTML='<tr><td colspan="4">Summary</td></tr>';
  table.append(footer);extras.push(footer);
 }

 if(tableDecorations){
  const main=window.document.querySelector('table');
  const header=main.cloneNode(true);
  header.querySelector('tbody').remove();
  // gravity-ui/react-data-table also renders a separate sticky-head table.
  const head=window.document.createElement('thead');
  head.append(header.querySelector('tr') || main.querySelector('tr').cloneNode(true));
  header.append(head);extras.push(header);window.document.body.prepend(header);
  // Modern DataLens uses a portal measurement table far outside the viewport.
  const measure=window.document.createElement('div');
  measure.className='dl-table__background-table';
  measure.style.cssText='position:absolute;top:-100000px;left:-100000px';
  measure.append(main.cloneNode(true));extras.push(measure);window.document.body.append(measure);
 }
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
   if(nullIdentityRow){
    assert.equal(result.rows.length,1);
    assert.deepEqual(Array.from(api.asgardSearchKeys({columns:['cargo_place','inventory_date'],
     rows:[['TEST-1','2026-10-03']]},result)),[]);
   }
   assert.equal(submits,1);
   assert.equal(window.document.querySelector('input').value,'TEST-1');
  }
  assert.equal(changes,1);
  assert.equal(blurSubmits,blurOnly?1:0);
 }finally{
  if(blockEvents)for(const type of ['input','change'])window.document.removeEventListener(type,block,true);
  for(const extra of extras)extra.remove();
 }
}
// Mirrors DataLens's published loading stub: the text input accepts local
// edits, but param is empty and onChange is a no-op until /api/run finishes.
async function checkLoadingStub(){
 let realSubmits=0,stubSubmits=0,editsBeforeReady=0,loadedAt=0;
 function BaseControlInput({value,onChange,param,type}){
  const [text,setText]=React.useState(value || '');
  React.useEffect(()=>setText(value),[value]);
  return React.createElement('span',{'data-qa':'chartkit-control-input'},
   React.createElement('input',{type:'text',className:'g-text-input__control',value:text,
    onChange:event=>{if(!param)editsBeforeReady++;setText(event.target.value);},
    onKeyPress:event=>{if(event.charCode===13)onChange(text);},
    onBlur:()=>setTimeout(()=>onChange(text),0)
   }));
 }
 function Dashboard(){
  const [loaded,setLoaded]=React.useState(false);
  const [value,setValue]=React.useState('134305382');
  const [result,setResult]=React.useState('OLD');
  React.useEffect(()=>{
   const timer=setTimeout(()=>{loadedAt=Date.now();setLoaded(true);},2200);
   return ()=>clearTimeout(timer);
  },[]);
  return React.createElement(React.Fragment,null,
   React.createElement('div',{'data-qa':'dashkit-grid-item','data-dashkit-grid-id':'13'},
    React.createElement(BaseControlInput,{type:'input',param:loaded?'barcode':'',
     value:loaded?value:'',onChange:loaded?code=>{
      realSubmits++;assert.ok(Date.now()>=loadedAt);setValue(code);setResult(code);
     }:()=>{stubSubmits++;}})),
   React.createElement('table',null,React.createElement('tbody',null,
    React.createElement('tr',null,...['scanned_at','sc_id','result','place_external_id'].map(x=>React.createElement('th',{key:x},x))),
    React.createElement('tr',null,...['2026/10/05 16:51:32','101 366','OK',result].map((x,i)=>React.createElement('td',{key:i},x)))
   )));
 }
 flushSync(()=>root.render(React.createElement(Dashboard)));
 const chrome={scripting:{executeScript:async({func,args})=>[
  {result:await window.eval('('+func.toString()+')(...'+JSON.stringify(args)+')')}
 ]}};
 const result=await api.workplaceSearch(chrome,1,'datalens','TEST-1',window.location.origin);
 assert.equal(result.rows[0][0],'TEST-1');
 assert.equal(stubSubmits,0);
 assert.equal(editsBeforeReady,0);
 assert.equal(realSubmits,1);
 assert.equal(window.document.querySelector('input').value,'TEST-1');
 console.log('PASS: delayed DataLens loading stub receives no edits/submits; real loaded control submits once.');
}
(async()=>{
 try{
  if(process.argv.includes('--null-identity-only')){await check({nullIdentityRow:true});console.log('PASS: null-identity scan is excluded; exact cargo still satisfies Found.');return;}
  if(process.argv.includes('--table-structure-only')){await check({tableStructure:true});console.log('PASS: footer summary is not interpreted as a scan row.');return;}
  if(process.argv.includes('--table-layout-only')){await check({tableDecorations:true});console.log('PASS: sticky header and offscreen measurement copy do not invalidate the scan table.');return;}
  if(process.argv.includes('--loading-stub-only')){await checkLoadingStub();return;}
  await check({});
  await check({blockEvents:true});
  await check({blockEvents:true,refuse:true});
  await check({reload:true});
  await check({blurOnly:true});
  await check({tableDecorations:true});
  await check({tableStructure:true});
  await check({nullIdentityRow:true});
  await checkLoadingStub();
  console.log('PASS: React 18 controlled input: normal events, rejected DOM events, refused state, 2.2s input replacement, blur-only control, no double submit.');
 }finally{root.unmount();window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
