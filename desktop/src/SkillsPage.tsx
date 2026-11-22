import {useEffect,useRef,useState} from "react";
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
      if(action==="draft")setDraft(null);
      setNotice(action==="draft"?"Черновик сохранён. Проверьте его и утвердите.":action==="approve"?"Инструкция активна. Откройте ассистента и опишите подходящую задачу.":"Навык удалён.");
      await refresh();
    }catch{setNotice("Не удалось сохранить изменение. Проверьте данные и попробуйте ещё раз.");}
    finally{active.current=false;setBusy(false);}
  };
  return <section className="page" aria-label="Навыки Malenia">
    <div className="page-head"><div><h1>Инструкции</h1>
      <p>Опишите, как вы решаете задачу. После утверждения Маления сможет применять ваши шаги в подходящих ответах.</p>
    </div></div>
    <div className="ai-controls"><button className="primary" disabled={!connected||busy||!!draft} onClick={()=>setDraft(blank())}>Написать инструкцию</button>
</div>
    {draft?<div className="panel ai-task-review" aria-label="Новый навык">
      <h2>Новая инструкция</h2>
      <p>Укажите, когда применять правило, какие шаги выполнить и что считать результатом.</p>
      <label>Название<input maxLength={80} value={draft.title} disabled={busy} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
      <label>Инструкция<textarea placeholder="Например, при разборе аномалии сначала запроси номер обращения и дату, затем составь хронологию событий." rows={5} maxLength={1600} value={draft.instructions} disabled={busy} onChange={e=>setDraft({...draft,instructions:e.target.value})}/></label>
      <div className="ai-controls">
        <button className="secondary" disabled={busy} onClick={()=>setDraft(null)}>Отмена</button>
        <button className="primary" disabled={busy||!connected||!draft.title.trim()||!draft.instructions.trim()} onClick={()=>void run("draft",{...draft,description:draft.instructions.trim().slice(0,200),terms:draft.title.trim()})}>Сохранить черновик</button>
      </div>
    </div>:null}
    {notice?<p className="note" role="status">{notice}</p>:null}
    <div className="panel browser-panel">
      <div className="panel-head"><div><h3>Сохранённые инструкции</h3><p>{items.filter(x=>x.status==="approved").length} активных · {items.filter(x=>x.status==="draft").length} черновиков</p></div></div>
      {items.length?items.map(item=><article className="browser-tab" key={item.id}>
        <div className="browser-tab-copy">
          <b>{item.title} · {item.status==="draft"?"Черновик":"Активен"}{item.builtin?" · Встроенный":""}</b>
          <p>{item.description}</p>
          <details><summary>Инструкции и ключевые слова</summary><p>{item.instructions}</p><small>{item.terms}</small></details>
          {item.status==="approved"?<button className="secondary" onClick={()=>onApply({title:item.title,instructions:item.instructions})}>Применить в чате</button>:null}
          {!item.builtin?<div className="ai-controls">
            {item.status==="draft"?<button className="primary" disabled={busy} onClick={()=>void run("approve",{id:item.id})}>Утвердить</button>:null}
            <button className="secondary" disabled={busy} onClick={()=>void run("delete",{id:item.id})}>Удалить</button>
          </div>:null}
        </div>
      </article>):<p className="note">Пока нет инструкций.</p>}
    </div>
  </section>;
}
