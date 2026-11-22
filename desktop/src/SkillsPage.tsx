import {useEffect,useRef,useState} from "react";
import {WorkspaceDialog} from "./WorkspaceDialog";
import {invoke} from "@tauri-apps/api/core";

type Skill={
  id:string;title:string;description:string;instructions:string;
  terms:string;status:"draft"|"approved";builtin:boolean
};
type Draft={request_id:string;title:string;description:string;instructions:string;terms:string};
const blank=():Draft=>({request_id:crypto.randomUUID(),title:"",description:"",instructions:"",terms:""});

export function SkillsPage({connected,onApply}:{connected:boolean;onApply:(item:Pick<Skill,"title"|"instructions">)=>void}){
  const [items,setItems]=useState<Skill[]>([]);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [query,setQuery]=useState("");
  const [filter,setFilter]=useState("Все");
  const [page,setPage]=useState(0);
  const [selected,setSelected]=useState("");
  const item=items.find(entry=>entry.id===selected);
  const needle=query.trim().toLocaleLowerCase("ru");
  const matches=items.filter(entry=>(filter==="Все"||(filter==="Черновики"?entry.status==="draft":!entry.builtin)) &&
    [entry.title,entry.terms,entry.instructions,entry.description].some(value=>value.toLocaleLowerCase("ru").includes(needle)));
  const last=Math.max(0,Math.ceil(matches.length/20)-1);
  const current=Math.min(page,last);
  const active=useRef(false);
  const refresh=async()=>{
    if(!connected){setItems([]);return;}
    try{
      const result=await invoke<{skills:Skill[]}>("get_skills");
      setItems(result.skills);
    }catch{setNotice("Не удалось получить навыки локального агента.");}
  };
  useEffect(()=>{void refresh();},[connected]);
  const run=async(action:"draft"|"approve"|"delete",payload:object)=>{
    if(active.current||!connected)return;
    active.current=true;setBusy(true);setNotice("");
    try{
      await invoke("skill_action",{action,payload});
      if(action==="draft"){setDraft(null);setSelected((payload as Draft).request_id);setQuery("");setFilter("Все");setPage(0);}
      setNotice(action==="draft"?"Черновик сохранён. Проверьте его и утвердите.":action==="approve"?"Инструкция активна. Откройте ассистента и опишите подходящую задачу.":"Навык удалён.");
      await refresh();
    }catch{setNotice("Не удалось сохранить изменение. Проверьте данные и попробуйте ещё раз.");}
    finally{active.current=false;setBusy(false);}
  };
  return <section className="page instructions-page" aria-label="Инструкции Малении">
    <div className="page-head"><div><h1>Инструкции</h1>
      <p>Сохраните свой порядок действий и применяйте его в чате.</p>
    </div></div>
    <div className="ai-controls"><button className="primary" disabled={!connected||busy||!!draft} onClick={()=>setDraft(blank())}>Написать инструкцию</button>
</div>
    {draft?<WorkspaceDialog title="Новая инструкция" onClose={()=>{if(!busy)setDraft(null);}}><div className="panel ai-task-review" aria-label="Новый навык">

      <p>Опишите задачу, шаги и ожидаемый результат.</p>
      <label>Название<input maxLength={80} value={draft.title} disabled={busy} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
      <label>Инструкция<textarea placeholder="Например, при разборе аномалии сначала запроси номер обращения и дату, затем составь хронологию событий." rows={5} maxLength={1600} value={draft.instructions} disabled={busy} onChange={e=>setDraft({...draft,instructions:e.target.value})}/></label>
      <div className="ai-controls">
        <button className="secondary" disabled={busy} onClick={()=>setDraft(null)}>Отмена</button>
        <button className="primary" disabled={busy||!connected||!draft.title.trim()||!draft.instructions.trim()} onClick={()=>void run("draft",{...draft,description:draft.instructions.trim().slice(0,200),terms:draft.title.trim()})}>Сохранить черновик</button>
      </div>
    </div></WorkspaceDialog>:null}
    {notice&&!item?<p className="note" role="status">{notice}</p>:null}
    <div className="library-toolbar">
      <input type="search" aria-label="Поиск инструкций" placeholder="Поиск по названию или шагам" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>
      <select aria-label="Фильтр инструкций" value={filter} onChange={e=>{setFilter(e.target.value);setPage(0);}}>{["Все","Пользовательские","Черновики"].map(label=><option key={label}>{label}</option>)}</select>
    </div>
    <div className="library-list">{matches.slice(current*20,current*20+20).map(entry=><button key={entry.id} onClick={()=>setSelected(entry.id)}>
      <strong>{entry.title}</strong><small>{entry.status==="draft"?"Черновик":entry.builtin?"Встроенная":"Активна"}</small>
    </button>)}</div>
    {matches.length?<footer className="library-pages"><span>{current*20+1}–{Math.min(matches.length,current*20+20)} из {matches.length}</span>
      {last>0?<><button className="secondary" disabled={!current} onClick={()=>setPage(current-1)}>Назад</button><button className="secondary" disabled={current===last} onClick={()=>setPage(current+1)}>Далее</button></>:null}</footer>:<p>Инструкции не найдены.</p>}
    {item?<WorkspaceDialog title={item.title} onClose={()=>setSelected("")}>
      <p className="instruction-body">{item.instructions}</p>
      <div className="ai-controls">{item.status==="approved"?<button className="primary" disabled={!connected} onClick={()=>onApply(item)}>Применить в чате</button>:
        <button className="primary" disabled={busy||!connected} onClick={()=>void run("approve",{id:item.id})}>Утвердить</button>}
        {!item.builtin?<button className="secondary" disabled={busy||!connected} onClick={()=>{if(window.confirm("Удалить инструкцию?"))void run("delete",{id:item.id});}}>Удалить</button>:null}</div>
      {notice?<p role="status">{notice}</p>:null}
    </WorkspaceDialog>:null}
  </section>;
}
