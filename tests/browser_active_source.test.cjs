const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const automation=fs.readFileSync(path.resolve(__dirname,'../browser-extension/automation.js'),'utf8');
const script=fs.readFileSync(path.resolve(__dirname,'../browser-extension/active-source.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function popup(url, saved={}, allowed=true){
 const nodes=Object.fromEntries(['useActiveSource','activeSourceRole','activeSourceTitle','activeSourceStatus']
   .map(id=>[id,{value:'',disabled:true,textContent:'',addEventListener(event,fn){this[event]=fn;}}]));
 const queries=[],permissions=[],messages=[],shared=[];
 const chrome={tabs:{async query(query){queries.push(query);return [{id:7,url,title:'Current workplace'}];}},
   storage:{local:{async get(){return {maleniaTargets:saved};}}},
   permissions:{async request(value){permissions.push(value);return allowed;}},
   runtime:{async sendMessage(message){messages.push(message);saved={...saved,[message.role]:message.url};return {ok:true,targets:saved};}}};
 const context={URL,chrome,document:{getElementById:id=>nodes[id]},crypto:{randomUUID:()=> 'request'},
   sanitizedTab:tab=>({title:tab.title,url:new URL(tab.url).origin+new URL(tab.url).pathname}),
   sendNativeMessage:async message=>{shared.push(message);return {ok:true};}};
 vm.createContext(context);vm.runInContext(automation,context);vm.runInContext(script,context);await flush();
 return {nodes,queries,permissions,messages,shared,get saved(){return saved;},async click(){await nodes.useActiveSource.click();await flush();}};
}
test('bind current tab without scanning other tabs and persist each role across popup sessions',async()=>{
 let saved={};
 for(const [role,url] of Object.entries({inventory:'https://docs.google.com/spreadsheets/d/example/edit#gid=7',
   datalens:'https://datalens.yandex-team.ru/orders?token=secret',asgard:'https://asgard.market.yandex-team.ru/'})){
   const p=await popup(url,saved);assert.equal(p.nodes.activeSourceRole.value,role);
   assert.equal(p.queries.length,1);assert.equal(p.queries[0].active,true);
   assert.equal(p.permissions.length,0);assert.equal(p.messages.length,0);
   await p.click();assert.equal(p.permissions.length,1);assert.equal(p.shared.length,1);
   assert.equal(p.messages[0].role,role);assert.doesNotMatch(p.messages[0].url,/[?#]/);
   saved=p.saved;
 }
 assert.equal(Object.keys(saved).length,3);
 const reopened=await popup('https://asgard.market.yandex-team.ru/',saved);
 assert.match(reopened.nodes.activeSourceStatus.textContent,/Инвентаризация: сохранён/);
 assert.match(reopened.nodes.activeSourceStatus.textContent,/DataLens: сохранён/);
});
test('denied permission, unsafe tab and missing role never save a source',async()=>{
 const denied=await popup('https://asgard.market.yandex-team.ru/',{},false);await denied.click();
 assert.equal(denied.messages.length,0);assert.equal(denied.shared.length,0);
 const unknown=await popup('https://example.com/');await unknown.click();assert.equal(unknown.permissions.length,0);
 for(const url of ['chrome://settings','https://user:password@example.com/','http://example.com/']){
   const p=await popup(url);assert.equal(p.nodes.useActiveSource.disabled,true);assert.equal(p.messages.length,0);
 }
});


test('current DataLens Orders source keeps its tab while stripping state and other parameters',async()=>{
 const p=await popup('https://datalens.yandex-team.ru/94srinatuhls4-sc?tab=qmM&state=example-state');
 await p.click();assert.equal(p.saved.datalens,'https://datalens.yandex-team.ru/94srinatuhls4-sc?tab=qmM');
 assert.equal(p.queries.length,1);assert.equal(p.permissions.length,1);
});
