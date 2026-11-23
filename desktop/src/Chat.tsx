import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp, Bookmark, Brain, Check, Copy, Globe2, LoaderCircle, Lock, Mail, ListChecks,
  Lightbulb, Sparkles, ThumbsDown, ThumbsUp, Wrench, X,
} from "lucide-react";
import { api, providerLabel, type ChatMessage, type ChatReply, type ConversationDetail, type ProvidersInfo } from "./api";
import { Markdown } from "./Markdown";

type Props = {
  connected: boolean;
  conversationId: string | null;
  onConversation: (id: string | null) => void;
  onChanged: () => void;
  instruction: { title: string; instructions: string } | null;
  onClearInstruction: () => void;
  onOpenSettings: () => void;
  onOpenTools: () => void;
};

const SUGGESTIONS = [
  { icon: <ListChecks size={18} />, title: "Спланировать день", text: "Помоги составить план рабочего дня с приоритетами" },
  { icon: <Mail size={18} />, title: "Написать письмо", text: "Напиши вежливое письмо коллеге с просьбой прислать отчёт до пятницы" },
  { icon: <Lightbulb size={18} />, title: "Объяснить простыми словами", text: "Объясни простыми словами, как работает " },
  { icon: <Globe2 size={18} />, title: "Найти в интернете", text: "Найди свежие новости о " },
];

const openLink = (url: string) => { void invoke("open_search_source", { url }).catch(() => undefined); };

export function Chat(props: Props) {
  const { connected, conversationId, onConversation, onChanged, instruction, onClearInstruction } = props;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [privateMode, setPrivateMode] = useState(false);
  const [useWeb, setUseWeb] = useState(true);
  const [providers, setProviders] = useState<ProvidersInfo | null>(null);
  const [pendingText, setPendingText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const key = conversationId ?? "new";
  const draft = drafts[key] ?? "";
  const setDraft = (value: string) => setDrafts(current => ({ ...current, [key]: value }));

  const loadProviders = useCallback(async () => {
    try { setProviders(await api<ProvidersInfo>("GET", "/v1/ai/providers")); } catch { /* agent starting */ }
  }, []);
  useEffect(() => { if (connected) void loadProviders(); }, [connected, loadProviders]);

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
    const text = (textOverride ?? draft).trim();
    if (!text || busy || !connected) return;
    setBusy(true); setError(""); setPendingText(text); setDraft("");
    try {
      const reply = await api<ChatReply>("POST", "/v1/assistant/chat", {
        message: text, conversation_id: conversationId, private: privateMode, use_web: useWeb,
        instruction: instruction ? `${instruction.title}\n${instruction.instructions}` : null,
      });
      setMessages(current => [...current, reply.user_message, reply.message]);
      if (reply.conversation_id !== conversationId) {
        setDrafts(current => ({ ...current, [reply.conversation_id]: "" }));
        onConversation(reply.conversation_id);
      }
      onChanged();
    } catch (reason) {
      setError(String(reason)); setDraft(text);
    } finally { setBusy(false); setPendingText(""); inputRef.current?.focus(); }
  };

  const rate = async (message: ChatMessage, rating: number, comment?: string) => {
    const next = message.feedback === rating && !comment ? 0 : rating;
    try {
      await api("POST", "/v1/assistant/feedback", { message_id: message.id, rating: next, comment: comment ?? null });
      setMessages(current => current.map(m => m.id === message.id ? { ...m, feedback: next } : m));
    } catch (reason) { setError(String(reason)); }
  };

  const empty = !messages.length && !busy;
  return <section className="chat" aria-label="Чат">
    <h1 className="visually-hidden">Ассистент</h1>
    <div className="chat-scroll" ref={listRef}>
      {empty ? <div className="chat-welcome">
        <div className="chat-logo"><Sparkles size={26} /></div>
        <h2>Чем помочь?</h2>
        <p>Я Шерлок — ваш помощник для работы и не только. Пишите, спрашивайте, поручайте.</p>
        {connected && providers && !cloudReady && providers.mode !== "local" ? <button className="setup-hint" onClick={props.onOpenSettings}>
          <Brain size={18} /><span><b>Подключите бесплатную умную модель</b><small>2 минуты: ключ Gemini или Groq без карты. Сейчас используется только локальная модель.</small></span>
        </button> : null}
        <div className="suggestions">
          {SUGGESTIONS.map(item => <button key={item.title} onClick={() => { setDraft(item.text); inputRef.current?.focus(); }}>
            {item.icon}<b>{item.title}</b><small>{item.text}</small></button>)}
          <button onClick={props.onOpenTools}><Wrench size={18} /><b>Рабочие инструменты</b><small>Инвентаризация, проверка заказов</small></button>
        </div>
      </div> : <div className="chat-thread">
        {messages.map(message => <Message key={message.id} message={message} onRate={rate} />)}
        {busy ? <>
          <div className="msg user"><div className="bubble">{pendingText}</div></div>
          <div className="msg assistant"><div className="avatar"><Sparkles size={15} /></div><div className="thinking"><span /><span /><span /></div></div>
        </> : null}
      </div>}
    </div>

    <div className="composer-wrap">
      {error ? <div className="chat-error" role="alert"><span>{error}</span>{/настро|ключ|модел/i.test(error) ? <button onClick={props.onOpenSettings}>Открыть настройки</button> : null}<button aria-label="Скрыть ошибку" onClick={() => setError("")}><X size={14} /></button></div> : null}
      {instruction ? <div className="instruction-chip"><ListChecks size={14} /><span>Инструкция: <b>{instruction.title}</b></span><button onClick={onClearInstruction}>Убрать</button></div> : null}
      <div className={"composer" + (privateMode ? " private" : "")}>
        <textarea ref={inputRef} aria-label="Сообщение" rows={1} value={draft} disabled={!connected}
          placeholder={connected ? (privateMode ? "Приватный вопрос — останется на ваших компьютерах…" : "Спросите что угодно…") : "Маления запускается…"}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="composer-bar">
          <button className={"chip-toggle" + (useWeb && !privateMode ? " on" : "")} disabled={privateMode} aria-pressed={useWeb && !privateMode}
            title="Разрешить искать в интернете, когда нужно" onClick={() => setUseWeb(value => !value)}><Globe2 size={14} />Интернет</button>
          <button className={"chip-toggle" + (privateMode ? " on private" : "")} aria-pressed={privateMode}
            title="Только локальная модель или ваш сервер, без облака" onClick={() => setPrivateMode(value => !value)}><Lock size={14} />Приватно</button>
          <span className="composer-model">{privateMode ? "Локально" : providers ? (cloudReady && providers.mode !== "local" ? "Облако + резерв" : "Локальная модель") : ""}</span>
          <button className="send" aria-label="Отправить" disabled={!draft.trim() || busy || !connected} onClick={() => void send()}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
      <small className="composer-note">Шерлок может ошибаться. Важные факты проверяйте. Enter — отправить, Shift+Enter — новая строка.</small>
    </div>
  </section>;
}

function Message({ message, onRate }: { message: ChatMessage; onRate: (m: ChatMessage, rating: number, comment?: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<"" | "ok" | "error">("");
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  if (message.role === "user") return <div className="msg user"><div className="bubble">{message.content}</div></div>;
  const sources = message.meta?.sources ?? [];
  const learned = message.meta?.learned ?? [];
  return <div className="msg assistant">
    <div className="avatar"><Sparkles size={15} /></div>
    <div className="msg-body">
      <Markdown text={message.content} onLink={openLink} />
      {sources.length ? <div className="sources">{sources.map(source =>
        <button key={source.url} onClick={() => openLink(source.url)} title={source.url}><Globe2 size={12} />{source.title || new URL(source.url).hostname}</button>)}</div> : null}
      {learned.length ? <div className="learned"><Brain size={13} />Запомнил: {learned.map(item => item.content).join("; ")}</div> : null}
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
        <input autoFocus value={comment} maxLength={1000} onChange={event => setComment(event.target.value)} placeholder="Как надо было ответить? Шерлок запомнит это на будущее" />
        <button type="submit" className="primary">Сохранить</button>
        <button type="button" className="secondary" onClick={() => setAsking(false)}>Отмена</button>
      </form> : null}
    </div>
  </div>;
}
