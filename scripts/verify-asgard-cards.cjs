// NODE_PATH=<directory containing jsdom> node scripts/verify-asgard-cards.cjs
// Synthetic source pages only; no corporate login or production identifiers.
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('browser-extension/automation.js','utf8');
const READY='Готов для отгрузки в заборную логистику';
async function check({hiddenNotice=false,duplicateNotice=false,stuckBusy=false,genericNotice=false,plainNotice=false,wrappedNotice=false,noticeEmpty=false,empty=false,foreign=false,mismatch=false,duplicate=false,company=false,
 foreignTransit=false,serviceError=false,ready=false,wasIssued=false,multipleIssued=false,foreignGroup=false,initialMissing=false,replaceTable=false,replaceInput=false,wrongInput=false,hiddenBusy=false,cacheBusy=false,unrelated=false,tableAttribute=false,headingLevel=1,compactCard=false,deepTitle=0,statusTag="span",fourHistory=false,directFF=false,ffHistory=false,lowerFF=false,upperStatus=false,missingCurrent=false,conflictingCurrent=false}={}){
 noticeEmpty=noticeEmpty||plainNotice;
 empty=empty||noticeEmpty;
 const host='https://asgard.market.yandex-team.ru';let dom,clicks=0,visited=[],renderTimer;
 const active=directFF?'Принят на ФФ':ready?READY:'В пути',dest=company?'Склад ООО "Купишуз"':'Склад партнера';
 const displayStatus=s=>upperStatus?s.toUpperCase():lowerFF?s.replace('Принят на ФФ','Принят на фф'):s;
 function page(html,url){
  dom?.window.close();dom=new JSDOM(html,{url:host+url,runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.getClientRects=function(){return this.style.display==='none'?[]:[{}];};
 }
 const headers='<tr><th>Статус грузоместа</th><th>ID возврата</th><th>ID партнера</th><th>ID коробки</th><th>Точка назначения</th></tr>';
 page('<label>Штрихкод коробки<input></label><button>Найти</button><div id="results">'+(initialMissing?'':'<table>'+headers+'</table>')+'</div>'+(hiddenBusy?'<div role="progressbar" style="display:none"></div>':''),'/returnBox/search');
 const statuses=directFF?[active]:foreign&&!foreignGroup?[active]:['Выдан',active,...(duplicate?[active]:multipleIssued?['Выдан']:[])];
 const rendered=headers+(empty?'<tr><td colspan="5">Ничего не найдено</td></tr>':statuses.map((status,i)=>`<tr><td>${displayStatus(status)}</td><td>111</td><td>222</td><td><a href="/returnBox/${100+i}">${100+i}</a></td><td>${dest}</td></tr>`).join(''));
 const notice=plainNotice?(wrappedNotice?'<section class="custom-message"><div><strong>Коробки не найдены</strong></div></section>':'<div class="custom-message">Коробки не найдены</div>'):'<div class="ant-alert ant-alert-info"><span class="ant-alert-message">Коробки не найдены</span></div>';
 const noticeHTML=(hiddenNotice?'<div aria-hidden="true">'+notice+'</div>':genericNotice?notice.replace('Коробки не найдены','Нет данных'):notice)+(duplicateNotice?notice:'');
 const resultHTML=noticeEmpty?noticeHTML:'<table>'+rendered+'</table>';
 if(cacheBusy||unrelated||tableAttribute)dom.window.document.querySelector('#results').innerHTML=resultHTML;
 dom.window.document.querySelector('button').onclick=()=>{
  clicks++;
  if(serviceError){const el=dom.window.document.createElement('div');el.setAttribute('role','alert');el.textContent='Ошибка загрузки';dom.window.document.body.append(el);return;}
  if(cacheBusy||stuckBusy)dom.window.document.querySelector('button').disabled=true;
  renderTimer=setTimeout(()=>{
   if(cacheBusy){dom.window.document.querySelector('button').disabled=false;return;}
   if(tableAttribute){dom.window.document.querySelector('table').className='hover';return;}
   if(unrelated){dom.window.document.body.append(dom.window.document.createElement('aside'));return;}
   if(initialMissing||replaceTable||noticeEmpty)dom.window.document.querySelector('#results').innerHTML=resultHTML;
   else dom.window.document.querySelector('table').innerHTML=rendered;
   if(replaceInput){const old=dom.window.document.querySelector('input'),live=old.cloneNode();live.value=wrongInput?'OTHER':'TEST-1';old.replaceWith(live);}
  },50);
 };
 const chrome={tabs:{
  async update(id,{url}){
   visited.push(url);const cardId=url.split('/').pop(),box=mismatch?'999':cardId;
   const cardStatus=statuses[Number(cardId)-100];
   const other=foreign||(foreignTransit&&cardId==='101');
   const history=fourHistory?[cardStatus,'Создан',cardStatus,'Создан']:[cardStatus,'Принят у отправителя',...(wasIssued?['Выдан']:[]),...(ffHistory?['Принят на ФФ']:[])];
   const title='<div>'.repeat(deepTitle)+'<h3>История изменения статусов</h3>'+'</div>'.repeat(deepTitle);
   page(`<h${headingLevel}>Грузоместо ${other?'OTHER':'TEST-1'}</h${headingLevel}>${missingCurrent?'':`<${statusTag}>${displayStatus(cardStatus)}</${statusTag}>`}${conflictingCurrent?'<span>Выдан</span>':''}<aside>ID грузоместа${compactCard?'':' '}${box} Точка назначения ${dest}</aside>
    <section>${title}<table><tr><th>Дата</th><th>Статус</th></tr>
    ${history.map(s=>`<tr><td>23.09.2026 08:18:51</td><td>${s==='Принят у отправителя'||s==='Создан'?s:displayStatus(s)}</td></tr>`).join('')}</table></section>`,new URL(url).pathname);
  },
  async get(){return {status:'complete',url:dom.window.location.href};},
  onUpdated:{addListener(){},removeListener(){}}
 },scripting:{async executeScript({func,args,world}){
  assert.equal(world,'ISOLATED');dom.window.args=args;
  return [{result:await dom.window.eval('('+func.toString()+')(...args)')}];
 }}};
 const ctx={URL,setTimeout:(fn,ms)=>setTimeout(fn,ms/10),clearTimeout,Date:{now:()=>Date.now()*10}};vm.createContext(ctx);vm.runInContext(source,ctx);
 const search=()=>ctx.MaleniaAutomation.workplaceSearch(chrome,7,'asgard','TEST-1',host,true);
 try{
  if(missingCurrent||conflictingCurrent)await assert.rejects(search,error=>error.message==='unverified_search_result_identity'&&error.step==='asgard_card_status');
  else if(serviceError)await assert.rejects(search,/search_results_unconfirmed/);
  else if(hiddenNotice||duplicateNotice||stuckBusy||genericNotice)await assert.rejects(search,error=>error.message==='search_results_unconfirmed'&&error.step===(stuckBusy?'asgard_wait_loading':duplicateNotice?'asgard_table_ambiguous':'asgard_table_missing'));
  else if(wrongInput||unrelated||tableAttribute)await assert.rejects(search,error=>error.message==='search_results_unconfirmed'&&error.step===(wrongInput?'asgard_input_unconfirmed':'asgard_result_not_refreshed'));
  else if((foreign&&!foreignGroup)||mismatch||duplicate)await assert.rejects(search,/unverified_search_result_identity/);
  else{
   const table=await search(),row=table.rows[0];assert.equal(row[0],'TEST-1');
   assert.equal(row[5],empty?'not_found':company?'search_destination':foreignGroup?'issued_group':'card');
   if(foreignGroup){assert.equal(row[1],'Выдан');assert.equal(row[2],'');}
   else if(company&&!empty){assert.equal(row[1],'Купишуз');assert.equal(visited.length,0);}
   else if(!empty){
    const expectedStatus=foreignTransit?'Выдан':active;
    assert.equal(row[2],foreignTransit||directFF?'100':'101');assert.equal(row[1],expectedStatus);
    assert.deepEqual(JSON.parse(row[4]),fourHistory?[expectedStatus,'Создан',expectedStatus,'Создан']:[expectedStatus,'Принят у отправителя',...(wasIssued?['Выдан']:[]),...(ffHistory?['Принят на ФФ']:[])]);
   }
  }
  assert.equal(clicks,1);
  if(!foreign&&!foreignTransit&&!directFF)assert.ok(visited.every(url=>!url.endsWith('/100')),'Issued neighbour was opened');
 }finally{clearTimeout(renderTimer);dom.window.close();}
}
const scenarios=[{plainNotice:true,hiddenNotice:true,initialMissing:true},{plainNotice:true,duplicateNotice:true,initialMissing:true},{plainNotice:true,stuckBusy:true,initialMissing:true},{plainNotice:true,genericNotice:true,initialMissing:true},{plainNotice:true,initialMissing:true},{plainNotice:true,wrappedNotice:true,initialMissing:true},{plainNotice:true,cacheBusy:true},{plainNotice:true,unrelated:true},{plainNotice:true,replaceInput:true,wrongInput:true},{plainNotice:true,serviceError:true},{noticeEmpty:true,initialMissing:true},{noticeEmpty:true,cacheBusy:true},{noticeEmpty:true,unrelated:true},{noticeEmpty:true,replaceInput:true,wrongInput:true},{noticeEmpty:true,serviceError:true},{},{empty:true},{foreign:true},{mismatch:true},{duplicate:true},{company:true},
 {foreignTransit:true},{serviceError:true},{ready:true},{ready:true,wasIssued:true},
 {wasIssued:true},{foreignTransit:true,multipleIssued:true},{company:true,ready:true},{foreign:true,foreignGroup:true},
 {company:true,initialMissing:true},{company:true,replaceTable:true},{company:true,replaceInput:true},
 {company:true,replaceInput:true,wrongInput:true},{company:true,hiddenBusy:true},{company:true,cacheBusy:true},{company:true,unrelated:true},{company:true,tableAttribute:true},
 {headingLevel:3},{compactCard:true},{deepTitle:8},{statusTag:"p"},
 {headingLevel:3,compactCard:true,deepTitle:8,statusTag:"p",fourHistory:true}];
scenarios.push({directFF:true,lowerFF:true},{directFF:true,upperStatus:true},
 {ffHistory:true,lowerFF:true},{ffHistory:true,lowerFF:true,ready:true},
 {directFF:true,lowerFF:true,foreign:true},{directFF:true,lowerFF:true,mismatch:true},
 {directFF:true,lowerFF:true,missingCurrent:true},{directFF:true,lowerFF:true,conflictingCurrent:true});
(async()=>{for(const scenario of scenarios)await check(scenario);console.log(`Asgard DOM integration: ${scenarios.length} scenarios passed`);})().catch(error=>{console.error(error);process.exit(1);});
