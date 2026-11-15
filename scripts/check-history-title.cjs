// Run the actual history locator against a bounded title/widget DOM fixture.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2]||'browser-extension/automation.js','utf8');
const start=source.indexOf("        const caption='����� ᪠��� �� ������';");
const end=source.indexOf('        const historyBusy=',start);
assert.ok(start>0&&end>start);
function locate(text,{hidden=false,duplicate=false}={}){
 const widget={children:[],parentElement:null,getClientRects:()=>[{}],getAttribute:()=>null};
 const title={textContent:text,innerText:text,children:[],parentElement:widget,getClientRects:()=>[{}],closest:selector=>selector.includes('aria-hidden')?null:widget};
 widget.children=[title];
 const copy={...title,closest:selector=>selector.includes('aria-hidden')?(hidden?{}:null):widget};
 const document={querySelectorAll:()=>hidden||duplicate?[title,copy]:[title],body:{},documentElement:{}};
 const ctx={role:'datalens',document,getComputedStyle:()=>({display:'block',visibility:'visible'}),visible:el=>el.getClientRects().length>0,clean:s=>String(s||'').replace(/\s+/g,' ').trim()};
 return vm.runInNewContext(source.slice(start,end)+';historyWidget()===document.querySelectorAll()[0].parentElement',ctx);
}
assert.equal(locate('�����\u00a0᪠���\n��\u00a0������'),true);
assert.equal(locate('����� ᪠��� �� ������',{hidden:true}),true);
assert.equal(locate('����� ᪠��� �� ������',{duplicate:true}),false);
assert.equal(locate('��� (��� 1)'),false);
console.log('Actual history locator: 4 cases passed');
