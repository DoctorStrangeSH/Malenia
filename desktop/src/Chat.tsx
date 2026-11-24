import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp, Bookmark, Brain, Check, Copy, FileText, GraduationCap, Globe2, Image as ImageIcon, LoaderCircle, Lock,
  Mail, ListChecks, Lightbulb, Paperclip, Play, ThumbsDown, ThumbsUp, Wrench, X,
} from "lucide-react";
import { api, providerLabel, type AgentAction, type Attachment, type ChatMessage, type ChatReply, type ConversationDetail, type ProvidersInfo } from "./api";
import { Markdown } from "./Markdown";
import { Logo } from "./Logo";

type Props = {
  connected: boolean;
  conversationId: string | null;
  onConversation: (id: string | null) => void;
  onChanged: () => void;
  instruction: { title: string; instructions: string } | null;
  onClearInstruction: () => void;
  onOpenSettings: () => void;
  onOpenTools: () => void;
  onUiAction: (action: AgentAction) => void;
  visible?: boolean;
};

const MAX_FILES = 6;
const MAX_TOTAL = 12 * 1024 * 1024;
const ACCEPT = "image/*,.txt,.md,.csv,.tsv,.json,.xlsx,.xlsm,.docx,.pptx,.pdf,.log,.xml,.html";

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Downscale a photo in the browser: smaller uploads, faster models, and a thumbnail for the chat. */
async function scaleImage(dataUrl: string, max: number, quality: number): Promise<string> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Не удалось открыть изображение")); image.src = dataUrl; });
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return dataUrl;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function readFile(file: File): Promise<Attachment> {
  const name = file.name || "фото.png";
  const original = await readDataUrl(file);
  if (file.type.startsWith("image/") && !/svg/.test(file.type)) {
    try {
      const full = await scaleImage(original, 1600, 0.88);
      const preview = await scaleImage(original, 360, 0.8);
      return { name: name.replace(/\.(png|webp|gif|bmp|heic)$/i, ".jpg"), mime: "image/jpeg", size: Math.round(full.length * 0.75),
        data: full.split(",", 2)[1] ?? "", preview };
    } catch { /* fall back to the original file */ }
  }
  return { name, mime: file.type, size: file.size, data: original.split(",", 2)[1] ?? "" };
}

const SUGGESTIONS = [
  { icon: <GraduationCap size={18} />, title: "Научить навыку", text: "Запомни, как я делаю ежедневный отчёт: " },
  { icon: <ListChecks size={18} />, title: "Спланировать день", text: "Помоги составить план рабочего дня с приоритетами" },
  { icon: <Mail size={18} />, title: "Написать письмо", text: "Напиши вежливое письмо коллеге с просьбой прислать отчёт до пятницы" },
  { icon: <Lightbulb size={18} />, title: "Объяснить простыми словами", text: "Объясни простыми словами, как работает " },
  { icon: <Globe2 size={18} />, title: "Найти в интернете", text: "Найди свежие новости о " },
];

const openLink = (url: string) => { void invoke("open_search_source", { url }).catch(() => undefined); };

export function Chat(props: Props) {
  const { connected, conversationId, onConversation, onChanged, instruction, onClearInstruction } = props;
  const visible = props.visible ?? true;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [privateMode, setPrivateMode] = useState(false);
  const [useWeb, setUseWeb] = useState(true);
  const [providers, setProviders] = useState<ProvidersInfo | null>(null);
  const [pendingText, setPendingText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<Attachment[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = async (list: FileList | File[]) => {
    const incoming = Array.from(list).slice(0, MAX_FILES - files.length);
    if (!incoming.length) { if (list.length) setError(`Можно приложить до ${MAX_FILES} файлов`); return; }
    // Show the chips immediately with a spinner, like ChatGPT/Claude, then fill them in.
    const placeholders = incoming.map((file, index) => ({ name: file.name || "фото", mime: file.type, size: file.size, data: "", loading: true, key: Date.now() + "-" + index }));
    setFiles(current => [...current, ...placeholders]);
    await Promise.all(incoming.map(async (file, index) => {
      const key = placeholders[index].key;
      try {
        const read = await readFile(file);
        setFiles(current => {
          const next = current.map(item => (item as Attachment & { key?: string }).key === key ? { ...read, key } : item);
          if (next.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL) { setError("Вложения больше 12 МБ"); return current.filter(item => (item as Attachment & { key?: string }).key !== key); }
          return next;
        });
      } catch (reason) {
        setError(String(reason));
        setFiles(current => current.filter(item => (item as Attachment & { key?: string }).key !== key));
      }
    }));
  };
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const key = conversationId ?? "new";
  const draft = drafts[key] ?? "";
  const setDraft = (value: string) => setDrafts(current => ({ ...current, [key]: value }));

  const [localReady, setLocalReady] = useState(true);
  const loadProviders = useCallback(async () => {
    try { setProviders(await api<ProvidersInfo>("GET", "/v1/ai/providers")); } catch { /* agent starting */ }
    try {
      const hw = await api<{ installed: string[]; ollama_running: boolean }>("GET", "/v1/ai/hardware");
      setLocalReady(hw.ollama_running && hw.installed.length > 0);
    } catch { /* optional */ }
  }, []);
  useEffect(() => { if (connected && visible) void loadProviders(); }, [connected, visible, loadProviders]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => void loadProviders();
    window.addEventListener("malenia:models-changed", refresh);
    return () => window.removeEventListener("malenia:models-changed", refresh);
  }, [loadProviders]);

  useEffect(() => {
    let active = true;
    setError("");
    if (!conversationId || !connected) { setMessages([]); return; }
    api<{ conversation: ConversationDetail }>("GET", `/v1/assistant/conversations/${conversationId}`)
      .then(result => { if (active) setMessages(result.conversation.messages); })
      .catch(() => { if (active) setMessages([]); });
    return () => { active = false; };
  }, [conversationId, connected]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  const cloudReady = !!providers?.providers.some(p => p.enabled);
  const send = async (textOverride?: string) => {
    const sending = files;
    const text = (textOverride ?? draft).trim() || (sending.length ? "Посмотри вложения" : "");
    if (!text || busy || !connected || sending.some(f => f.loading)) return;
    setBusy(true); setError(""); setPendingText(text); setPendingFiles(sending); setDraft(""); setFiles([]);
    try {
      const reply = await api<ChatReply>("POST", "/v1/assistant/chat", {
        message: text, conversation_id: conversationId, private: privateMode, use_web: useWeb,
        instruction: instruction ? `${instruction.title}\n${instruction.instructions}` : null,
        attachments: sending.map(({ name, mime, data, preview }) => ({ name, mime, data, preview })),
      });
      setMessages(current => [...current, reply.user_message, reply.message]);
      for (const action of reply.message.meta?.actions ?? []) if (action.status === "ui") props.onUiAction(action);
      if (reply.conversation_id !== conversationId) {
        setDrafts(current => ({ ...current, [reply.conversation_id]: "" }));
        onConversation(reply.conversation_id);
      }
      onChanged();
    } catch (reason) {
      setError(String(reason)); setDraft(text); setFiles(sending);
    } finally { setBusy(false); setPendingText(""); setPendingFiles([]); inputRef.current?.focus(); }
  };

  const rate = async (message: ChatMessage, rating: number, comment?: string) => {
    const next = message.feedback === rating && !comment ? 0 : rating;
    try {
      await api("POST", "/v1/assistant/feedback", { message_id: message.id, rating: next, comment: comment ?? null });
      setMessages(current => current.map(m => m.id === message.id ? { ...m, feedback: next } : m));
    } catch (reason) { setError(String(reason)); }
  };

  const decide = async (action: AgentAction, approve: boolean) => {
    try {
      const result = await api<{ action: AgentAction }>("POST", `/v1/assistant/actions/${action.id}`, { approve });
      setMessages(current => current.map(m => ({ ...m, meta: { ...m.meta, actions: m.meta?.actions?.map(a => a.id === action.id ? result.action : a) } })));
    } catch (reason) { setError(String(reason)); }
  };

  const empty = !messages.length && !busy;
  return <section className={"chat" + (dragging ? " dragging" : "")} aria-label="Чат"
    onDragEnter={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); }}
    onDragLeave={event => { if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files); }}>
    {dragging ? <div className="drop-overlay"><Paperclip size={28} /><b>Отпустите, чтобы прикрепить</b><small>Фото, Excel, Word, PDF, текст</small></div> : null}
    <h1 className="visually-hidden">Ассистент</h1>
    <div className="chat-scroll" ref={listRef}>
      {empty ? <div className="chat-welcome">
        <Logo size={56} className="chat-logo" />
        <h2>Чем помочь?</h2>
        <p>Я Маления — ваша помощница для работы и не только. Пишите, спрашивайте, поручайте.</p>
        {connected && providers && !cloudReady && !localReady ? <button className="setup-hint" onClick={props.onOpenSettings}>
          <Brain size={18} /><span><b>Настройте модель для Малении</b><small>Скачайте локальную модель под вашу видеокарту или подключите бесплатный GigaChat — это пара минут.</small></span>
        </button> : null}
        <div className="suggestions">
          {SUGGESTIONS.map(item => <button key={item.title} onClick={() => { setDraft(item.text); inputRef.current?.focus(); }}>
            {item.icon}<b>{item.title}</b><small>{item.text}</small></button>)}
          <button onClick={props.onOpenTools}><Wrench size={18} /><b>Рабочие инструменты</b><small>Инвентаризация, проверка заказов</small></button>
        </div>
      </div> : <div className="chat-thread">
        {messages.map(message => <Message key={message.id} message={message} onRate={rate} onDecide={decide} />)}
        {busy ? <>
          <div className="msg user"><div className="bubble">
            {pendingFiles.some(f => f.preview) ? <div className="bubble-photos">{pendingFiles.filter(f => f.preview).map((file, index) => <img key={index} src={file.preview} alt={file.name} />)}</div> : null}
            {pendingText}</div></div>
          <div className="msg assistant"><Logo size={28} className="avatar" /><div className="thinking"><span /><span /><span /></div></div>
        </> : null}
      </div>}
    </div>

    <div className="composer-wrap">
      {error ? <div className="chat-error" role="alert"><span>{error}</span>{/настро|ключ|модел/i.test(error) ? <button onClick={props.onOpenSettings}>Открыть настройки</button> : null}<button aria-label="Скрыть ошибку" onClick={() => setError("")}><X size={14} /></button></div> : null}
      {instruction ? <div className="instruction-chip"><ListChecks size={14} /><span>Инструкция: <b>{instruction.title}</b></span><button onClick={onClearInstruction}>Убрать</button></div> : null}
      <div className={"composer" + (privateMode ? " private" : "")}>
        {files.length ? <div className="attachments">{files.map((file, index) => <span key={index} className={"attachment" + (file.preview ? " photo" : "") + (file.loading ? " loading" : "")}>
          {file.loading ? <LoaderCircle className="spin" size={16} /> : file.preview ? <img src={file.preview} alt={file.name} /> : <FileText size={14} />}
          {file.preview ? null : <span>{file.loading ? "Загружается…" : file.name}</span>}
          <button aria-label={`Убрать ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X size={12} /></button>
        </span>)}</div> : null}
        <textarea ref={inputRef} aria-label="Сообщение" rows={1} value={draft} disabled={!connected}
          placeholder={connected ? (privateMode ? "Приватный вопрос — останется на ваших компьютерах…" : "Спросите что угодно…") : "Маления запускается…"}
          onChange={event => setDraft(event.target.value)}
          onPaste={event => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); void addFiles(pasted); } }}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="composer-bar">
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
          <button className="icon-btn" aria-label="Приложить файл" title="Фото, Excel, Word, PDF, текст — до 12 МБ" disabled={!connected} onClick={() => fileRef.current?.click()}><Paperclip size={17} /></button>
          <button className={"chip-toggle" + (useWeb && !privateMode ? " on" : "")} disabled={privateMode} aria-pressed={useWeb && !privateMode}
            title="Разрешить искать в интернете, когда нужно" onClick={() => setUseWeb(value => !value)}><Globe2 size={14} />Интернет</button>
          <button className={"chip-toggle" + (privateMode ? " on private" : "")} aria-pressed={privateMode}
            title="Только локальная модель или ваш сервер, без облака" onClick={() => setPrivateMode(value => !value)}><Lock size={14} />Приватно</button>
          <span className="composer-model">{privateMode ? "Локально" : providers ? (cloudReady && providers.mode !== "local" ? "Облако + резерв" : providers.local_model ? providers.local_model.replace(/:latest$/, "") : "Локальная модель") : ""}</span>
          <button className="send" aria-label="Отправить" disabled={(!draft.trim() && !files.length) || busy || !connected || files.some(f => f.loading)} onClick={() => void send()}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
      <small className="composer-note">Маления может ошибаться. Важные факты проверяйте. Enter — отправить, Shift+Enter — новая строка. Файлы можно перетащить или вставить.</small>
    </div>
  </section>;
}

function Message({ message, onRate, onDecide }: { message: ChatMessage; onRate: (m: ChatMessage, rating: number, comment?: string) => void; onDecide: (a: AgentAction, approve: boolean) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<"" | "ok" | "error">("");
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  if (message.role === "user") return <div className="msg user"><div className="bubble">
    {message.meta?.attachments?.some(file => file.preview) ? <div className="bubble-photos">{message.meta.attachments.filter(file => file.preview).map((file, index) =>
      <img key={index} src={file.preview} alt={file.name} />)}</div> : null}
    {message.meta?.attachments?.some(file => !file.preview) ? <div className="bubble-files">{message.meta.attachments.filter(file => !file.preview).map((file, index) =>
      <span key={index}>{file.kind === "image" ? <ImageIcon size={13} /> : <FileText size={13} />}{file.name}</span>)}</div> : null}
    {message.content}</div></div>;
  const sources = message.meta?.sources ?? [];
  const learned = message.meta?.learned ?? [];
  return <div className="msg assistant">
    <Logo size={28} className="avatar" />
    <div className="msg-body">
      <Markdown text={message.content} onLink={openLink} />
      {sources.length ? <div className="sources">{sources.map(source =>
        <button key={source.url} onClick={() => openLink(source.url)} title={source.url}><Globe2 size={12} />{source.title || new URL(source.url).hostname}</button>)}</div> : null}
      {(message.meta?.actions ?? []).map(action => <ActionCard key={action.id} action={action} onDecide={onDecide} />)}
      {(message.meta?.skills_learned ?? []).map(skill => <div className="learned skill" key={skill.id}><GraduationCap size={13} />Выучила навык: <b>{skill.title}</b> — посмотреть и изменить можно в «Память → Инструкции»</div>)}
      {learned.length ? <div className="learned"><Brain size={13} />Запомнила: {learned.map(item => item.content).join("; ")}</div> : null}
      <div className="msg-actions">
        <button title="Копировать" aria-label="Копировать ответ" onClick={() => { void navigator.clipboard?.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        <button title="Хороший ответ" aria-label="Хороший ответ" className={message.feedback > 0 ? "on" : ""} onClick={() => onRate(message, 1)}><ThumbsUp size={14} /></button>
        <button title="Плохой ответ" aria-label="Плохой ответ" className={message.feedback < 0 ? "on bad" : ""} onClick={() => { if (message.feedback < 0) onRate(message, 0); else setAsking(true); }}><ThumbsDown size={14} /></button>
        <button title="Сохранить как план" aria-label="Сохранить как план" className={saved === "ok" ? "on" : ""} disabled={saved === "ok"} onClick={() => {
          const title = message.content.replace(/[#*`>]/g, "").split("\n").find(line => line.trim())?.trim().slice(0, 120) || "План из ответа";
          invoke("create_task", { title, description: message.content.slice(0, 2000), requestId: message.id })
            .then(() => setSaved("ok")).catch(() => setSaved("error"));
        }}>{saved === "ok" ? <Check size={14} /> : <Bookmark size={14} />}</button>
        {saved === "error" ? <span className="bad-text">не сохранено</span> : null}
        <span>{providerLabel(message.provider)}{message.model ? " · " + message.model : ""}{message.meta?.private ? " · приватно" : ""}</span>
      </div>
      {asking ? <form className="correction" onSubmit={event => { event.preventDefault(); onRate(message, -1, comment.trim() || undefined); setAsking(false); setComment(""); }}>
        <input autoFocus value={comment} maxLength={1000} onChange={event => setComment(event.target.value)} placeholder="Как надо было ответить? Маления запомнит это на будущее" />
        <button type="submit" className="primary">Сохранить</button>
        <button type="button" className="secondary" onClick={() => setAsking(false)}>Отмена</button>
      </form> : null}
    </div>
  </div>;
}

const STATUS: Record<AgentAction["status"], string> = {
  pending: "Ждёт вашего подтверждения", running: "Выполняется…", done: "Выполнено", failed: "Не удалось",
  cancelled: "Отменено", ui: "Открыто в приложении",
};

function ActionCard({ action, onDecide }: { action: AgentAction; onDecide: (a: AgentAction, approve: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const preview = typeof action.arguments?.content === "string" ? action.arguments.content as string
    : Array.isArray(action.arguments?.values) ? (action.arguments.values as unknown[][]).map(row => row.join(" | ")).join("\n") : "";
  const decide = async (approve: boolean) => { setBusy(true); try { await onDecide(action, approve); } finally { setBusy(false); } };
  return <div className={"action-card " + action.status}>
    <div className="action-head"><Play size={14} /><b>{action.summary}</b><span>{STATUS[action.status]}</span></div>
    {preview && action.status === "pending" ? <pre>{preview.slice(0, 1500)}{preview.length > 1500 ? "\n…" : ""}</pre> : null}
    {action.status === "failed" && action.result?.error ? <p className="bad-text">{String(action.result.error)}</p> : null}
    {action.status === "pending" ? <div className="action-buttons">
      <button className="primary" disabled={busy} onClick={() => void decide(true)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Выполнить</button>
      <button className="secondary" disabled={busy} onClick={() => void decide(false)}>Отмена</button>
    </div> : null}
  </div>;
}
