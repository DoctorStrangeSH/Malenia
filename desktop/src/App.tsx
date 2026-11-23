import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {WorkspaceDialog} from "./WorkspaceDialog";
import {KnowledgePage} from "./KnowledgePage";
import {InventaRun, type RunState} from "./inventaRun";
import {SkillsPage} from "./SkillsPage";
import { BrowserSetup } from "./BrowserSetup";
import { ToolCatalog } from "./ToolCatalog";
import { Chat } from "./Chat";
import { AiSettings } from "./AiSettings";
import { ServerSettings } from "./ServerSettings";
import { Memories } from "./Memories";
import { OwnModel } from "./OwnModel";
import { Logo } from "./Logo";
import { api, type Conversation } from "./api";
import { OrderCheckPage } from "./OrderCheckPage";
import { invoke } from "@tauri-apps/api/core";
import { PermissionsPage, type PermissionRequest, type PermissionDecision } from "./PermissionsPage";
import {
  Activity, ArrowUpRight, BrainCircuit, Check, CircleHelp,
  Clock3, Cpu, Database, Globe2, ListTodo,
  LoaderCircle, LockKeyhole, MemoryStick, MessageSquare, Play, Plus, Plug,
  RefreshCw, Search, Settings2, ShieldCheck, Trash2, X
} from "lucide-react";

type Task = { id:string; title:string; description:string; status:"pending"|"cancelled"; created_at:string; };
type EventItem = { id:number; event_type:string; message:string; created_at:string; };
type BrowserTab = { id:string; url:string; title:string; shared_at:string; };
type BrowserAudit = { checked_at:string; total:number; summary:{found:number;in_progress:number;manual_review:number}; read_only:true; source:"browser_tables" };
type BrowserAuditJob = { job_id:string; status:"pending"|"running"|"completed"|"failed"|"expired"; created_at:string; updated_at:string; current_role:"inventory"|"datalens"|"asgard"|null; completed_sources:number; attention_sources:number; failed_role:"inventory"|"datalens"|"asgard"|null };
type Resources = { total_memory_bytes:number; available_memory_bytes:number; used_memory_percent:number; logical_processors:number; cpu_usage_percent:number; mode:"normal"|"economy"|"emergency"; recommended_parallel_jobs:number; };
type Dashboard = { running:boolean; resources:Resources; tasks:Task[]; events:EventItem[]; browser_tabs:BrowserTab[]; browser_audit:BrowserAudit|null; browser_audit_job:BrowserAuditJob|null; permissions:PermissionRequest[]; };
type Page = "overview"|"tasks"|"browser"|"sources"|"tools"|"connections"|"orders"|"ai"|"settings"|"permissions"|"knowledge"|"skills"|"memory"|"models"|"server"|"ownmodel";

const bytes=(n:number)=>n ? (n/1024/1024/1024).toFixed(1)+" ГБ" : "—";
const time=(v:string)=>{try{return new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit"}).format(new Date(v));}catch{return v;}};

export default function App(){
  const [runState,setRunState]=useState<RunState>({phase:"idle",processed:0,total:0,source:"",message:"Выбери лист и начни разбор."});
  const [inventaRun]=useState(()=>new InventaRun(invoke,setRunState));
  useEffect(()=>()=>inventaRun.dispose(),[inventaRun]);
  const [page,setPage]=useState<Page>("ai");
  const [conversationId,setConversationId]=useState<string|null>(null);
  const [autoStart,setAutoStart]=useState(0);
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const [instruction,setInstruction]=useState<{title:string;instructions:string}|null>(null);
  const [selectedSheet,setSelectedSheet]=useState("");
  const [showHelp,setShowHelp]=useState(false);
  const [data,setData]=useState<Dashboard|null>(null);
  const [busy,setBusy]=useState(false);
  const permissionDecisionBusy=useRef(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [title,setTitle]=useState("");
  const [description,setDescription]=useState("");
  const [filter,setFilter]=useState("");
  const [composer,setComposer]=useState(false);
  const connected=!!data?.running;
  const loadConversations=useCallback(async()=>{try{setConversations((await api<{conversations:Conversation[]}>("GET","/v1/assistant/conversations")).conversations);}catch{/* agent starting */}},[]);
  useEffect(()=>{if(connected)void loadConversations();},[connected,loadConversations]);

  const refresh=useCallback(async()=>{
    try{const result=await invoke<Dashboard>("get_dashboard");setData(result);setError("");}
    catch(reason){setData(null);if(String(reason)!=="Агент не запущен")setError(String(reason));}
  },[]);
  useEffect(()=>{void refresh();const id=window.setInterval(()=>void refresh(),3000);return()=>window.clearInterval(id);},[refresh]);

  const runAgent=async()=>{setBusy(true);setError("");try{const message=await invoke<string>("start_agent");setNotice(message);await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const stopAgent=async()=>{setBusy(true);try{setNotice(await invoke<string>("stop_agent"));setData(null);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const addTask=async()=>{if(!title.trim())return;setBusy(true);try{await invoke("create_task",{title:title.trim(),description});setTitle("");setDescription("");setComposer(false);setNotice("План сохранён");await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const cancelTask=async(id:string)=>{try{await invoke("cancel_task",{taskId:id});setNotice("План убран из списка");await refresh();}catch(e){setError(String(e));}};
  const decidePermission=async(request:PermissionRequest,decision:PermissionDecision)=>{
    if(permissionDecisionBusy.current)return;
    permissionDecisionBusy.current=true;
    setBusy(true);setError("");let failure="";
    try{await invoke("decide_permission",{permissionId:request.id,binding:request.binding,decision});setNotice("Решение сохранено. Браузерные действия пока не подключены.");}
    catch(e){failure=String(e);}
    finally{await refresh();if(failure)setError(failure);permissionDecisionBusy.current=false;setBusy(false);}
  };
  const tasks=useMemo(()=>{const all=data?.tasks??[];return filter?all.filter(t=>t.title.toLowerCase().includes(filter.toLowerCase())):all;},[data,filter]);
  const mode=data?.resources.mode;
  const modeLabel=mode==="normal"?"Обычный":mode==="economy"?"Экономия":mode==="emergency"?"Защита":"—";

  const settingsPages:Page[]=["settings","models","server","connections","permissions","browser","overview","tasks"];
  const memoryPages:Page[]=["memory","knowledge","skills","ownmodel"];
  const pendingPermissions=data?.permissions.filter(p=>p.status==="pending").length;
  const openChat=(id:string|null)=>{setConversationId(id);setPage("ai");};
  const removeConversation=async(id:string)=>{if(!window.confirm("Удалить этот диалог?"))return;try{await api("DELETE",`/v1/assistant/conversations/${id}`);if(conversationId===id)setConversationId(null);await loadConversations();}catch(e){setError(String(e));}};

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><Logo size={30}/><b>Маления</b></div>
      <button className="new-chat" onClick={()=>openChat(null)}><Plus size={16}/>Новый чат</button>
      <nav aria-label="Основные разделы">
        <Nav icon={<MessageSquare/>} label="Чат" active={page==="ai"} onClick={()=>setPage("ai")}/>
        <Nav icon={<Database/>} label="Инструменты" active={["tools","sources","orders"].includes(page)} onClick={()=>setPage("tools")}/>
        <Nav icon={<BrainCircuit/>} label="Память" active={memoryPages.includes(page)} onClick={()=>setPage("memory")}/>
        <Nav icon={<Settings2/>} label="Настройки" active={settingsPages.includes(page)} count={pendingPermissions} onClick={()=>setPage(pendingPermissions?"permissions":"models")}/>
      </nav>
      {["waiting","running","pausing","paused"].includes(runState.phase)?<button className="run-shortcut" onClick={()=>setPage("sources")}><Activity size={17}/><span><b>{runState.phase==="paused"?"Проверка на паузе":"Проверка инвентаризации"}</b><small>{runState.processed} из {runState.total||"…"} обработано</small></span></button>:null}
      <div className="history" aria-label="Диалоги">
        {conversations.length?<small className="history-label">Диалоги</small>:null}
        {conversations.map(c=><div key={c.id} className={"history-item"+(page==="ai"&&conversationId===c.id?" active":"")}>
          <button onClick={()=>openChat(c.id)} title={c.title}>{c.title}</button>
          <button className="history-remove" aria-label={`Удалить диалог ${c.title}`} onClick={()=>void removeConversation(c.id)}><Trash2 size={13}/></button>
        </div>)}
      </div>
      <div className="side-foot">
        <span className={"dot"+(connected?" on":"")}/>{connected?"Маления работает":"Запуск…"}
        <button className="icon-btn tiny" title="С чего начать?" aria-label="Открыть справку" onClick={()=>setShowHelp(true)}><CircleHelp size={15}/></button>
        <span className="side-version">0.12.1</span>
      </div>
    </aside>

    <main className={"main"+(page==="ai"?" main-chat":"")}>
      <div className={page==="ai"?"content content-chat":"content"}>
        {!connected&&<div className="connection-banner"><div><b>Маления готова к запуску</b><p>Нажмите «Запустить Малению», чтобы открыть чат и инструменты.</p></div><button className="primary" onClick={()=>void runAgent()} disabled={busy}>{busy?<LoaderCircle className="spin" size={16}/>:<Play size={16}/>}Запустить Малению</button></div>}
        {memoryPages.includes(page)?<><div className="page-title"><h1>Память</h1><p>Что Маления знает о вас, чему вы её научили и ваша собственная модель.</p></div><nav className="section-tabs" aria-label="Знания и навыки"><button aria-current={page==="memory"?"page":undefined} onClick={()=>setPage("memory")}>О вас</button><button aria-current={page==="knowledge"?"page":undefined} onClick={()=>setPage("knowledge")}>Документы</button><button aria-current={page==="skills"?"page":undefined} onClick={()=>setPage("skills")}>Инструкции</button><button aria-current={page==="ownmodel"?"page":undefined} onClick={()=>setPage("ownmodel")}>Своя модель</button></nav></>:null}
        {settingsPages.includes(page)?<><div className="page-title"><h1>Настройки</h1></div><nav className="section-tabs" aria-label="Разделы настроек"><button aria-current={page==="models"?"page":undefined} onClick={()=>setPage("models")}>Модели ИИ</button><button aria-current={page==="server"?"page":undefined} onClick={()=>setPage("server")}>Сервер</button><button aria-current={page==="connections"?"page":undefined} onClick={()=>setPage("connections")}>Подключения</button><button aria-current={page==="permissions"?"page":undefined} onClick={()=>setPage("permissions")}>Разрешения{pendingPermissions?` (${pendingPermissions})`:""}</button><button aria-current={["settings","browser","overview","tasks"].includes(page)?"page":undefined} onClick={()=>setPage("settings")}>Система</button></nav></>:null}
        {["sources","orders"].includes(page)?<button className="tool-back" onClick={()=>setPage("tools")}>← Все инструменты</button>:null}
        {page==="tools"?<ToolCatalog onOpen={setPage}/>:null}
        {error&&<div className="alert error"><X size={15}/>{error}<button onClick={()=>setError("")}><X size={14}/></button></div>}
        {notice&&<div className="alert success"><Check size={15}/>{notice}<button onClick={()=>setNotice("")}><X size={14}/></button></div>}

        {page==="overview"&&<>
          <section className="metrics">
            <Metric icon={<MemoryStick/>} label="Оперативная память" value={data?data.resources.used_memory_percent.toFixed(1)+"%":"—"} detail={data?bytes(data.resources.available_memory_bytes)+" свободно из "+bytes(data.resources.total_memory_bytes):"Данные пока недоступны"} tone={mode==="emergency"?"red":mode==="economy"?"amber":"green"} progress={data?.resources.used_memory_percent}/>
            <Metric icon={<Cpu/>} label="Загрузка процессора" value={data?data.resources.cpu_usage_percent.toFixed(1)+"%":"—"} detail={data?data.resources.logical_processors+" логических процессоров":"Данные пока недоступны"} tone="violet" progress={data?.resources.cpu_usage_percent}/>
            <Metric icon={<ListTodo/>} label="Сохранённые планы" value={String(data?.tasks.filter(t=>t.status==="pending").length??0)} detail="Сохранены, но ещё не выполняются автоматически" tone="blue"/>
            <Metric icon={<Activity/>} label="Режим ресурсов" value={modeLabel} detail={data?"Параллельность: "+data.resources.recommended_parallel_jobs:"Данные пока недоступны"} tone={mode==="emergency"?"red":mode==="economy"?"amber":"green"}/>
          </section>
          <section className="lower">
            <div className="panel"><div className="panel-head"><div><h3>Последние планы</h3><p>Локальная очередь Malenia</p></div><button className="link-btn" onClick={()=>setPage("tasks")}>Все планы <ArrowUpRight size={14}/></button></div><TaskList tasks={(data?.tasks??[]).slice(0,5)} onCancel={cancelTask}/></div>
            <div className="panel"><div className="panel-head"><div><h3>Активность</h3><p>Последние события агента</p></div></div>{data?.events.length?<div className="events">{data.events.slice(0,6).map(e=><div className="event" key={e.id}><span><Check size={12}/></span><div><b>{e.message}</b><small>{time(e.created_at)}</small></div></div>)}</div>:<Empty title="Нет событий" text="Здесь появится история действий."/>}</div>
          </section>
        </>}

        {page==="tasks"&&<section className="page"><div className="page-head"><div><h2>Сохранённые планы</h2><p>Сохраняйте планы и полезные ответы, чтобы вернуться к ним позже.</p></div><button className="primary" onClick={()=>setComposer(true)} disabled={!connected}><Plus size={15}/>Новый план</button></div><div className="toolbar"><div className="search"><Search size={15}/><input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Поиск по планам..."/></div><small>{tasks.length} записей</small></div><div className="panel"><TaskList tasks={tasks} onCancel={cancelTask}/></div><div className="note"><CircleHelp size={15}/>Сейчас задания сохраняются локально в SQLite, но не запускаются автоматически. Выполнение будет подключено отдельным этапом.</div></section>}

        {page==="permissions"&&<PermissionsPage requests={data?.permissions??[]} connected={connected} busy={busy} onDecide={decidePermission}/>}
        {page==="browser"&&<BrowserPage tabs={data?.browser_tabs??[]} audit={data?.browser_audit??null} job={data?.browser_audit_job??null} connected={connected} onRequested={()=>void refresh()} onOpenSources={()=>setPage("sources")}/>}
        {(page==="sources"||page==="connections")&&<SourcesPage autoStart={page==="sources"?autoStart:0} onAutoStarted={started=>{setAutoStart(0);if(!started)setNotice("Маления открыла инвентаризацию. Выберите лист и нажмите «Начать проверку» — запустить автоматически не удалось.");}} mode={page==="sources"?"work":"connections"} selectedSheet={selectedSheet} onSelectSheet={setSelectedSheet} onOpenConnections={()=>setPage("connections")} tabs={data?.browser_tabs??[]} connected={connected} runState={runState} runner={inventaRun}/>} 
        {page==="orders"&&<OrderCheckPage connected={connected}/>}
        {page==="memory"&&<Memories connected={connected}/>}
        {page==="ownmodel"&&<OwnModel connected={connected} onOpenModels={()=>setPage("models")}/>}
        {page==="models"&&<AiSettings connected={connected} onOpenOwnModel={()=>setPage("ownmodel")}/>}
        {page==="server"&&<ServerSettings connected={connected} onOpenModels={()=>setPage("models")}/>}
        {page==="knowledge"&&<KnowledgePage connected={connected}/>}
        {page==="skills"&&<SkillsPage connected={connected} onApply={item=>{setInstruction(item);setPage("ai");}}/>}
        <div hidden={page!=="ai"} className="chat-host"><Chat connected={connected} conversationId={conversationId} onConversation={setConversationId} onChanged={()=>void loadConversations()} instruction={instruction} onClearInstruction={()=>setInstruction(null)} onOpenSettings={()=>setPage("models")} onOpenTools={()=>setPage("tools")} onUiAction={action=>{if(action.result?.ui==="open_inventory"){setPage("sources");if(action.result.start)setAutoStart(Date.now());}}}/></div>
        {page==="settings"&&<section className="page"><div className="settings-links"><button className="secondary" onClick={()=>setPage("browser")}><Globe2 size={16}/>Диагностика расширения</button><button className="secondary" onClick={()=>setPage("tasks")}>Сохранённые планы</button><button className="secondary" onClick={()=>setPage("overview")}>Состояние системы</button></div><details className="advanced-tools"><summary>Дополнительные инструменты</summary><p>Сохранённые планы и сведения о работе приложения. Рабочие действия собраны в разделе «Инструменты».</p></details><div className="settings-grid"><Setting icon={<Database/>} title="Локальный агент" text="Ядро Малении на этом компьютере: хранит диалоги, память и подключения. Модели настраиваются во вкладке «Модели ИИ»." value={connected?"Запущен":"Остановлен"} action={connected?<button className="secondary" onClick={()=>{if(window.confirm("Перезапустить Малению? Это займёт несколько секунд."))void (async()=>{await stopAgent();await runAgent();})();}} disabled={busy}><RefreshCw size={14}/> Перезапустить</button>:<button className="primary" onClick={runAgent} disabled={busy}><Play size={14}/> Запустить</button>}/><Setting icon={<ShieldCheck/>} title="Приватность" text="Диалоги, память и ключи хранятся на этом компьютере. В режиме «Приватно» запросы не уходят в облако. Важные изменения в рабочих системах требуют подтверждения." value="Локально"/><Setting icon={<Globe2/>} title="Рабочая среда" text="Подключите Google и передайте рабочие страницы через расширение во вкладке «Подключения»." value="Browser Bridge"/></div></section>}
      </div>
    </main>

    {showHelp&&<div className="backdrop" onClick={()=>setShowHelp(false)}><section className="modal quick-help" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape")setShowHelp(false);if(e.key==="Tab"){const buttons=e.currentTarget.querySelectorAll<HTMLButtonElement>("button");const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}}><div className="modal-head"><div><div className="eyebrow">ПЕРВЫЕ ШАГИ</div><h2 id="help-title">Освоимся в Малении</h2></div><button autoFocus className="icon-btn" aria-label="Закрыть справку" onClick={()=>setShowHelp(false)}><X size={18}/></button></div><ol className="help-steps"><li><b>Расскажите ассистенту о задаче</b><p>Маления помогает с любыми задачами: тексты, планы, расчёты, поиск в интернете. Для умных ответов подключите бесплатную облачную модель в «Настройки → Модели ИИ».</p></li><li><b>Выберите подходящий инструмент</b><p>В разделе «Инструменты» собраны рабочие действия. Для инвентаризации выберите лист и запустите проверку.</p></li><li><b>Подключите нужные источники</b><p>Каждый инструмент подскажет, какой доступ ему нужен. Маления учится на ваших оценках 👍/👎 и запоминает важное о вас — всё это видно в разделе «Память».</p></li></ol><button className="primary" onClick={()=>{setShowHelp(false);setPage("tools");}}>Посмотреть инструменты <ArrowUpRight size={16}/></button></section></div>}
    {composer&&<div className="backdrop" onClick={()=>setComposer(false)}><div className="modal" onClick={e=>e.stopPropagation()}><div className="modal-head"><div><div className="eyebrow">НОВЫЙ ПЛАН</div><h2>Что хотите сохранить?</h2></div><button className="icon-btn" onClick={()=>setComposer(false)}><X size={17}/></button></div><label>Название плана<input autoFocus maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Например: проверить новые заказы"/></label><label>Описание <small>необязательно</small><textarea rows={4} maxLength={2000} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Дополнительные детали..."/></label><div className="modal-foot"><span><LockKeyhole size={12}/>Сохранится локально</span><button className="primary" disabled={!connected||!title.trim()||busy} onClick={addTask}>{busy?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>}Сохранить план</button></div><p className="hint">Пока задача только сохраняется в очереди — автоматическое выполнение ещё не подключено.</p></div></div>}
  </div>;
}

function Nav({icon,label,active,count,onClick}:{icon:ReactNode;label:string;active:boolean;count?:number;onClick:()=>void}){return <button className={"nav-item "+(active?"active":"")} aria-current={active?"page":undefined} onClick={onClick}><span>{icon}</span>{label}{!!count&&<em>{count}</em>}</button>;}
function Metric({icon,label,value,detail,tone,progress}:{icon:ReactNode;label:string;value:string;detail:string;tone:string;progress?:number}){return <div className="metric"><div className={"metric-icon "+tone}>{icon}</div><small>{label}</small><strong>{value}</strong><p>{detail}</p>{progress!==undefined&&<div className="progress"><i className={tone} style={{width:Math.max(0,Math.min(progress,100))+"%"}}/></div>}</div>;}
function TaskList({tasks,onCancel}:{tasks:Task[];onCancel:(id:string)=>void}){if(!tasks.length)return <Empty title="Планов пока нет" text="Сохраните план здесь или из ответа ассистента."/>;return <div className="task-list">{tasks.map(t=><div className="task-row" key={t.id}><span className={"task-state "+t.status}>{t.status==="pending"?<Clock3 size={14}/>:<X size={14}/>}</span><div className="task-copy"><b>{t.title}</b><small>{t.description||"Без дополнительного описания"} · {time(t.created_at)}</small></div><span className={"task-badge "+t.status}>{t.status==="pending"?"Сохранён":"Убран"}</span>{t.status==="pending"&&<button className="icon-btn tiny" title="Убрать из планов" onClick={()=>onCancel(t.id)}><X size={14}/></button>}</div>)}</div>;}
function Empty({title,text}:{title:string;text:string}){return <div className="empty"><div><ListTodo size={18}/></div><b>{title}</b><p>{text}</p></div>;}
function BrowserPage({tabs,audit,job,connected,onRequested,onOpenSources}:{tabs:BrowserTab[];audit:BrowserAudit|null;job:BrowserAuditJob|null;connected:boolean;onRequested:()=>void;onOpenSources:()=>void}){
  const [sending,setSending]=useState(false);
  const [requestError,setRequestError]=useState("");
  const [removingTab,setRemovingTab]=useState<string|null>(null);
  const removeTab=async(tab:BrowserTab)=>{
    if(!connected || removingTab || !window.confirm(`Убрать «${tab.title}» из списка Малении? Вкладка в браузере останется открытой.`))return;
    setRemovingTab(tab.id);setRequestError("");
    try{
      await invoke("remove_shared_browser_tab",{tabId:tab.id});
      onRequested();
    }catch(error){setRequestError(`Не удалось убрать вкладку из Малении: ${String(error)}`);}
    finally{setRemovingTab(null);}
  };
  const requestAudit=async()=>{
    if(sending || !connected || job?.status==="pending" || job?.status==="running")return;
    setSending(true);setRequestError("");
    try{
      await invoke("request_browser_audit");
      onRequested();
    }catch(error){
      setRequestError(String(error).includes("browser_audit_already_active")?
        "Проверка уже ожидает выполнения.":
        "Не удалось добавить проверку. Проверьте подключение локального агента.");
    }finally{setSending(false);}
  };
  const statusLabel=job?.status==="pending"?"Ожидает Browser Bridge (проверка команд примерно раз в минуту)":
    job?.status==="running"?"Выполняется в браузере":
    job?.status==="completed"?"Последняя задача завершена":
    job?.status==="failed"?"Проверка завершилась с ошибкой":
    job?.status==="expired"?"Расширение не ответило вовремя":"Задачи пока нет";
  return <section className="page">
    <div className="page-head"><div><div className="eyebrow">BROWSER BRIDGE · PREVIEW</div><h1>Браузер</h1><p>Browser Bridge: ручная передача любых HTTPS-вкладок. Автоматическая сверка инвентаризации пока использует три специализированные роли: Инвентаризация, DataLens и Asgard.</p></div><span className="browser-state"><i className={connected?"":"idle"}/>{connected?"Агент подключён":"Сначала запустите агента"}</span></div>
    <div className="panel inventa-workbench"><h2>Разбор всего листа</h2><p>Откройте «Инструменты» → «Инвентаризация» и выберите лист. Там доступны запуск и пауза, общий прогресс и результаты.</p><button className="primary" onClick={onOpenSources}>Открыть инвентаризацию</button></div>
    <details><summary>Доступ к сайтам и ограничения</summary>    <div className="browser-safety"><div><ShieldCheck size={19}/></div><section><b>Приватность по умолчанию</b><p>Расширение не читает cookies, пароли и историю браузера. Для разрешённого поиска оно может вводить грузоместо только в строго распознанное поле. Отдельная команда может считать ограниченный видимый текст страницы, а автоматический обход — последовательно прочитать три явно разрешённых домена. Тексты не сохраняются. Диагностика показывает состояние расширения и источников. Рабочий разбор и запись результатов запускаются в инструменте «Инвентаризация».</p></section></div></details>
    <details><summary>Диагностика источников</summary>
    <div className="panel browser-panel" data-testid="browser-audit-runner">
      <div className="panel-head"><div><h3>Проверить заказы автоматически</h3><p>Только чтение. Расширение использует ранее настроенные сайты и разрешения.</p></div>
        <button className="primary" disabled={!connected||sending||job?.status==="pending"||job?.status==="running"} onClick={()=>void requestAudit()}>
          <Play size={15}/>{sending?"Отправляем…":"Запустить проверку"}</button>
      </div>
      <p role="status">{statusLabel}</p>
      <p>Настройка в Яндекс Браузере: открой расширение Browser Bridge 1.6.31 или новее → «Найти открытые вкладки» → выбери инвентаризацию, DataLens «Заказы» и Asgard «Обратный поток» → «Передать выбранные вкладки и разрешить чтение». Для проверки всей инвентаризации открой «Инструменты» → «Инвентаризация» → выбери лист → «Начать проверку».</p>
      {job?.status==="running" || job?.status==="completed" || job?.status==="failed" ?
        <div className="batch-summary" data-testid="browser-audit-progress">
          <span>Обработано источников: <b>{job.completed_sources}/3</b></span>
          <span>Требуют внимания: <b>{job.attention_sources}</b></span>
          {job.current_role?<span>Последний этап: <b>{{inventory:"Инвентаризация",datalens:"DataLens",asgard:"Asgard"}[job.current_role]}</b></span>:null}
          {job.failed_role?<span>Ошибка при чтении: <b>{{inventory:"Инвентаризация",datalens:"DataLens",asgard:"Asgard"}[job.failed_role]}</b></span>:null}
        </div>:null}
      {requestError?<p className="alert error" role="alert">{requestError}</p>:null}
      <p className="note">Для выполнения требуется запущенный браузер с установленным Browser Bridge, предварительно настроенными тремя HTTPS-страницами и разрешённым доступом. При отсутствии расширения команда истечёт; повторный запуск возможен вручную.</p>
    </div>
    </details>
    <div className="panel browser-panel" data-testid="browser-audit-summary">
      <div className="panel-head"><div><h3>Последняя автоматическая сверка</h3><p>Только итоговые числа · без грузомест и содержимого сайтов</p></div></div>
      {audit ? <div className="batch-summary" role="status">
        <span>Найдено: <b>{audit.summary.found}</b></span>
        <span>В работе: <b>{audit.summary.in_progress}</b></span>
        <span>Ручная проверка: <b>{audit.summary.manual_review}</b></span>
        <span>Обработано: <b>{audit.total}</b></span>
        <small>Последний результат: {new Date(audit.checked_at).toLocaleString("ru-RU")} · только предложения, не изменения статусов</small>
      </div> : <p className="note">Пока нет завершённой сверки. Передача вкладки сама по себе не запускает проверку заказа. Для неё нужны три специализированных источника и подтверждённые результаты чтения.</p>}
    </div>
    <div className="panel browser-panel"><div className="panel-head"><div><h3>Вкладки, которыми вы поделились</h3><p>Последние 20 вкладок, которыми ты поделился. Это не ограничение количества вкладок или сайтов.</p></div><span className="live">{tabs.length} SHARED</span></div>
      {tabs.length?<div className="browser-tab-list">{tabs.map(tab=><article className="browser-tab" key={tab.id}><span className="browser-tab-icon"><Globe2 size={16}/></span><div className="browser-tab-copy"><b>{tab.title}</b><a href={tab.url} target="_blank" rel="noreferrer">{tab.url}</a><small>Передано вручную · {time(tab.shared_at)}</small></div><button className="browser-tab-remove" type="button" title="Убрать запись из Малении, не закрывая вкладку браузера" disabled={!connected||!!removingTab} onClick={()=>void removeTab(tab)}>{removingTab===tab.id?"Убираем…":"Убрать из Малении"}</button></article>)}</div>:<Empty title="Пока нет переданных вкладок" text="Установите Malenia Browser Bridge, затем откройте нужную страницу и нажмите кнопку расширения «Поделиться вкладкой»."/>}
    </div>
    <div className="note"><CircleHelp size={15}/>Native Messaging работает только после регистрации расширения и хоста. Поддержка проверяется на установленной версии Яндекс Браузера; автоматический доступ к вкладкам не включён.</div>
  </section>;
}

type GoogleSheetsStatus = {connected:boolean;status:string;error:string|null;client_id?:string};

function SourcesPage({mode,selectedSheet,onSelectSheet,onOpenConnections,tabs,connected,runState,runner,autoStart=0,onAutoStarted}:{autoStart?:number;onAutoStarted?:(started:boolean)=>void;mode:"work"|"connections";selectedSheet:string;onSelectSheet:(url:string)=>void;onOpenConnections:()=>void;tabs:BrowserTab[];connected:boolean;runState:RunState;runner:InventaRun}){
  const [clarifiedYear,setClarifiedYear]=useState("");
  const [sheetOptions,setSheetOptions]=useState<{url:string;title:string}[]>([]);
  const [loadingSheets,setLoadingSheets]=useState(false);
  const [service,setService]=useState("");
  const sheetTabs=tabs.filter(tab=>/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(tab.url));
  const sheetUrl=selectedSheet||sheetTabs[0]?.url||"";
  const runBusy=["waiting","running","pausing"].includes(runState.phase);
  const selectedTitle=sheetOptions.find(sheet=>sheet.url===sheetUrl)?.title||"";
  const sheetDayMonth=selectedTitle.match(/(?:^|\s)(\d{1,2})[./-](\d{1,2})(?!\d)/);
  const needsYear=runState.source===sheetUrl&&runState.message.includes("sheet_date_not_verified");
  const clarifiedDate=needsYear&&/^\d{4}$/.test(clarifiedYear)&&sheetDayMonth?
    `${clarifiedYear}-${sheetDayMonth[2].padStart(2,"0")}-${sheetDayMonth[1].padStart(2,"0")}`:undefined;
  const [clientId,setClientId]=useState("");
  const [clientSecret,setClientSecret]=useState("");
  const [sheetsStatus,setSheetsStatus]=useState<GoogleSheetsStatus>({connected:false,status:"not_connected",error:null});
  const [busy,setBusy]=useState(false);
  const [sheetError,setSheetError]=useState("");
  const [sheetNotice,setSheetNotice]=useState("");
  const [inventaReport,setInventaReport]=useState<any|null>(null);

  const refreshSheetsStatus=useCallback(async()=>{
    if(!connected){setSheetsStatus({connected:false,status:"agent_stopped",error:null});return;}
    try{
      const result=await invoke<GoogleSheetsStatus>("get_google_sheets_status");
      setSheetsStatus(result);
      if(result.client_id)setClientId(current=>current||result.client_id||"");
    }catch(error){setSheetsStatus({connected:false,status:"unavailable",error:String(error)});}
  },[connected]);

  useEffect(()=>{
    void refreshSheetsStatus();
    if(!connected)return;
    const id=window.setInterval(()=>void refreshSheetsStatus(),2000);
    return()=>window.clearInterval(id);
  },[connected,refreshSheetsStatus]);

  const connectSheets=async()=>{
    setBusy(true);setSheetError("");setSheetNotice("");
    try{
      const message=await invoke<string>("connect_google_sheets",{clientId:clientId.trim(),clientSecret:clientSecret.trim()||null});
      setClientSecret("");
      setSheetNotice(message);
      await refreshSheetsStatus();
    }catch(error){setSheetError(String(error));}
    finally{setBusy(false);}
  };
  const disconnectSheets=async()=>{
    setBusy(true);setSheetError("");setSheetNotice("");
    try{
      await invoke("disconnect_google_sheets");
      setSheetsStatus({connected:false,status:"not_connected",error:null});
      setSheetNotice("Локальные данные авторизации удалены. При необходимости отзовите разрешение также в Google Account.");
    }catch(error){setSheetError(String(error));}
    finally{setBusy(false);}
  };
  const analyzeActiveInventa=async()=>{
    setBusy(true);setSheetError("");setSheetNotice("");setInventaReport(null);
    const activeTab=sheetUrl?{url:sheetUrl}:undefined;
    if(!activeTab){setSheetError("Не найдена переданная вкладка Google Sheets. Открой инвентаризацию в браузере и поделись этой вкладкой через Browser Bridge.");setBusy(false);return;}
    const spreadsheetUrl=activeTab.url;
    try{
      const result=await invoke<any>("analyze_active_inventa",{spreadsheetUrl});
      setInventaReport(result);
      setSheetNotice("Инвентаризация прочитана. Анализ выполнен без изменения исходной таблицы.");
    }catch(error){setSheetError(String(error));}
    finally{setBusy(false);}
  };
  const sheetsAuthorized=sheetsStatus.status==="authorized"||sheetsStatus.connected;
  // Started by Malenia from the chat: begin as soon as the sheet and access are ready.
  const autoStartDone=useRef(0);
  useEffect(()=>{
    if(!autoStart||mode!=="work"||autoStartDone.current===autoStart)return;
    const ready=connected&&sheetsAuthorized&&!!sheetUrl&&!runBusy&&!needsYear&&!loadingSheets;
    if(ready){autoStartDone.current=autoStart;void runner.start(sheetUrl,clarifiedDate);onAutoStarted?.(true);return;}
    const timer=window.setTimeout(()=>{if(autoStartDone.current!==autoStart){autoStartDone.current=autoStart;onAutoStarted?.(false);}},8000);
    return()=>window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[autoStart,connected,sheetsAuthorized,sheetUrl,runBusy,needsYear,loadingSheets]);
  useEffect(()=>{
    if(!sheetUrl||!sheetsAuthorized||!connected)return;
    let cancelled=false;setLoadingSheets(true);
    invoke<any>("analyze_active_inventa",{spreadsheetUrl:sheetUrl}).then(report=>{
      if(cancelled)return;
      setInventaReport(report);setSheetError("");
      const base=sheetUrl.split("?")[0];
      setSheetOptions((report.source.available_sheets||[]).map((sheet:{id:number;title:string})=>({url:base+"?gid="+sheet.id,title:sheet.title})));
    }).catch(error=>{if(!cancelled)setSheetError(String(error));}).finally(()=>{if(!cancelled)setLoadingSheets(false);});
    return()=>{cancelled=true;};
  },[sheetUrl,sheetsAuthorized,connected]);
  const statusLabel=sheetsAuthorized?"Подключён · чтение и редактирование":
    sheetsStatus.status==="authorizing"?"Ожидает подтверждения в браузере":
    sheetsStatus.status==="reauthorization_required"?"Требуется повторная авторизация":
    sheetsStatus.status==="denied"?"Доступ не предоставлен":
    sheetsStatus.status==="expired"?"Время авторизации истекло":
    sheetsStatus.status==="error"?"Ошибка авторизации":
    sheetsStatus.status==="unavailable"?"Хранилище секретов недоступно":
    sheetsStatus.status==="agent_stopped"?"Запустите локальный агент":"Не подключён";

  return <section className="page sources-page">
    <div className="page-head"><div><h1>{mode==="work"?"Инвентаризация":"Подключения"}</h1><p>{mode==="work"?"Выберите лист Google Sheets для проверки.":"Здесь настраиваются Google Sheets и доступ к вкладкам браузера."}</p></div>{mode==="work"?<button className="secondary" onClick={onOpenConnections}><Plug size={16}/>Подключения</button>:null}</div>
    {sheetError?<p className="alert error" role="alert">{sheetError}</p>:null}
    {sheetNotice?<p className="alert success" role="status">{sheetNotice}</p>:null}
    {mode==="work"?<article className="panel inventa-workbench" aria-label="Инвентаризация">
      <div className="workbench-heading"><div><h2>Проверка листа</h2><p>Сначала DataLens, затем Asgard для остальных заказов.</p></div><span className={"workbench-status "+(runBusy?"working":"")}>{runBusy?"В процессе":runState.phase==="completed"?"Завершено":"Инвентаризация"}</span></div>
      <label>Таблица и лист<select value={sheetUrl} disabled={runBusy} onChange={e=>{onSelectSheet(e.target.value);setClarifiedYear("");}}>
        {!sheetTabs.length?<option value="">Передай вкладку инвентаризации через расширение</option>:null}
        {sheetTabs.filter(tab=>!sheetOptions.some(sheet=>sheet.url===tab.url)).map(tab=><option value={tab.url} key={tab.id}>{tab.title} · открытый лист</option>)}
        {sheetOptions.map(sheet=><option value={sheet.url} key={sheet.url}>{sheet.title}</option>)}
      </select></label>
      {inventaReport?.analysis.sheet_inventory_date?<p>Дата листа: <b>{inventaReport.analysis.sheet_inventory_date}</b></p>:null}
      {!sheetsAuthorized?<div className="work-empty"><Plug size={24}/><b>Подключите Google Sheets</b><p>Это нужно для чтения инвентаризации и сохранения результатов.</p><button className="secondary" onClick={onOpenConnections}>Настроить подключение <ArrowUpRight size={15}/></button></div>:!sheetUrl?<div className="work-empty"><Globe2 size={24}/><b>Передайте таблицу из браузера</b><p>Откройте инвентаризацию → расширение Малении → «Использовать эту вкладку».</p></div>:null}
      {needsYear?<label>Уточни только год для листа «{selectedTitle}»<input type="number" min="1900" max="9999" value={clarifiedYear} onChange={e=>setClarifiedYear(e.target.value)}/><small>День и месяц уже взяты из названия. В данных листа не нашлось однозначного года.</small></label>:null}
      {loadingSheets?<p role="status">Загружаю названия листов и дату…</p>:null}
      <div className="google-actions">
        <button className="primary" disabled={!connected||!sheetsAuthorized||!sheetUrl||loadingSheets||runBusy||(needsYear&&!clarifiedDate)} onClick={()=>void runner.start(sheetUrl,clarifiedDate)}><Play size={16}/>{runState.phase==="paused"||runState.phase==="error"?"Продолжить проверку":"Начать проверку"}</button>
        
        {runBusy?<button className="secondary" disabled={runState.phase==="pausing"} onClick={()=>runner.pause()}>{runState.phase==="pausing"?"Ставим на паузу…":"Приостановить"}</button>:null}
        
      </div>
      <div className={"inventa-progress phase-"+runState.phase} role="status" aria-live="polite"><b>{runState.phase==="error"?"Проверка остановлена":runState.phase==="pausing"?"Останавливаю поиск":runState.phase==="paused"?"Проверка на паузе":runState.phase==="completed"?"Проверка завершена":runState.total?`${runState.processed} из ${runState.total} заказов проверено`:runBusy?"Подготавливаю проверку":!sheetsAuthorized?"Нужно подключить Google":!sheetUrl?"Передайте таблицу из браузера":"Готова начать"}</b><p>{runState.message}</p>
        {runState.total>0?<progress aria-label="Прогресс разбора" max={runState.total} value={runState.processed}/>:null}
      </div>
      <div className="settings-links"><button className="secondary" disabled={!connected||!sheetsAuthorized||!sheetUrl||loadingSheets||runBusy||(needsYear&&!clarifiedDate)} onClick={()=>{if(window.confirm("Начать проверку выбранного листа заново? Сохранённая позиция будет сброшена."))void runner.restart(sheetUrl,clarifiedDate);}}>Начать заново</button></div>
    </article>:null}
    {mode==="connections"?<div className="source-settings">
    <div className="service-list">
      <button onClick={()=>setService("Браузер")}><Globe2/><strong>Яндекс Браузер</strong><small>Расширение</small><ArrowUpRight/></button>
      <button onClick={()=>setService("Google Sheets")}><Database/><strong>Google Sheets</strong><small>{statusLabel}</small><ArrowUpRight/></button>
      {["DataLens","Asgard"].map(name=>{
        const host=name==="DataLens"?"datalens.yandex-team.ru":"asgard.market.yandex-team.ru";
        const shared=tabs.some(tab=>{try{return new URL(tab.url).hostname===host;}catch{return false;}});
        return <button key={name} onClick={()=>setService(name)}><Plug/><strong>{name}</strong><small>{shared?"Вкладка передана · требуется тест":"Ожидает вкладку"}</small><ArrowUpRight/></button>;
      })}
    </div>
    {service?<WorkspaceDialog title={service} onClose={()=>setService("")}>
      {service==="Браузер"?<BrowserSetup/>:service==="Google Sheets"?<>
      <article className="panel source-card google-source-card">
        <div className="source-card-top"><span className="source-icon sheets"><Database size={19}/></span><span className={"source-state "+(sheetsAuthorized?"ready":"pending")}>{statusLabel}</span></div>
        <h2>Google Sheets · Инвентаризация</h2>
        <p>Отдельная авторизация Malenia. Запрашивается доступ на чтение и редактирование Google Sheets. Результаты проверки можно записывать в исходную таблицу. При запросе подтвердите доступ на редактирование.</p>
        {!connected?<p className="source-help">Нажмите «Запустить Малению» вверху экрана.</p>:null}
        {!sheetsAuthorized?
          <div className="google-connect-form">
            <label>Google OAuth Desktop Client ID
              <input value={clientId} onChange={e=>setClientId(e.target.value)} maxLength={300} autoComplete="off" spellCheck={false} placeholder="…apps.googleusercontent.com" disabled={!connected||busy}/>
            </label>
            <label>Client Secret <span className="source-optional">необязательно</span>
              <input type="password" value={clientSecret} onChange={e=>setClientSecret(e.target.value)} maxLength={512} autoComplete="off" spellCheck={false} placeholder="Оставь пустым, если Google не требует" disabled={!connected||busy}/>
            </label>
            <button className="primary source-action" disabled={!connected||busy||!clientId.trim()||sheetsStatus.status==="authorizing"} onClick={()=>void connectSheets()}>{busy?"Подключаем…":"Подключить Google"}</button>
            <details className="oauth-help"><summary>Где взять Client ID?</summary><p>Создай OAuth client типа Desktop и включи Google Sheets API. Если consent screen в режиме Testing, добавь свой аккаунт в Test users. Desktop-приложения являются public clients: Google указывает, что Client Secret необязателен и не может считаться защищённым секретом. Если конкретный проект требует его при обмене токена, введи его здесь — он сохранится только в Windows Credential Manager. Не отправляй его в чат. Важно: если внешний OAuth-проект оставить в режиме Testing, refresh token для этого scope истечёт через 7 дней. Для постоянной работы не оставляй внешний проект в Testing; для личного использования Google допускает исключение из полной проверки, но может показывать предупреждение о непроверенном приложении.</p></details>
          </div>:
          <>
          <div className="google-read-form">
            <div className="google-actions">
              <button className="primary" disabled={busy} onClick={()=>void analyzeActiveInventa()}>{busy?"Анализируем…":"Обновить сведения о таблице"}</button>
              <button className="secondary" disabled={busy} onClick={()=>void disconnectSheets()}>Отключить Google</button>
            </div>
            <small>Маления ищет Google Sheets во вкладках, которыми ты поделился через Browser Bridge. Если gid отсутствует, она определяет лист по заголовкам инвентаризации. Подключение Google разрешает чтение и редактирование. Сам анализ таблицы не изменяет ячейки.</small>
          </div>
          {inventaReport?<div className="sheet-preview">
            <div className="sheet-preview-head"><b>{inventaReport.source.spreadsheet_title} · {inventaReport.source.sheet_title}</b><small>{inventaReport.analysis.rows_analyzed} строк</small></div>
            <div className="sources-notice"><b>Статусы</b> {Object.entries(inventaReport.analysis.status_counts).map(([k,v])=>k+": "+v).join(" · ")}</div>
            <p><b>Дубли ID:</b> {inventaReport.analysis.duplicate_order_ids.length} · <b>Ошибочные даты:</b> {inventaReport.analysis.invalid_date_rows.length} · <b>Ошибочные суммы:</b> {inventaReport.analysis.invalid_cost_rows.length} · <b>Без тикета:</b> {inventaReport.analysis.missing_ticket_rows.length}</p>
            <p><b>Дата листа для проверки:</b> {inventaReport.analysis.sheet_inventory_date||"не подтверждена"} · <b>Не заполнено:</b> {Object.entries(inventaReport.analysis.missing_required).map(([k,v])=>k+": "+v).join(" · ")||"нет"}</p>

          </div>:null}
          </> }
        {sheetsStatus.status==="authorizing"?<p className="source-help">Завершите подтверждение в системном браузере. Malenia не увидит пароль Google.</p>:null}
        {sheetsStatus.status==="denied"?<p className="source-help">Разрешение не было предоставлено. Можно повторить подключение.</p>:null}
        {sheetsStatus.status==="expired"?<p className="source-help">Окно авторизации не получило ответ вовремя. Начните подключение заново.</p>:null}
        {sheetsStatus.status==="error"?<p className="source-help">Google не подтвердил нужный scope или OAuth завершился ошибкой. Проверьте OAuth consent screen и Client ID.</p>:null}
      </article>
      </>:<p>Откройте {service==="DataLens"?"дашборд «Заказы» в DataLens":"страницу «Обратный поток» в Asgard"}. В расширении Малении выберите «Использовать эту вкладку».</p>}
    </WorkspaceDialog>:null}
    </div>:null}
  </section>;
}

function Setting({icon,title,text,value,action}:{icon:ReactNode;title:string;text:string;value:string;action?:ReactNode}){return <div className="panel setting"><div className="setting-icon">{icon}</div><h3>{title}</h3><p>{text}</p><div className="setting-bottom"><b>{value}</b>{action}</div></div>;}
