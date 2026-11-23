import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Brain, Lightbulb, Pencil, Plus, Trash2, UserRound, X } from "lucide-react";
import { api, type Memory } from "./api";

const GROUPS: { kind: Memory["kind"]; title: string; icon: ReactNode; empty: string }[] = [
  { kind: "preference", title: "Предпочтения", icon: <UserRound size={16} />, empty: "Например: «Отвечай коротко и списком»." },
  { kind: "fact", title: "Факты о вас и работе", icon: <Brain size={16} />, empty: "Маления сама добавит сюда то, что узнает из разговоров." },
  { kind: "lesson", title: "Уроки из ваших поправок", icon: <Lightbulb size={16} />, empty: "Нажмите 👎 под ответом и напишите, как надо — появится урок." },
];

export function Memories({ connected }: { connected: boolean }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<Memory["kind"]>("fact");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setItems((await api<{ memories: Memory[] }>("GET", "/v1/assistant/memories")).memories); } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => { if (connected) void load(); }, [connected, load]);
  const add = async () => {
    if (!draft.trim()) return;
    try { await api("POST", "/v1/assistant/memories", { content: draft.trim(), kind }); setDraft(""); await load(); } catch (reason) { setError(String(reason)); }
  };
  const remove = async (id: string) => {
    try { await api("DELETE", `/v1/assistant/memories/${id}`); await load(); } catch (reason) { setError(String(reason)); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try { await api("POST", `/v1/assistant/memories/${editing.id}`, { content: editing.text }); setEditing(null); await load(); } catch (reason) { setError(String(reason)); }
  };
  return <div className="settings-stack">
    <p className="muted">Это то, что Маления знает о вас. Она пополняет память сама из разговоров и ваших оценок. Всё хранится только у вас; лишнее можно удалить.</p>
    {error ? <div className="alert error">{error}<button onClick={() => setError("")}><X size={14} /></button></div> : null}
    <form className="memory-add card" onSubmit={event => { event.preventDefault(); void add(); }}>
      <select aria-label="Тип записи" value={kind} onChange={event => setKind(event.target.value as Memory["kind"])}>
        <option value="fact">Факт</option><option value="preference">Предпочтение</option><option value="lesson">Правило</option>
      </select>
      <input aria-label="Новая запись памяти" value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} placeholder="Например: Я работаю в сортировочном центре, отвечаю за инвентаризацию" />
      <button className="primary" disabled={!draft.trim()}><Plus size={15} />Добавить</button>
    </form>
    {GROUPS.map(group => {
      const list = items.filter(item => item.kind === group.kind);
      return <section className="card" key={group.kind}>
        <h3>{group.icon}{group.title}<span className="count">{list.length}</span></h3>
        {list.length ? <ul className="memory-list">{list.map(item => <li key={item.id}>
          {editing?.id === item.id ? <form onSubmit={event => { event.preventDefault(); void saveEdit(); }}>
            <input autoFocus aria-label="Изменить запись" value={editing.text} onChange={event => setEditing({ id: item.id, text: event.target.value })} />
            <button className="primary">Сохранить</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Отмена</button>
          </form> : <>
            <span>{item.content}<small>{item.source === "auto" ? "узнал из разговора" : item.source === "feedback" ? "из вашей поправки" : item.source === "assistant" ? "запомнил по просьбе" : "добавлено вами"}{item.uses ? ` · использовано ${item.uses}` : ""}</small></span>
            <button className="icon-btn tiny" aria-label="Изменить" onClick={() => setEditing({ id: item.id, text: item.content })}><Pencil size={14} /></button>
            <button className="icon-btn tiny" aria-label="Удалить" onClick={() => void remove(item.id)}><Trash2 size={14} /></button>
          </>}
        </li>)}</ul> : <p className="muted">{group.empty}</p>}
      </section>;
    })}
  </div>;
}
