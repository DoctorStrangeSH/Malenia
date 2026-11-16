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
   const state=window.__uiMock={running:false,authorized:false,calls:[],job:null};
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
    if(command==="get_ai_status")return {available:true,models:["qwen3:8b"]};
    // Non-workflow screens can ask for optional status data.
    return {available:true,models:["qwen3:8b"],items:[],entries:[],skills:[]};
   }};
  });
  await page.goto("http://127.0.0.1:4173");
  await page.getByRole("heading",{name:"Проверка ИНВенты",exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"01-first-launch.png"),fullPage:true});
  await page.getByRole("button",{name:"Запустить Малению",exact:true}).click();
  await page.locator(".connection-banner").waitFor({state:"detached"});
  const mainNav=page.getByRole("navigation",{name:"Основные разделы"});
  assert.deepEqual(await mainNav.getByRole("button").allTextContents(),["Проверка ИНВенты","Подключения","Ассистент"]);
  await mainNav.getByRole("button",{name:"Подключения",exact:true}).click();
  await page.getByLabel("Google OAuth Desktop Client ID").fill("demo.apps.googleusercontent.com");
  await page.getByRole("button",{name:"Подключить Google",exact:true}).click();
  await page.getByText("Подключён · чтение и редактирование",{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"02-connections.png"),fullPage:true});
  await mainNav.getByRole("button",{name:"Проверка ИНВенты",exact:true}).click();
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
  await mainNav.getByRole("button",{name:"Ассистент",exact:true}).click();
  await page.getByRole("heading",{name:"Ассистент",exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"04-assistant.png"),fullPage:true});
  await mainNav.getByRole("button",{name:"Проверка ИНВенты",exact:true}).click();
  assert.match(await select.inputValue(),/gid=2$/);
  await page.getByText("Как работает проверка и дополнительные действия",{exact:true}).click();
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
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), "horizontal overflow at "+width);
   await page.screenshot({path:path.join(output,"workspace-"+width+".png"),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log("Desktop UI: first launch, Google connection, exact sheet selection, start/pause, navigation persistence, confirmed restart, completion and 3 window widths passed.");
 }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
