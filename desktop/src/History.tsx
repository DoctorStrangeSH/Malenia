import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderPlus, MoreHorizontal, Pencil, Pin, PinOff, Search, Settings2, Trash2, X } from "lucide-react";
import { api, type Conversation, type Project } from "./api";

type Props = {
  conversations: Conversation[];
  projects: Project[];
  activeProject: string | null;
  onProject: (id: string | null) => void;
  onEditProject: (project: Project | null) => void;
  current: string | null;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onChanged: () => void;
};

function group(updated: string): string {
  const date = new Date(updated);
  if (Number.isNaN(date.getTime())) return "Ранее";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (date.getTime() >= today.getTime()) return "Сегодня";
  if (date.getTime() >= today.getTime() - day) return "Вчера";
  if (date.getTime() >= today.getTime() - 7 * day) return "За неделю";
  if (date.getTime() >= today.getTime() - 30 * day) return "За месяц";
  return "Ранее";
}

/** Sidebar chat list: search, pinned chats, date groups and projects, like ChatGPT/Claude. */
export function History(props: Props) {
  const { conversations, projects, activeProject, current } = props;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Conversation[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!query.trim()) { setFound(null); return; }
    timer.current = window.setTimeout(() => {
      api<{ conversations: Conversation[] }>("GET", `/v1/assistant/conversations?q=${encodeURIComponent(query.trim())}`)
        .then(result => setFound(result.conversations)).catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [query]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const visible = useMemo(() => {
    const list = found ?? conversations;
    return activeProject ? list.filter(c => c.project_id === activeProject) : list;
  }, [found, conversations, activeProject]);
  const groups = useMemo(() => {
    const result: [string, Conversation[]][] = [];
    for (const item of visible) {
      const name = item.pinned ? "Закреплённые" : group(item.updated_at);
      const bucket = result.find(([label]) => label === name);
      if (bucket) bucket[1].push(item); else result.push([name, [item]]);
    }
    return result;
  }, [visible]);

  const update = async (id: string, body: Record<string, unknown>) => {
    try { await api("POST", `/v1/assistant/conversations/${id}`, body); props.onChanged(); } catch { /* shown on next refresh */ }
  };
  const project = projects.find(p => p.id === activeProject) ?? null;
  const encodeRename = (value: string) => value.trim();

  return <div className="history" aria-label="Диалоги">
    <div className="history-tools">
      <label className="history-search"><Search size={14} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по чатам" aria-label="Поиск по чатам" />
        {query ? <button aria-label="Очистить поиск" onClick={() => setQuery("")}><X size={12} /></button> : null}
      </label>
    </div>
    <div className="projects-bar">
      <button className={"project-chip" + (!activeProject ? " on" : "")} onClick={() => props.onProject(null)}>Все чаты</button>
      {projects.map(item => <button key={item.id} className={"project-chip" + (activeProject === item.id ? " on" : "")} title={item.instructions || item.name}
        onClick={() => props.onProject(activeProject === item.id ? null : item.id)}><Folder size={12} />{item.name}</button>)}
      <button className="project-chip add" title="Новый проект" aria-label="Новый проект" onClick={() => props.onEditProject(null)}><FolderPlus size={13} /></button>
    </div>
    {project ? <div className="project-head"><Folder size={14} /><b>{project.name}</b>
      <button className="icon-btn tiny" aria-label="Настроить проект" title="Инструкции и база знаний проекта" onClick={() => props.onEditProject(project)}><Settings2 size={13} /></button></div> : null}
    {found && !visible.length ? <small className="history-label">Ничего не найдено</small> : null}
    {groups.map(([label, items]) => <div key={label} className="history-group">
      <small className="history-label">{label}</small>
      {items.map(c => <div key={c.id} className={"history-item" + (current === c.id ? " active" : "")}>
        {renaming?.id === c.id
          ? <form className="history-rename" onSubmit={event => { event.preventDefault(); const title = encodeRename(renaming.title); if (title) void update(c.id, { title }); setRenaming(null); }}>
              <input autoFocus aria-label="Новое название" value={renaming.title} maxLength={120} onChange={event => setRenaming({ id: c.id, title: event.target.value })}
                onBlur={() => setRenaming(null)} onKeyDown={event => { if (event.key === "Escape") setRenaming(null); }} />
            </form>
          : <button onClick={() => props.onOpen(c.id)} title={c.title} onDoubleClick={() => setRenaming({ id: c.id, title: c.title })}>
              {c.pinned ? <Pin size={11} className="pin-mark" /> : null}<span>{c.title}</span>
              {c.snippet ? <small className="history-snippet">{c.snippet}</small> : null}
            </button>}
        <button className="history-more" aria-label={`Действия с диалогом ${c.title}`} onClick={event => { event.stopPropagation(); setMenu(menu === c.id ? null : c.id); }}><MoreHorizontal size={14} /></button>
        {menu === c.id ? <div className="history-menu" role="menu" onClick={event => event.stopPropagation()}>
          <button role="menuitem" onClick={() => { void update(c.id, { pinned: !c.pinned }); setMenu(null); }}>{c.pinned ? <PinOff size={13} /> : <Pin size={13} />}{c.pinned ? "Открепить" : "Закрепить"}</button>
          <button role="menuitem" onClick={() => { setRenaming({ id: c.id, title: c.title }); setMenu(null); }}><Pencil size={13} />Переименовать</button>
          {projects.length ? <div className="history-menu-sub"><small>В проект</small>
            {c.project_id ? <button role="menuitem" onClick={() => { void update(c.id, { project_id: null }); setMenu(null); }}>Без проекта</button> : null}
            {projects.filter(p => p.id !== c.project_id).map(p => <button role="menuitem" key={p.id} onClick={() => { void update(c.id, { project_id: p.id }); setMenu(null); }}><Folder size={13} />{p.name}</button>)}
          </div> : null}
          <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); props.onRemove(c.id); }}><Trash2 size={13} />Удалить</button>
        </div> : null}
      </div>)}
    </div>)}
  </div>;
}

export function ProjectDialog({ project, onClose, onSaved, onDeleted }: { project: Project | null; onClose: () => void; onSaved: (project: Project) => void; onDeleted: (id: string) => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [scope, setScope] = useState(project?.kb_scope ?? "");
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ items: { path: string }[] }>("GET", "/v1/assistant/kb").then(info => {
      setFolders(Array.from(new Set(info.items.map(item => item.path.split("/").slice(0, -1).join("/")).filter(Boolean))).sort());
    }).catch(() => undefined);
  }, []);
  const save = async () => {
    try {
      const path = project ? `/v1/assistant/projects/${project.id}` : "/v1/assistant/projects";
      const result = await api<{ project: Project }>("POST", path, { name, instructions, kb_scope: scope });
      onSaved(result.project);
    } catch (reason) { setError(String(reason)); }
  };
  const remove = async () => {
    if (!project || !window.confirm(`Удалить проект «${project.name}»? Чаты останутся, просто без проекта.`)) return;
    try { await api("DELETE", `/v1/assistant/projects/${project.id}`); onDeleted(project.id); } catch (reason) { setError(String(reason)); }
  };
  return <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal project-modal" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="modal-head"><div><small className="eyebrow">ПРОЕКТ</small><h2>{project ? "Настройки проекта" : "Новый проект"}</h2></div>
        <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><X size={16} /></button></div>
      <p className="hint">Проект собирает чаты одной темы. Маления помнит инструкции проекта в каждом его чате и в первую очередь ищет в выбранной части базы знаний.</p>
      <label>Название<input autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Например: Инвентаризация" /></label>
      <label>Инструкции проекта <small>— необязательно</small>
        <textarea rows={6} value={instructions} maxLength={8000} onChange={event => setInstructions(event.target.value)}
          placeholder="Например: Я разбираю ИНВенту. Отвечай коротко, по номеру заказа сразу говори маршрут и что проверить в Asgard." /></label>
      <label>Раздел базы знаний <small>— необязательно</small>
        <select value={scope} onChange={event => setScope(event.target.value)}>
          <option value="">Вся база знаний</option>
          {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
        </select></label>
      {error ? <p className="bad-text">{error}</p> : null}
      <div className="modal-foot">{project ? <button type="button" className="danger" onClick={() => void remove()}><Trash2 size={14} />Удалить</button> : <span />}
        <button type="submit" className="primary" disabled={!name.trim()}>Сохранить</button></div>
    </form>
  </div>;
}
