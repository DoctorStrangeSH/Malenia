// Exercise the built desktop UI in Chromium with a mocked native boundary.
// No corporate sites, OAuth credentials or real sheet writes are involved.
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const path=require("node:path");
const fs=require("node:fs");
const {chromium}=require("playwright");
const server=spawn(process.execPath,[path.resolve("desktop/node_modules/vite/bin/vite.js"),"preview","--host","127.0.0.1","--port","4173","--strictPort"],{cwd:path.resolve("desktop"),stdio:"pipe"});
const output=path.resolve(process.env.RUNNER_TEMP||".","malenia-ui");
fs.mkdirSync(output,{recursive:true});
(async()=>{
 let browser;
 try{
  for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:4173")).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.addInitScript(()=>{
   const base="https://docs.google.com/spreadsheets/d/demo/edit";
   const state=window.__uiMock={running:false,authorized:false,extensionId:null,skills:Array.from({length:1000},(_,i)=>({id:"rule-"+i,title:"Правило "+i,terms:"",description:"",instructions:"Шаг "+i,status:"approved",builtin:false})),calls:[],job:null};
   window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
    state.calls.push({command,args});
    if(command==="start_agent"){state.running=true;return "Маления запущена";}
    if(command==="get_dashboard"){
     if(!state.running)throw "Агент не запущен";
     return {running:true,resources:{used_memory_percent:25,available_memory_bytes:8000000000,total_memory_bytes:16000000000,cpu_usage_percent:1,logical_processors:8,mode:"normal",recommended_parallel_jobs:1},tasks:[],events:[],permissions:[],browser_audit:null,browser_audit_job:state.job,browser_tabs:[
      {id:"sheet",url:base+"?gid=1",title:"ИНВента",shared_at:"2026-11-16"},
      {id:"dl",url:"https://datalens.yandex-team.ru/demo",title:"Заказы",shared_at:"2026-11-16"},
      {id:"as",url:"https://asgard.market.yandex-team.ru/returnBox/search",title:"Asgard",shared_at:"2026-11-16"}]};
    }
    if(command==="get_google_sheets_status")return {connected:state.authorized,status:state.authorized?"authorized":"not_connected",error:null};
    if(command==="connect_google_sheets"){state.authorized=true;return "Google подключён";}
    if(command==="analyze_active_inventa")return {source:{spreadsheet_title:"ИНВента",sheet_title:args.spreadsheetUrl.endsWith("2")?"16.11.2026":"15.11.2026",available_sheets:[{id:1,title:"15.11.2026"},{id:2,title:"16.11.2026"}]},analysis:{sheet_inventory_date:args.spreadsheetUrl.endsWith("2")?"2026-11-16":"2026-11-15",rows_analyzed:40,status_counts:{"Найден":20},duplicate_order_ids:[],invalid_date_rows:[],invalid_cost_rows:[],missing_ticket_rows:[],missing_required:{}}};
    if(command==="check_inventa_order_batch"){state.job={job_id:"ui-job",status:"pending"};return {job:state.job,queued_orders:20,eligible_orders:20,batch_start:0,batch_end:20,remaining_orders:0};}
    if(command==="cancel_browser_audit"){state.job=null;return {};}
    if(command==="reset_inventa_order_batch")return {};
    if(command==="get_browser_bridge_setup")return {available:true,saved_extension_id:state.extensionId};
    if(command==="open_browser_extension_folder")return null;
    if(command==="register_browser_bridge"){state.extensionId=args.extensionId;return null;}
    if(command==="local_ai_engine")return {installed:false,running:false,status:""};
    if(command==="agent_api"){
     const p=args.path;state.conversations=state.conversations||{};
     if(p==="/v1/ai/providers")return {mode:"auto",learning:true,auto_web:true,local_model:null,order:["gemini","ollama"],providers:[{id:"gemini",name:"Google Gemini",kind:"cloud",hint:"",key_url:"",base_url:"",has_key:true,enabled:true,model:null}]};
     if(p==="/v1/assistant/conversations")return {conversations:Object.values(state.conversations).map(c=>({id:c.id,title:c.title,created_at:"2026-11-23",updated_at:"2026-11-23"}))};
     if(p.startsWith("/v1/assistant/conversations/")){const c=state.conversations[p.split("/").pop()];return {conversation:{...c,messages:[...c.messages]}};}
     if(p==="/v1/assistant/chat"){
      const body=args.body;const id=body.conversation_id||"00000000-0000-4000-8000-000000000001";
      const c=state.conversations[id]||(state.conversations[id]={id,title:body.message.slice(0,60),messages:[]});
      const n=c.messages.length;
      const user={id:"u"+n,conversation_id:id,role:"user",content:body.message,created_at:"",provider:null,model:null,feedback:0,meta:{}};
      const answer={id:"a"+n,conversation_id:id,role:"assistant",content:(body.instruction||"").includes("Сначала запроси номер обращения")?"Пришлите номер обращения.":"Вот план работы по вашей задаче.",created_at:"",provider:"gemini",model:"gemini-flash",feedback:0,meta:{}};
      c.messages.push(user,answer);
      return {conversation_id:id,user_message:user,message:answer,provider:"gemini",model:"gemini-flash"};
     }
     if(p.startsWith("/v1/ai/hardware"))return {hardware:{ram_gb:16,gpu:null,vram_gb:0,cpu_threads:8,os:"Windows",recommendation:{tier:"cpu-16",label:"16 ГБ",models:["qwen3.5:4b"],note:""}},installed:[],ollama_running:false,pull:{status:"idle",model:null,completed:0,total:0,error:null}};
     if(p==="/v1/assistant/memories")return {memories:[]};
     if(p==="/v1/ai/detect-key")return {provider:"gigachat"};
     if(p==="/v1/assistant/workspace")return {path:"C:\\Users\\demo\\Documents\\Маления"};
     if(p==="/v1/assistant/training")return {stats:{conversations:1,answers:2,liked:1,disliked:0,memories:0,lessons:0,skills:0,ready_for_finetune:false},personal_model:"sherlock-personal"};
     if(p==="/v1/server")return {enabled:false,running:false,port:8766,token:"mln-test",error:null,requests_served:0,addresses:[]};
     return {};
    }
    if(command==="get_skills")return {skills:state.skills};
    if(command==="skill_action"){
      if(args.action==="draft")state.skills.push({...args.payload,id:args.payload.request_id,status:"draft"});
      if(args.action==="approve")state.skills.find(x=>x.id===args.payload.id).status="approved";
      return {};
    }
    if(command==="get_knowledge")return {records:[]};
    // Non-workflow screens can ask for optional status data.
    return {available:true,models:["qwen3:8b"],items:[],entries:[],skills:[]};
   }};
  });
  await page.goto("http://127.0.0.1:4173");
  await page.getByRole("heading",{name:"Ассистент",exact:true}).waitFor();
  assert.equal(await page.getByLabel("Таблица и лист").count(),0);
  await page.screenshot({path:path.join(output,"01-first-launch.png"),fullPage:true});
  await page.getByRole("button",{name:"Запустить Малению",exact:true}).click();
  await page.locator(".connection-banner").waitFor({state:"detached"});
  const mainNav=page.getByRole("navigation",{name:"Основные разделы"});
  assert.deepEqual(await mainNav.getByRole("button").allTextContents(),["Чат","Инструменты","Память","Настройки"]);
  const openSkills=async()=>{await mainNav.getByRole("button",{name:"Память",exact:true}).click();await page.getByRole("navigation",{name:"Знания и навыки"}).getByRole("button",{name:"Инструкции",exact:true}).click();};
  await page.getByLabel("Сообщение",{exact:true}).fill("Помоги составить план рабочего дня");
  await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await page.getByText("Вот план работы по вашей задаче.",{exact:true}).waitFor();
  await page.getByLabel("Сообщение",{exact:true}).fill("Несохранённый черновик");
  const openInventory=async()=>{
    await mainNav.getByRole("button",{name:"Инструменты",exact:true}).click();
    await page.getByRole("button",{name:/^Инвентаризация/}).click();
  };
  await mainNav.getByRole("button",{name:"Инструменты",exact:true}).click();
  assert.equal(await page.locator(".tool-row").count(),1);
  await openSkills();
  await page.getByText("1–20 из 1000").waitFor();
  await page.getByRole("button",{name:"Далее",exact:true}).click();
  await page.getByText("21–40 из 1000").waitFor();
  await page.getByLabel("Поиск инструкций").fill("Шаг 997");
  await page.getByRole("button",{name:/Правило 997/}).click();
  await page.getByRole("dialog").getByText("Шаг 997").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Написать инструкцию"}).click();
  await page.getByLabel("Название",{exact:true}).fill("Аномалии");
  await page.getByLabel("Инструкция",{exact:true}).fill("Сначала запроси номер обращения.");
  await page.getByRole("button",{name:"Сохранить черновик"}).click();
  await page.getByText("Черновик сохранён. Проверьте его и утвердите.").waitFor();
  const saved=await page.evaluate(()=>window.__uiMock.calls.find(x=>x.command==="skill_action").args.payload);
  await page.getByRole("button",{name:"Утвердить",exact:true}).click();
  await page.getByRole("button",{name:"Применить в чате"}).click();
  await page.locator(".instruction-chip").getByText("Аномалии").waitFor();
  assert.equal(await page.getByLabel("Сообщение",{exact:true}).inputValue(),"Несохранённый черновик");
  await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await page.getByText("Пришлите номер обращения.",{exact:true}).waitFor();
  assert.match(await page.evaluate(()=>window.__uiMock.calls.filter(x=>x.command==="agent_api"&&x.args.path==="/v1/assistant/chat").at(-1).args.body.instruction),/Сначала запроси номер обращения/);
  await page.getByRole("button",{name:"Убрать",exact:true}).click();
  await page.getByLabel("Сообщение",{exact:true}).fill("Несохранённый черновик");
  assert.equal(saved.terms,"Аномалии");
  assert.equal(saved.instructions,"Сначала запроси номер обращения.");
  await mainNav.getByRole("button",{name:"Инструменты",exact:true}).click();
  await page.screenshot({path:path.join(output,"02-tools.png"),fullPage:true});
  await mainNav.getByRole("button",{name:"Настройки",exact:true}).click();
  await page.getByRole("heading",{name:"Как Маления выбирает модель"}).waitFor();
  await page.screenshot({path:path.join(output,"02-models.png"),fullPage:true});
  await page.getByRole("navigation",{name:"Разделы настроек"}).getByRole("button",{name:"Сервер",exact:true}).click();
  await page.getByText("Сервер выключен").waitFor();
  await page.getByRole("navigation",{name:"Разделы настроек"}).getByRole("button",{name:"Подключения",exact:true}).click();
  await page.getByRole("button",{name:/Яндекс Браузер/}).click();
  await page.getByRole("button",{name:"Открыть папку расширения",exact:true}).click();
  await page.getByLabel(/^ID расширения/).fill("wrong-id");
  assert.equal(await page.getByRole("button",{name:"Настроить связь с браузером",exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.__uiMock.calls.filter(x=>x.command==="register_browser_bridge").length),0);
  await page.getByLabel(/^ID расширения/).fill("a".repeat(32));
  await page.getByRole("button",{name:"Настроить связь с браузером",exact:true}).click();
  await page.getByText(/Регистрация завершена/).waitFor();
  assert.equal(await page.evaluate(()=>window.__uiMock.calls.filter(x=>x.command==="register_browser_bridge").length),1);
  await page.getByLabel(/^ID расширения/).fill("b".repeat(32));
  page.once("dialog",dialog=>dialog.dismiss());
  await page.getByRole("button",{name:"Настроить связь с браузером",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__uiMock.calls.filter(x=>x.command==="register_browser_bridge").length),1);
  await page.getByLabel(/^ID расширения/).fill("a".repeat(32));
  await page.getByRole("button",{name:"Закрыть окно"}).click();
  await page.getByRole("button",{name:/^Google Sheets/}).click();
  await page.getByLabel("Google OAuth Desktop Client ID").fill("demo.apps.googleusercontent.com");
  await page.getByRole("button",{name:"Подключить Google",exact:true}).click();
  await page.getByRole("dialog").getByText("Подключён · чтение и редактирование",{exact:true}).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({path:path.join(output,"02-connections.png"),fullPage:true});
  await openInventory();
  const select=page.getByLabel("Таблица и лист");
  await select.locator("option",{hasText:"16.11.2026"}).waitFor({state:"attached"});
  await select.selectOption({label:"16.11.2026"});
  await page.getByText("2026-11-16",{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"03-workspace.png"),fullPage:true});
  assert.equal(await page.getByRole("button",{name:"Начать проверку",exact:true}).count(),1);
  await page.getByRole("button",{name:"Начать проверку",exact:true}).click();
  await page.getByRole("button",{name:"Приостановить",exact:true}).waitFor();
  assert.equal(await select.isDisabled(),true);
  await page.getByRole("button",{name:"Приостановить",exact:true}).click();
  await page.getByText("Проверка на паузе",{exact:true}).first().waitFor();
  const cancel=await page.evaluate(()=>window.__uiMock.calls.find(x=>x.command==="cancel_browser_audit"));
  assert.deepEqual(cancel.args,{jobId:"ui-job"});
  await mainNav.getByRole("button",{name:"Чат",exact:true}).click();
  await page.getByRole("heading",{name:"Ассистент",exact:true}).waitFor();
  await page.getByText("Вот план работы по вашей задаче.",{exact:true}).waitFor();
  assert.equal(await page.getByLabel("Сообщение",{exact:true}).inputValue(),"Несохранённый черновик");
  await page.screenshot({path:path.join(output,"04-assistant.png"),fullPage:true});
  await openInventory();
  assert.match(await select.inputValue(),/gid=2$/);
  assert.equal(await page.getByText(/Как работает проверка и дополнительные действия/).count(),0);
  page.once("dialog",dialog=>dialog.dismiss());
  await page.getByRole("button",{name:"Начать заново",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__uiMock.calls.filter(x=>x.command==="reset_inventa_order_batch").length),0);
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Начать заново",exact:true}).click();
  await page.getByRole("button",{name:"Приостановить",exact:true}).waitFor();
  await page.evaluate(()=>{window.__uiMock.job.status="completed";});
  await page.getByText("Проверка завершена",{exact:true}).waitFor();
  const queued=await page.evaluate(()=>window.__uiMock.calls.filter(x=>x.command==="check_inventa_order_batch"));
  assert.equal(queued.length,2);
  assert.ok(queued.every(x=>x.args.spreadsheetUrl.endsWith("gid=2")));
  for(const width of [1440,1080,850]){
   await page.setViewportSize({width,height:900});
   await mainNav.getByRole("button",{name:"Память",exact:true}).click();
   await page.getByRole("navigation",{name:"Знания и навыки"}).getByRole("button",{name:"Своя модель",exact:true}).click();
   await page.getByText("Чему Маления уже научилась").waitFor();
   for(const destination of ["Чат","Инструменты","Память","Настройки"]){
    await mainNav.getByRole("button",{name:destination,exact:true}).click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), destination+" horizontal overflow at "+width);
    await page.screenshot({path:path.join(output,destination+"-"+width+".png"),fullPage:true});
   }
   await openInventory();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), "inventory overflow at "+width);
  }
  assert.deepEqual(errors,[]);
  console.log("Desktop UI: local browser setup and explicit replacement confirmation, assistant-first launch, persistent conversation and draft, tool search and categories, connections, inventory as a selected tool, exact sheet selection, pause/restart/completion and four destinations at three widths passed.");
 }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
