// NODE_PATH=<directory containing jsdom> node scripts/verify-asgard-cards.cjs
// Synthetic reverse-flow list and actual DOM card/history layout; no site login.
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('browser-extension/automation.js','utf8');
async function check({empty=false,foreign=false,mismatch=false,duplicate=false,company=true}={}){
 const host='https://asgard.market.yandex-team.ru';let dom,clicks=0,visited=[];
 function page(html,url){dom?.window.close();dom=new JSDOM(html,{url:host+url,runScripts:'outside-only'});dom.window.HTMLElement.prototype.getClientRects=function(){return [{}];};}
 const headers='<tr><th>Статус грузоместа</th><th>ID возврата</th><th>ID партнера</th><th>ID коробки</th><th>Точка назначения</th></tr>';
 const dest=company?'Склад ООО "Купишуз"':'Склад партнера';
 page('<label>Штрихкод коробки<input></label><button>Найти</button><table>'+headers+'</table>','/returnBox/search');
 dom.window.document.querySelector('button').onclick=()=>{
  clicks++;
  setTimeout(()=>dom.window.document.querySelector('table').innerHTML=headers+(empty?'<tr><td colspan="5">Ничего не найдено</td></tr>':
   ['Выдан','В пути',...(duplicate?['В пути']:[])].map((status,i)=>`<tr><td>${status}</td><td>111</td><td>222</td><td><a href="/returnBox/${100+i}">${100+i}</a></td><td>${dest}</td></tr>`).join('')),50);
 };
 const chrome={tabs:{async update(id,{url}){visited.push(url);const box=mismatch?'999':url.split('/').pop();page(`<h1>Грузоместо ${foreign?'OTHER':'TEST-1'}</h1><span>В пути</span><aside>ID грузоместа ${box} Точка назначения ${dest}</aside><section><h3>История изменения статусов</h3><table><tr><th>Дата</th><th>Статус</th></tr><tr><td>23.09.2026 08:18:51</td><td>В пути</td></tr><tr><td>22.09.2026 11:43:25</td><td>Принят у отправителя</td></tr></table></section>`,new URL(url).pathname);},async get(){return {status:'complete',url:dom.window.location.href};},onUpdated:{addListener(){},removeListener(){}}},
 scripting:{async executeScript({func,args,world}){assert.equal(world,'ISOLATED');dom.window.args=args;return [{result:await dom.window.eval('('+func.toString()+')(...args)')}];}}};
 const ctx={URL,setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(source,ctx);
 try{
  if(foreign||mismatch||duplicate){await assert.rejects(()=>ctx.MaleniaAutomation.workplaceSearch(chrome,7,'asgard','TEST-1',host,true),/unverified_search_result_identity/);}
  else {const table=await ctx.MaleniaAutomation.workplaceSearch(chrome,7,'asgard','TEST-1',host,true);
   assert.equal(table.rows[0][0],'TEST-1');assert.equal(table.rows[0][5],empty?'not_found':'card');
   if(!empty){assert.equal(table.rows[0][2],'101');assert.equal(table.rows[0][1],'В пути');assert.deepEqual(JSON.parse(table.rows[0][4]),['В пути','Принят у отправителя']);}
  }
  assert.equal(clicks,1);assert.ok(visited.every(url=>!url.endsWith('/100')),'Issued neighbour was opened');
 }finally{dom.window.close();}
}
(async()=>{for(const scenario of [{},{empty:true},{foreign:true},{mismatch:true},{duplicate:true},{company:false}])await check(scenario);console.log('Asgard DOM integration: 6 scenarios passed');})().catch(error=>{console.error(error);process.exit(1);});
