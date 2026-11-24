import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp, Bookmark, Brain, Check, CircleAlert, Copy, FileText, GraduationCap, Globe2, Image as ImageIcon, LoaderCircle, Lock,
  Mail, ListChecks, Lightbulb, Mic, PanelRight, Paperclip, Pencil, Play, RotateCcw, Square, ThumbsDown, ThumbsUp, Wrench, X,
} from "lucide-react";
import { api, providerLabel, type AgentAction, type Attachment, type ChatMessage, type ConversationDetail, type Project, type ProvidersInfo, type RunState, type RunStep } from "./api";
import { downloadText, Markdown } from "./Markdown";
import { Logo } from "./Logo";
import { Recorder } from "./voiceInput";

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
  compact?: boolean;
  project?: Project | null;
  /** A task handed over by the app (e.g. "разбери оставшиеся строки"): sent once in a new chat. */
  autoPrompt?: { id: number; text: string } | null;
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Live = { runId: string; text: string; steps: RunStep[]; status: string };

function Steps({ steps, live }: { steps: RunStep[]; live?: boolean }) {
  if (!steps.length) return null;
  const list = <ul className="steps">{steps.map(step => <li key={step.id} className={step.status}>
    {step.status === "running" ? <LoaderCircle className="spin" size={13} /> : step.status === "error" ? <CircleAlert size={13} /> : <Check size={13} />}
    <span>{step.label}</span></li>)}</ul>;
  if (live) return list;
  return <details className="steps-box"><summary>Ход работы · {steps.length} {steps.length === 1 ? "шаг" : steps.length < 5 ? "шага" : "шагов"}</summary>{list}</details>;
}

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

  const stick = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTo({ top: list.scrollHeight, behavior: busy ? "auto" : "smooth" });
  });

  const cloudReady = !!providers?.providers.some(p => p.enabled);
  const [live, setLive] = useState<Live | null>(null);
  const [panel, setPanel] = useState<{ id: string; content: string } | null>(null);
  const runRef = useRef<string | null>(null);

  /** Start an answer in the background and follow it: text appears as it is written. */
  const runChat = async (body: Record<string, unknown>, restore: () => void) => {
    setBusy(true); setError("");
    const startedAt = Date.now();
    let started = false;
    let startedUser = "";
    try {
      const { run_id } = await api<{ run_id: string }>("POST", "/v1/assistant/runs", body);
      runRef.current = run_id;
      setLive({ runId: run_id, text: "", steps: [], status: "Думаю…" });
      let after = 0, delay = 80;
      for (;;) {
        const state = await api<RunState>("GET", `/v1/assistant/runs/${run_id}?after=${after}`);
        after = state.next;
        for (const event of state.events) {
          if (event.type === "started") {
            started = true;
            startedUser = event.user_message.id;
            setPendingText(""); setPendingFiles([]);
            setMessages(current => current.some(m => m.id === event.user_message.id) ? current : [...current, event.user_message]);
            if (event.conversation_id !== conversationId) {
              setDrafts(current => ({ ...current, [event.conversation_id]: "" }));
              onConversation(event.conversation_id);
            }
          } else if (event.type === "delta") {
            setLive(current => current && { ...current, text: current.text + event.text });
          } else if (event.type === "reset") {
            setLive(current => current && { ...current, text: "" });
          } else if (event.type === "status") {
            setLive(current => current && { ...current, status: event.text });
          } else if (event.type === "step") {
            const step: RunStep = { id: event.id, tool: event.tool, label: event.label, status: event.status };
            setLive(current => current && { ...current, steps: current.steps.some(s => s.id === step.id)
              ? current.steps.map(s => s.id === step.id ? step : s) : [...current.steps, step] });
          }
        }
        if (state.done) {
          if (state.error) {
            setError(state.error.message || state.error.error);
            // The question was not answered: put it back into the input instead of the thread.
            if (started && !body.regenerate) setMessages(current => current.filter(m => m.id !== startedUser));
            restore();
          } else if (state.result) {
            const reply = state.result;
            setMessages(current => [...current.filter(m => m.id !== reply.message.id && m.id !== reply.user_message.id), reply.user_message, reply.message]);
            for (const action of reply.message.meta?.actions ?? []) if (action.status === "ui") props.onUiAction(action);
            // A long answer finished while the user was elsewhere: let them know.
            if (Date.now() - startedAt > 15000) {
              const preview = reply.message.content.replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
              void invoke("notify", { title: "Маления ответила", body: preview || "Ответ готов" }).catch(() => undefined);
            }
          }
          break;
        }
        await sleep(state.events.length ? 80 : delay);
        delay = state.events.length ? 80 : Math.min(400, delay + 40);
      }
      onChanged();
    } catch (reason) {
      setError(String(reason));
      if (!started) restore();
    } finally {
      runRef.current = null;
      setLive(null); setBusy(false); setPendingText(""); setPendingFiles([]); inputRef.current?.focus();
    }
  };

  const send = async (textOverride?: string) => {
    const sending = files;
    const text = (textOverride ?? draft).trim() || (sending.length ? "Посмотри вложения" : "");
    if (!text || busy || !connected || sending.some(f => f.loading)) return;
    setPendingText(text); setPendingFiles(sending); setDraft(""); setFiles([]);
    await runChat({
      message: text, conversation_id: conversationId, private: privateMode, use_web: useWeb,
      project_id: conversationId ? undefined : props.project?.id,
      instruction: instruction ? `${instruction.title}\n${instruction.instructions}` : null,
      attachments: sending.map(({ name, mime, data, preview }) => ({ name, mime, data, preview })),
    }, () => { setDraft(text); setFiles(sending); });
  };

  // ---- voice input (local whisper.cpp) ----
  const recorder = useRef<Recorder | null>(null);
  const [voice, setVoice] = useState<"idle" | "recording" | "transcribing" | "installing">("idle");
  const [voiceProgress, setVoiceProgress] = useState(0);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (voice !== "recording") return;
    setSeconds(0);
    const id = window.setInterval(() => setSeconds(value => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [voice]);
  const toggleVoice = async () => {
    if (voice === "recording") {
      setVoice("transcribing");
      try {
        const audio = await recorder.current!.stop();
        const { text } = await api<{ text: string }>("POST", "/v1/assistant/voice/transcribe", { audio, language: "ru" });
        if (text) setDraft((draft ? draft.trimEnd() + " " : "") + text);
        else setError("Не расслышала. Попробуйте ещё раз, говорите ближе к микрофону.");
        inputRef.current?.focus();
      } catch (reason) { setError(String(reason)); } finally { setVoice("idle"); }
      return;
    }
    if (voice !== "idle") return;
    try {
      const status = await api<{ ready: boolean; state: string; progress: number }>("GET", "/v1/assistant/voice");
      if (!status.ready) {
        if (!window.confirm("Для голосового ввода нужно один раз скачать распознавание речи (около 470 МБ). Всё работает на вашем компьютере, без интернета. Скачать?")) return;
        setVoice("installing");
        type VoiceStatus = { ready: boolean; state: string; progress: number; error: string | null };
        let state = await api<VoiceStatus>("POST", "/v1/assistant/voice/install", { model: "small" });
        while (!state.ready && state.state !== "failed") {
          setVoiceProgress(state.progress);
          await sleep(1500);
          state = await api<VoiceStatus>("GET", "/v1/assistant/voice");
        }
        setVoice("idle");
        if (!state.ready) { setError(state.error || "Не удалось установить голосовой ввод"); return; }
      }
      recorder.current = new Recorder();
      await recorder.current.start();
      setVoice("recording");
    } catch (reason) {
      setVoice("idle");
      setError(/NotAllowed|Permission/i.test(String(reason)) ? "Нет доступа к микрофону. Разрешите его в настройках Windows → Конфиденциальность → Микрофон." : String(reason));
    }
  };
  useEffect(() => () => recorder.current?.cancel(), []);

  const autoSent = useRef(0);
  useEffect(() => {
    const task = props.autoPrompt;
    if (!task || task.id === autoSent.current || !connected || busy || conversationId) return;
    autoSent.current = task.id;
    void send(task.text);
  });

  const stop = () => { if (runRef.current) void api("POST", `/v1/assistant/runs/${runRef.current}/cancel`).catch(() => undefined); };

  const regenerate = async () => {
    if (busy || !conversationId) return;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") setMessages(current => current.slice(0, -1));
    await runChat({ conversation_id: conversationId, regenerate: true, private: privateMode, use_web: useWeb },
      () => { if (last?.role === "assistant") setMessages(current => [...current, last]); });
  };

  const edit = async (message: ChatMessage, text: string) => {
    if (busy || !conversationId || !text.trim()) return;
    const index = messages.findIndex(m => m.id === message.id);
    const before = messages;
    setMessages(current => current.slice(0, index));
    setPendingText(text.trim());
    await runChat({ conversation_id: conversationId, message: text.trim(), edit_message_id: message.id, private: privateMode, use_web: useWeb },
      () => setMessages(before));
  };

  useEffect(() => {
    if (!busy || typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

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
  return <section className={"chat" + (dragging ? " dragging" : "") + (props.compact ? " compact" : "") + (panel ? " with-panel" : "")} aria-label="Чат"
    onDragEnter={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); }}
    onDragLeave={event => { if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files); }}>
    {dragging ? <div className="drop-overlay"><Paperclip size={28} /><b>Отпустите, чтобы прикрепить</b><small>Фото, Excel, Word, PDF, текст</small></div> : null}
    <h1 className="visually-hidden">Ассистент</h1>
    <div className="chat-scroll" ref={listRef} onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {empty ? <div className="chat-welcome">
        <Logo size={56} className="chat-logo" />
        <h2>{props.project ? props.project.name : "Чем помочь?"}</h2>
        <p>{props.project ? "Новый чат в проекте: Маления учтёт его инструкции и базу знаний." : "Я Маления — ваша помощница для работы и не только. Пишите, спрашивайте, поручайте."}</p>
        {connected && providers && !cloudReady && !localReady ? <button className="setup-hint" onClick={props.onOpenSettings}>
          <Brain size={18} /><span><b>Настройте модель для Малении</b><small>Скачайте локальную модель под вашу видеокарту или подключите бесплатный GigaChat — это пара минут.</small></span>
        </button> : null}
        <div className="suggestions">
          {SUGGESTIONS.map(item => <button key={item.title} onClick={() => { setDraft(item.text); inputRef.current?.focus(); }}>
            {item.icon}<b>{item.title}</b><small>{item.text}</small></button>)}
          <button onClick={props.onOpenTools}><Wrench size={18} /><b>Рабочие инструменты</b><small>Инвентаризация, проверка заказов</small></button>
        </div>
      </div> : <div className="chat-thread">
        {messages.map((message, index) => <Message key={message.id} message={message} onRate={rate} onDecide={decide}
          busy={busy} last={index === messages.length - 1} onRegenerate={() => void regenerate()} onEdit={text => void edit(message, text)}
          onPanel={props.compact ? undefined : () => setPanel(panel?.id === message.id ? null : { id: message.id, content: message.content })} />)}
        {busy ? <>
          {pendingText ? <div className="msg user"><div className="bubble">
            {pendingFiles.some(f => f.preview) ? <div className="bubble-photos">{pendingFiles.filter(f => f.preview).map((file, index) => <img key={index} src={file.preview} alt={file.name} />)}</div> : null}
            {pendingText}</div></div> : null}
          <div className="msg assistant live" aria-live="polite"><Logo size={28} className="avatar" />
            <div className="msg-body">
              <Steps steps={live?.steps ?? []} live />
              {live?.text ? <Markdown text={live.text + " ▍"} onLink={openLink} />
                : <div className="thinking-row"><div className="thinking"><span /><span /><span /></div><small>{live?.status ?? "Думаю…"}</small></div>}
            </div>
          </div>
        </> : null}
      </div>}
    </div>

    {panel ? <aside className="side-panel" aria-label="Панель документа">
      <header><b>{panel.content.replace(/[#*`>]/g, "").split("\n").find(line => line.trim())?.trim().slice(0, 80) || "Документ"}</b>
        <button className="icon-btn tiny" title="Копировать" aria-label="Копировать документ" onClick={() => void navigator.clipboard?.writeText(panel.content)}><Copy size={14} /></button>
        <button className="icon-btn tiny" title="Сохранить как файл .md" aria-label="Сохранить документ" onClick={() => downloadText("Маления.md", panel.content, "text/markdown")}><FileText size={14} /></button>
        <button className="icon-btn tiny" aria-label="Закрыть панель" onClick={() => setPanel(null)}><X size={14} /></button></header>
      <div className="side-panel-body"><Markdown text={panel.content} onLink={openLink} /></div>
    </aside> : null}
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
          <button className={"icon-btn mic" + (voice === "recording" ? " recording" : "")} aria-label={voice === "recording" ? "Остановить запись" : "Голосовой ввод"} disabled={!connected || voice === "transcribing" || voice === "installing"}
            title={voice === "recording" ? "Нажмите, чтобы закончить" : "Голосовой ввод — распознаётся на вашем компьютере"} onClick={() => void toggleVoice()}>
            {voice === "transcribing" || voice === "installing" ? <LoaderCircle className="spin" size={16} /> : <Mic size={16} />}</button>
          {voice === "recording" ? <span className="voice-note">● {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span> : null}
          {voice === "installing" ? <span className="voice-note">Скачиваю распознавание речи… {Math.round(voiceProgress * 100)}%</span> : null}
          {voice === "transcribing" ? <span className="voice-note">Распознаю…</span> : null}
          <button className="icon-btn" aria-label="Приложить файл" title="Фото, Excel, Word, PDF, текст — до 12 МБ" disabled={!connected} onClick={() => fileRef.current?.click()}><Paperclip size={17} /></button>
          <button className={"chip-toggle" + (useWeb && !privateMode ? " on" : "")} disabled={privateMode} aria-pressed={useWeb && !privateMode}
            title="Разрешить искать в интернете, когда нужно" onClick={() => setUseWeb(value => !value)}><Globe2 size={14} />Интернет</button>
          <button className={"chip-toggle" + (privateMode ? " on private" : "")} aria-pressed={privateMode}
            title="Только локальная модель или ваш сервер, без облака" onClick={() => setPrivateMode(value => !value)}><Lock size={14} />Приватно</button>
          <span className="composer-model">{privateMode ? "Локально" : providers ? (cloudReady && providers.mode !== "local" ? "Облако + резерв" : providers.local_model ? providers.local_model.replace(/:latest$/, "") : "Локальная модель") : ""}</span>
          {busy ? <button className="send stop" aria-label="Остановить" title="Остановить (Esc)" onClick={stop}><Square size={14} /></button>
            : <button className="send" aria-label="Отправить" disabled={(!draft.trim() && !files.length) || !connected || files.some(f => f.loading)} onClick={() => void send()}>
              <ArrowUp size={18} /></button>}
        </div>
      </div>
      <small className="composer-note">Маления может ошибаться. Важные факты проверяйте. Enter — отправить, Shift+Enter — новая строка, Esc — остановить. Файлы и скриншоты можно перетащить или вставить (Ctrl+V).</small>
    </div>
  </section>;
}

type MessageProps = {
  message: ChatMessage; onRate: (m: ChatMessage, rating: number, comment?: string) => void;
  onDecide: (a: AgentAction, approve: boolean) => Promise<void>;
  busy?: boolean; last?: boolean; onRegenerate?: () => void; onEdit?: (text: string) => void; onPanel?: () => void;
};

function Message({ message, onRate, onDecide, busy, last, onRegenerate, onEdit, onPanel }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<"" | "ok" | "error">("");
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  if (message.role === "user" && editing !== null) return <div className="msg user"><form className="bubble editing" onSubmit={event => { event.preventDefault(); onEdit?.(editing); setEditing(null); }}>
    <textarea autoFocus aria-label="Изменить сообщение" value={editing} rows={Math.min(8, editing.split("\n").length + 1)} onChange={event => setEditing(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onEdit?.(editing); setEditing(null); } if (event.key === "Escape") setEditing(null); }} />
    <div className="edit-actions"><button type="button" className="secondary" onClick={() => setEditing(null)}>Отмена</button><button type="submit" className="primary" disabled={!editing.trim()}>Отправить</button></div>
  </form></div>;
  if (message.role === "user") return <div className="msg user"><button className="edit-btn" title="Изменить и отправить заново" aria-label="Изменить сообщение" disabled={busy} onClick={() => setEditing(message.content)}><Pencil size={13} /></button><div className="bubble">
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
      <Steps steps={message.meta?.steps ?? []} />
      <Markdown text={message.content} onLink={openLink} />
      {message.meta?.stopped ? <small className="stopped-note">Ответ остановлен</small> : null}
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
        {onPanel && (message.content.length > 1200 || /```|^\s*\|.*\|\s*$/m.test(message.content)) ? <button title="Открыть в боковой панели" aria-label="Открыть в панели" onClick={onPanel}><PanelRight size={14} /></button> : null}
        {last && onRegenerate ? <button title="Ответить заново" aria-label="Ответить заново" disabled={busy} onClick={onRegenerate}><RotateCcw size={14} /></button> : null}
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
