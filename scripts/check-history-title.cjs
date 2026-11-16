// Run the actual history locator against a bounded title/widget DOM fixture.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2]||'browser-extension/automation.js','utf8');
const start=source.indexOf("        const caption='История сканов по заказу';");
const end=source.indexOf('        const historyBusy=',start);
assert.ok(start>0&&end>start);
function locate(text,{hidden=false,duplicate=false,measurement=false,native=false}={}){
 const widget={children:[],parentElement:null,getClientRects:()=>[{}],getAttribute:()=>null};
 const title={textContent:text,innerText:text,children:[],parentElement:widget,getClientRects:()=>[{}],closest:selector=>selector.includes('aria-hidden')?null:widget};
 widget.children=[title];
 const copy={...title,parentElement:duplicate?{...widget}:widget,closest:selector=>selector.includes('aria-hidden')?(hidden||(measurement&&selector.includes('gc-adaptive-tabs__select-switcher'))?{}:null):(duplicate?copy.parentElement:widget)};
 const all=hidden||duplicate||measurement?[title,copy]:[title];
 const document={querySelectorAll:selector=>selector==='.dl-widget__chart-title-text'?(native?all:[]):all,body:{},documentElement:{}};
 const ctx={role:'datalens',document,getComputedStyle:()=>({display:'block',visibility:'visible'}),visible:el=>el.getClientRects().length>0,clean:s=>String(s||'').replace(/\s+/g,' ').trim()};
 return vm.runInNewContext(source.slice(start,end)+';(typeof historyWidgets==="function"?historyWidgets():[historyWidget()].filter(Boolean)).length',ctx);
}
assert.equal(locate('История\u00a0сканов\nпо\u00a0заказу'),1);
assert.equal(locate('История сканов по заказу',{hidden:true}),1);
assert.equal(locate('История сканов по заказу',{duplicate:true}),0);
assert.equal(locate('Инфо (Шард 1)'),0);
assert.equal(locate('История сканов по заказу',{measurement:true,native:true}),1);
assert.equal(locate('История сканов по заказу',{duplicate:true,native:true}),2);
console.log('Actual history locator: 6 cases passed');
