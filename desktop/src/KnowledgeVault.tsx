import { useCallback, useEffect, useState } from "react";
import { BookOpen, FolderOpen, Github, RefreshCw, Sparkles, X } from "lucide-react";
import { api } from "./api";

type VaultInfo = {
  semantic?: boolean; embed_model?: string | null;
  folder: string; repo: string; branch: string; has_token: boolean;
  documents: number; sections: number; last_sync: string | null;
  items: { path: string; title: string; type: string | null; status: string | null }[];
  status: { state: string; error: string | null };
};

export function KnowledgeVault({ connected }: { connected: boolean }) {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [repo, setRepo] = useState("");
  const [folder, setFolder] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const apply = (value: VaultInfo) => { setInfo(value); setRepo(value.repo); setFolder(value.folder); };
  const load = useCallback(async () => {
    try { apply(await api<VaultInfo>("GET", "/v1/assistant/kb")); } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => { if (connected) void load(); }, [connected, load]);
  const save = async (andSync: boolean) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const body: Record<string, string> = { repo, folder };
      if (token.trim()) body.token = token.trim();
      apply(await api<VaultInfo>("POST", "/v1/assistant/kb", body));
      setToken("");
      if (andSync) {
        const synced = await api<VaultInfo>("POST", "/v1/assistant/kb/sync");
        apply(synced);
        setNotice(`Готово: ${synced.documents} документов, ${synced.sections} разделов. Маления будет опираться на них в разговорах.`);
      }
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const forgetToken = async () => {
    try { apply(await api<VaultInfo>("POST", "/v1/assistant/kb", { token: "" })); } catch (reason) { setError(String(reason)); }
  };
  const [meaning, setMeaning] = useState("");
  const enableMeaning = async () => {
    setError(""); setMeaning("Скачиваю модель смыслового поиска…");
    try {
      await api("POST", "/v1/ai/local/pull", { model: "embeddinggemma" });
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const pull = await api<{ status: string; completed: number; total: number; error: string | null }>("GET", "/v1/ai/local/pull");
        if (pull.status === "running") { setMeaning(`Скачиваю модель смыслового поиска… ${pull.total ? Math.round(pull.completed / pull.total * 100) : 0}%`); continue; }
        if (pull.status === "failed") throw new Error(pull.error === "ollama_unavailable" ? "Сначала запустите локальный движок в «Настройки → Модели ИИ»" : (pull.error || "Не удалось скачать модель"));
        break;
      }
      setMeaning("Переиндексирую базу знаний…");
      apply(await api<VaultInfo>("POST", "/v1/assistant/kb/sync"));
      setMeaning("");
    } catch (reason) { setMeaning(""); setError(String(reason)); }
  };
  const operational = info?.items.filter(item => (item.type || "").startsWith("operational")) ?? [];
  return <div className="settings-stack">
    {info && !info.documents ? <div className="alert error">База знаний пока пуста — Маления не видит ваши инструкции и будет работать «вслепую». Подключите репозиторий ниже.</div> : null}
    <p className="muted">Подключите свою базу знаний — папку Obsidian или репозиторий GitHub с заметками в Markdown. Маления сама находит нужные разделы под задачу и понимает их как ваш опыт, а не как жёсткий алгоритм. Обновляется автоматически каждые 30 минут.</p>
    {error ? <div className="alert error">{error}<button onClick={() => setError("")}><X size={14} /></button></div> : null}
    {notice ? <div className="alert success">{notice}<button onClick={() => setNotice("")}><X size={14} /></button></div> : null}
    <form className="card kb-form" onSubmit={event => { event.preventDefault(); void save(true); }}>
      <label><span><Github size={15} /> Репозиторий GitHub</span>
        <input value={repo} onChange={event => setRepo(event.target.value)} placeholder="DoctorStrangeSH/Malenia_Knowledge_Base" aria-label="Репозиторий GitHub" /></label>
      <label><span>Токен GitHub {info?.has_token ? <em className="ok">сохранён</em> : <em>нужен для приватного репозитория</em>}</span>
        <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={info?.has_token ? "•••••••• (оставьте пустым, чтобы не менять)" : "github_pat_…"} aria-label="Токен GitHub" autoComplete="off" /></label>
      <details><summary>Как получить токен</summary><ol>
        <li>GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.</li>
        <li>Repository access: Only select repositories → выберите репозиторий базы знаний.</li>
        <li>Permissions → Repository → Contents: Read-only. Скопируйте токен и вставьте сюда.</li>
      </ol><p>Токен хранится в защищённом хранилище Windows и используется только для чтения базы.</p></details>
      <label><span><FolderOpen size={15} /> Или локальная папка (Obsidian)</span>
        <input value={folder} onChange={event => setFolder(event.target.value)} placeholder="C:\Users\…\Documents\Malenia_Knowledge_Base" aria-label="Папка базы знаний" /></label>
      <div className="row-actions">
        <button className="primary" type="submit" disabled={!connected || busy || (!repo.trim() && !folder.trim())}><RefreshCw size={14} className={busy ? "spin" : undefined} /> {busy ? "Синхронизация…" : "Сохранить и синхронизировать"}</button>
        {info?.has_token ? <button type="button" className="secondary" onClick={() => void forgetToken()}>Удалить токен</button> : null}
      </div>
    </form>
    {info ? <div className="card kb-stats">
      <div><b>{info.documents}</b><small>документов</small></div>
      <div><b>{info.sections}</b><small>разделов</small></div>
      <div><b>{operational.length}</b><small>рабочих инструкций</small></div>
      <div><b>{info.last_sync ? new Date(info.last_sync).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}</b><small>последняя синхронизация</small></div>
      {info.status.state === "failed" && info.status.error ? <p className="kb-error">{info.status.error}</p> : null}
    </div> : null}
    {info?.documents ? <div className="card kb-meaning">
      <Sparkles size={16} /><span><b>Поиск по смыслу {info.semantic ? "включён" : "выключен"}</b>
        <small>{info.semantic ? `Маления находит нужные инструкции, даже если вы пишете другими словами (${info.embed_model}).`
          : "Маленькая локальная модель (~600 МБ) поможет находить инструкции не только по словам, но и по смыслу. Работает на вашем компьютере."}</small>
        {meaning ? <small className="kb-progress">{meaning}</small> : null}</span>
      {info.semantic ? null : <button className="secondary" disabled={!connected || !!meaning} onClick={() => void enableMeaning()}>Включить</button>}
    </div> : null}
    {info?.items.length ? <div className="card"><h3><BookOpen size={16} /> Что знает Маления</h3><ul className="kb-list">
      {info.items.map(item => <li key={item.path}><b>{item.title}</b><small>{item.path}{item.status ? ` · ${item.status}` : ""}</small></li>)}
    </ul></div> : null}
  </div>;
}
