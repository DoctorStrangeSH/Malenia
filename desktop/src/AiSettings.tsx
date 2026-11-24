import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check, ChevronDown, Cloud, Cpu, Download, ExternalLink, FolderOpen, HardDrive, KeyRound,
  LoaderCircle, Play, RefreshCw, Server, Sparkles, X,
} from "lucide-react";
import { api, type CatalogModel, type EngineState, type HardwareInfo, type ProviderInfo, type ProvidersInfo } from "./api";

const open = (url: string) => { void invoke("open_search_source", { url }).catch(() => undefined); };
const CONTEXTS: { id: "auto" | 8192 | 16384 | 32768; title: string; text: string }[] = [
  { id: "auto", title: "Авто", text: "16K для лёгких моделей, 8K для тяжёлых — без риска нехватки памяти" },
  { id: 8192, title: "8K", text: "Экономно: короткие задачи, тяжёлые модели" },
  { id: 16384, title: "16K", text: "Баланс: разбор листа, несколько страниц Asgard" },
  { id: 32768, title: "32K", text: "Максимум: длинные разборы. Медленнее, нужно много памяти" },
];

const MODES: { id: ProvidersInfo["mode"]; title: string; text: string }[] = [
  { id: "auto", title: "Авто", text: "Облако, при сбое — ваш сервер или локальная модель" },
  { id: "cloud", title: "Только облако", text: "Максимум качества, нужен интернет" },
  { id: "local", title: "Только свои компьютеры", text: "Данные не уходят в интернет" },
];

/** Step-by-step key guides. Opened links go through the app's safe URL opener. */
const GUIDES: Record<string, { url: string; steps: string[] }> = {
  gigachat: { url: "https://developers.sber.ru/studio/workspaces", steps: [
    "Откройте сайт по кнопке «Открыть сайт» и войдите через Сбер ID (подойдёт номер телефона).",
    "Создайте проект «GigaChat API» для физлиц и примите соглашение — включится бесплатный Freemium-режим.",
    "В проекте откройте «Настройки API» и нажмите «Получить ключ».",
    "Скопируйте «Ключ авторизации» (длинная строка) и вставьте его в поле выше.",
  ] },
  gemini: { url: "https://aistudio.google.com/apikey", steps: [
    "Из России Google AI Studio не открывается — нужен VPN другой страны.",
    "Войдите в аккаунт Google и нажмите «Create API key».",
    "Скопируйте ключ (начинается с AIza) и вставьте его выше. Карта не нужна.",
  ] },
  groq: { url: "https://console.groq.com/keys", steps: [
    "Войдите через Google или почту (из России может понадобиться VPN).",
    "Нажмите «Create API Key», придумайте название.",
    "Скопируйте ключ (начинается с gsk_) — он показывается один раз.",
  ] },
  cerebras: { url: "https://cloud.cerebras.ai", steps: [
    "Зарегистрируйтесь (из России может понадобиться VPN).",
    "Откройте раздел «API Keys» и создайте ключ.",
    "Скопируйте ключ (начинается с csk-) и вставьте его выше.",
  ] },
  openrouter: { url: "https://openrouter.ai/keys", steps: [
    "С июня 2026 года OpenRouter не обслуживает Россию: нужен VPN и зарубежный аккаунт.",
    "Создайте ключ в разделе Keys (начинается с sk-or-).",
  ] },
};

const FIT: Record<CatalogModel["fit"], { label: string; tone: string }> = {
  fast: { label: "Быстро на видеокарте", tone: "ok" },
  ok: { label: "Хорошо (видеокарта + ОЗУ)", tone: "ok" },
  slow: { label: "Будет медленно", tone: "warn" },
  no: { label: "Не хватит памяти", tone: "bad" },
};

export function AiSettings({ connected, onOpenOwnModel }: { connected: boolean; onOpenOwnModel?: () => void }) {
  const [info, setInfo] = useState<ProvidersInfo | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setInfo(await api<ProvidersInfo>("GET", "/v1/ai/providers")); setError(""); }
    catch (reason) { setError(String(reason)); }
  }, []);
  const loadHardware = useCallback(async (refresh = false) => {
    try { setHardware(await api<HardwareInfo>("GET", "/v1/ai/hardware" + (refresh ? "?refresh=1" : ""))); } catch { /* optional */ }
  }, []);
  useEffect(() => { if (connected) { void load(); void loadHardware(); } }, [connected, load, loadHardware]);
  // Any change of models or keys must show up in the chat at once.
  useEffect(() => { if (info) window.dispatchEvent(new Event("malenia:models-changed")); }, [info]);
  useEffect(() => {
    if (hardware?.pull.status !== "running") return;
    const id = window.setInterval(() => void loadHardware(), 1500);
    return () => window.clearInterval(id);
  }, [hardware?.pull.status, loadHardware]);

  const save = async (body: Record<string, unknown>) => {
    try {
      setInfo(await api<ProvidersInfo>("POST", "/v1/ai/settings", body));
      window.dispatchEvent(new Event("malenia:models-changed"));
    } catch (reason) { setError(String(reason)); }
  };
  if (!connected) return <p className="muted">Маления запускается…</p>;
  if (!info) return error ? <div className="alert error">{error}</div> : <p className="muted"><LoaderCircle className="spin" size={14} /> Загрузка…</p>;
  const clouds = info.providers.filter(p => p.kind === "cloud" && p.id !== "custom");
  const server = info.providers.find(p => p.id === "malenia");
  const custom = info.providers.find(p => p.id === "custom");

  return <div className="settings-stack">
    {error ? <div className="alert error">{error}<button onClick={() => setError("")}><X size={14} /></button></div> : null}

    <LocalModels info={info} hardware={hardware} onRefresh={loadHardware} onSave={save} onError={setError} onOpenOwnModel={onOpenOwnModel} />

    <section className="card">
      <h3><Cloud size={17} /> Облачные модели</h3>
      <p className="muted">Облако умнее локальной модели и не нагружает компьютер. Из России без VPN работает <b>GigaChat</b>: он бесплатный, на год. Вставьте любой ключ — Маления сама поймёт, какой это сервис, и проверит его.</p>
      <KeyPaste providers={clouds} onChanged={setInfo} onError={setError} />
      <div className="provider-list">{clouds.map(provider => <ProviderCard key={provider.id} provider={provider} onChanged={setInfo} onError={setError} />)}</div>
    </section>

    <section className="card">
      <h3>Как Маления выбирает модель</h3>
      <div className="segmented" role="radiogroup" aria-label="Режим моделей">
        {MODES.map(mode => <button key={mode.id} role="radio" aria-checked={info.mode === mode.id} className={info.mode === mode.id ? "on" : ""} onClick={() => void save({ mode: mode.id })}>
          <b>{mode.title}</b><small>{mode.text}</small></button>)}
      </div>
      <label className="switch-row"><input type="checkbox" checked={info.learning} onChange={event => void save({ learning: event.target.checked })} />
        <span><b>Самообучение</b><small>Маления запоминает факты о вас и ваши поправки. Всё видно и удаляется в разделе «Память».</small></span></label>
      <label className="switch-row"><input type="checkbox" checked={info.auto_web} onChange={event => void save({ auto_web: event.target.checked })} />
        <span><b>Интернет-поиск по необходимости</b><small>Модель сама ищет свежие данные, когда это нужно для ответа.</small></span></label>
      <p className="muted small">Порядок сейчас: {info.order.map(id => info.providers.find(p => p.id === id)?.name ?? "Локальная модель").join(" → ")}</p>
    </section>

    <section className="card">
      <h3>Память разговора</h3>
      <p className="muted small">Сколько текста локальная модель держит в голове одновременно: правила, инструкции из базы, страницы Asgard и весь ваш разговор. Больше — лучше помнит длинный разбор, но нужно больше памяти компьютера и ответы медленнее.</p>
      <div className="segmented context-choice" role="radiogroup" aria-label="Память разговора">
        {CONTEXTS.map(option => <button key={String(option.id)} role="radio" aria-checked={(info.context ?? "auto") === option.id}
          className={(info.context ?? "auto") === option.id ? "on" : ""} onClick={() => void save({ context: option.id })}>
          <b>{option.id === "auto" && info.context_auto ? `Авто · сейчас ${info.context_auto / 1024}K` : option.title}</b><small>{option.text}</small></button>)}
      </div>
      {info.context === 32768 ? <p className="muted small">32K: если окно Малении станет белым или ответы будут очень медленными — верните «Авто» или 16K, либо выберите модель полегче.</p> : null}
    </section>

    <Workspace onError={setError} />

    {server ? <section className="card">
      <h3><Server size={17} /> Модель на другом компьютере</h3>
      <p className="muted">Если на этом компьютере мало памяти, включите «Сервер» на мощном компьютере с Маленией и введите здесь его адрес и ключ.</p>
      <ProviderCard provider={server} onChanged={setInfo} onError={setError} withUrl />
    </section> : null}
    {custom ? <details className="card"><summary>Свой OpenAI-совместимый сервер (LM Studio, vLLM…)</summary>
      <ProviderCard provider={custom} onChanged={setInfo} onError={setError} withUrl />
    </details> : null}
  </div>;
}

function KeyPaste({ providers, onChanged, onError }: { providers: ProviderInfo[]; onChanged: (info: ProvidersInfo) => void; onError: (text: string) => void }) {
  const [key, setKey] = useState("");
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const submit = async () => {
    const value = key.trim();
    if (!value) return;
    setBusy(true); setResult("");
    try {
      const detected = choice || (await api<{ provider: string | null }>("POST", "/v1/ai/detect-key", { key: value })).provider;
      if (!detected || detected === "malenia") { setResult("Не удалось определить сервис по ключу. Выберите его в списке рядом."); return; }
      onChanged(await api<ProvidersInfo>("POST", `/v1/ai/providers/${detected}`, { api_key: value }));
      const test = await api<{ ok: boolean; model?: string; error?: string }>("POST", `/v1/ai/providers/${detected}/test`);
      const name = providers.find(p => p.id === detected)?.name ?? detected;
      setResult(test.ok ? `✓ ${name} подключён. Модель: ${test.model}` : `${name}: ${errorText(test.error)}`);
      if (test.ok) { setKey(""); setChoice(""); }
    } catch (reason) { onError(String(reason)); } finally { setBusy(false); }
  };
  return <div className="key-paste">
    <div className="provider-form">
      <div className="key-input"><KeyRound size={14} /><input type="password" aria-label="Вставьте любой API-ключ" autoComplete="off" placeholder="Вставьте любой ключ: GigaChat, Gemini, Groq…" value={key} onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submit(); }} /></div>
      <select aria-label="Сервис ключа" value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="">Определить сам</option>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="primary" disabled={!key.trim() || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14} /> : null}Подключить</button>
    </div>
    {result ? <p className={result.startsWith("✓") ? "ok-text" : "bad-text"}>{result}</p> : null}
  </div>;
}

const errorText = (code?: string) => ({
  invalid_key: "ключ не подошёл", rate_limited: "лимит исчерпан, попробуйте позже", unavailable: "нет связи с сервисом",
  not_configured: "укажите адрес", region_blocked: "сервис недоступен из вашего региона (нужен VPN)",
  certificate: "не удалось проверить сертификат — установите сертификаты Минцифры (gosuslugi.ru/crt)",
  payment_required: "бесплатный лимит закончился",
} as Record<string, string>)[code ?? ""] ?? "не удалось проверить";

function ProviderCard({ provider, onChanged, onError, withUrl }: { provider: ProviderInfo; onChanged: (info: ProvidersInfo) => void; onError: (text: string) => void; withUrl?: boolean }) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.base_url);
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; models?: string[]; model?: string | null; error?: string } | null>(null);
  const guide = GUIDES[provider.id];
  const submit = async () => {
    setBusy(true); setTest(null);
    try {
      const body: Record<string, unknown> = {};
      if (key.trim()) body.api_key = key.trim();
      if (withUrl) body.base_url = url.trim();
      const info = await api<ProvidersInfo>("POST", `/v1/ai/providers/${provider.id}`, body);
      onChanged(info); setKey("");
      setTest(await api("POST", `/v1/ai/providers/${provider.id}/test`));
    } catch (reason) { onError(String(reason)); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { onChanged(await api<ProvidersInfo>("POST", `/v1/ai/providers/${provider.id}`, { api_key: null, enabled: false })); setTest(null); }
    catch (reason) { onError(String(reason)); }
  };
  const chooseModel = async (model: string) => {
    try { onChanged(await api<ProvidersInfo>("POST", `/v1/ai/providers/${provider.id}`, { model: model || null })); } catch (reason) { onError(String(reason)); }
  };
  return <div className={"provider" + (provider.enabled ? " active" : "")}>
    <div className="provider-head">
      <div><b>{provider.name}</b>{provider.enabled ? <span className="badge ok"><Check size={12} />Подключён</span> : null}<small>{provider.hint}</small></div>
      {guide ? <button className="link" aria-expanded={showGuide} onClick={() => setShowGuide(v => !v)}>Как получить ключ <ChevronDown size={12} /></button> : null}
    </div>
    {guide && showGuide ? <div className="guide">
      <ol>{guide.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      <button className="secondary" onClick={() => open(guide.url)}><ExternalLink size={13} />Открыть сайт</button>
    </div> : null}
    <div className="provider-form">
      {withUrl ? <input aria-label={`${provider.name}: адрес`} placeholder={provider.id === "malenia" ? "http://192.168.1.10:8766" : "http://localhost:1234/v1"} value={url} onChange={event => setUrl(event.target.value)} /> : null}
      <div className="key-input"><KeyRound size={14} /><input type="password" aria-label={`${provider.name}: ключ`} autoComplete="off"
        placeholder={provider.has_key ? "Ключ сохранён · введите новый, чтобы заменить" : provider.id === "malenia" ? "Ключ сопряжения mln-…" : "Вставьте API-ключ"}
        value={key} onChange={event => setKey(event.target.value)} /></div>
      <button className="primary" disabled={busy || (!key.trim() && !(withUrl && url.trim() !== provider.base_url) && !provider.has_key)} onClick={() => void submit()}>
        {busy ? <LoaderCircle className="spin" size={14} /> : null}{key.trim() || (withUrl && url !== provider.base_url) ? "Сохранить" : "Проверить"}</button>
      {provider.has_key ? <button className="secondary" onClick={() => void remove()}>Отключить</button> : null}
    </div>
    {test ? test.ok ? <div className="provider-test ok"><Check size={14} /> Работает. Модель: <b>{test.model}</b>
      {test.models && test.models.length > 1 ? <select aria-label="Модель" value={provider.model ?? ""} onChange={event => void chooseModel(event.target.value)}>
        <option value="">Авто (лучшая: {test.models[0]})</option>{test.models.map(model => <option key={model} value={model}>{model}</option>)}</select> : null}
    </div> : <div className="provider-test bad"><X size={14} /> {errorText(test.error)}</div> : null}
  </div>;
}

function useEngine() {
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(async () => {
    try { const state = await invoke<EngineState>("local_ai_engine"); setEngine(state); return state; } catch { return null; }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // The download runs in the app, not in this screen: keep showing its progress
  // after switching tabs and coming back.
  const busy = starting || !!engine?.installing;
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(id);
  }, [busy, refresh]);
  /** Install (first time, ~1.6 GB) and start. */
  const start = useCallback(async () => {
    setStarting(true);
    try { await invoke<string>("start_local_ai"); }
    finally { setStarting(false); await refresh(); }
  }, [refresh]);
  return { engine, starting: busy, start };
}

function LocalModels({ info, hardware, onRefresh, onSave, onError, onOpenOwnModel }: {
  info: ProvidersInfo; hardware: HardwareInfo | null; onRefresh: (refresh?: boolean) => Promise<void>;
  onSave: (body: Record<string, unknown>) => Promise<void>; onError: (text: string) => void; onOpenOwnModel?: () => void;
}) {
  const { engine, starting, start } = useEngine();
  const [showAll, setShowAll] = useState(false);
  const pull = hardware?.pull;
  const recommendation = hardware?.hardware.recommendation;
  const installed = hardware?.installed ?? [];
  const running = !!engine?.running || !!hardware?.ollama_running;
  const startEngine = async () => {
    try { await startOrWait(); await onRefresh(); } catch (reason) { onError(String(reason)); }
  };
  const download = async (model: string) => {
    try {
      if (!running) await start();
      await api("POST", "/v1/ai/local/pull", { model });
      await onRefresh();
    } catch (reason) { onError(String(reason)); }
  };
  const percent = pull && pull.total ? Math.round(pull.completed / pull.total * 100) : 0;
  const catalog = hardware?.hardware.catalog ?? [];
  const recommended = recommendation?.models[0];
  const sameTag = (name: string, tag: string) => name === tag || name === tag + ":latest";
  const isInstalled = (tag: string) => installed.some(name => sameTag(name, tag));
  const personal = installed.filter(name => /^malenia/.test(name));
  const others = installed.filter(name => !/^malenia/.test(name) && !catalog.some(item => sameTag(name, item.tag)));
  const current = info.local_model ?? installed[0] ?? null;
  const visible = showAll ? catalog : catalog.filter(item => item.tag === recommended || isInstalled(item.tag) || item.fit === "fast" || item.fit === "ok").slice(0, 7);
  const setupStatus = starting ? engine?.status ?? "" : "";
  const startOrWait = async () => { if (!engine?.installing) await start(); };
  const notInstalled = !!engine && !engine.installed;

  return <section className="card">
    <h3><HardDrive size={17} /> Локальная модель на этом компьютере</h3>
    {hardware ? <div className="hw">
      <div><Cpu size={16} /><span>ОЗУ<b>{hardware.hardware.ram_gb} ГБ</b></span></div>
      <div><HardDrive size={16} /><span>Видеокарта<b>{hardware.hardware.gpu ?? "—"}{hardware.hardware.vram_gb ? ` · ${hardware.hardware.vram_gb} ГБ` : ""}</b></span></div>
      <div><Check size={16} /><span>Профиль<b>{recommendation?.label}</b></span></div>
      <button className="icon-btn" title="Определить заново" aria-label="Определить оборудование заново" onClick={() => void onRefresh(true)}><RefreshCw size={14} /></button>
    </div> : <p className="muted">Определяем оборудование…</p>}
    {recommendation?.note ? <p className="note-box">{recommendation.note}</p> : null}

    <div className={"engine" + (running ? " on" : "")}>
      <span className={"dot" + (running ? " on" : "")} />
      <div><b>{running ? "Локальный движок работает" : notInstalled ? "Локальный движок не установлен" : "Локальный движок остановлен"}</b>
        <small>{starting ? (setupStatus || "Запускаем…") : running ? "Модели работают на этом компьютере без интернета." : notInstalled ? "Нужно один раз скачать около 1,6 ГБ (официальный Ollama). Потом он запускается сам вместе с Маленией." : "Запустится автоматически при следующем старте Малении."}</small>
      </div>
      {!running ? <button className="primary" disabled={starting} onClick={() => void startEngine()}>
        {starting ? <LoaderCircle className="spin" size={14} /> : notInstalled ? <Download size={14} /> : <Play size={14} />}
        {starting ? "Подождите…" : notInstalled ? "Установить (1,6 ГБ)" : "Запустить"}</button> : null}
    </div>
    {starting && /\d+%/.test(setupStatus) ? <div className="bar"><i style={{ width: (setupStatus.match(/(\d+)%/)?.[1] ?? "0") + "%" }} /></div> : null}

    {pull?.status === "running" ? <div className="pull"><span>Скачивается {pull.model}… {percent ? percent + "%" : ""}</span><div className="bar"><i style={{ width: percent + "%" }} /></div></div> : null}
    {pull?.status === "failed" ? <p className="bad-text">Не удалось скачать {pull.model}: {pull.error}</p> : null}

    <div className="model-list" aria-label="Модели">
      <div className={"model-row personal" + (current && personal.includes(current) ? " active" : "")}>
        <Sparkles size={18} />
        <div><b>Моя Маления</b><small>{personal.length ? `Ваша модель (${personal.join(", ")}): знает всё, чему вы её научили.` : "Ваша собственная модель на основе Gemma или Qwen: учится у вас и у ответов лучших моделей."}</small></div>
        {personal.length ? (current && personal.includes(current) ? <span className="badge ok"><Check size={12} />Используется</span>
          : <button className="secondary" onClick={() => void onSave({ local_model: personal[0] })}>Использовать</button>)
          : <button className="secondary" onClick={onOpenOwnModel}>Создать</button>}
      </div>
      {visible.map(item => {
        const has = isInstalled(item.tag);
        const active = has && !!current && sameTag(current, item.tag);
        const pulling = pull?.status === "running" && pull.model === item.tag;
        return <div className={"model-row" + (active ? " active" : "")} key={item.tag}>
          <div><b>{item.name}{item.tag === recommended ? <span className="badge rec">Рекомендуем</span> : null}</b>
            <small>{item.note} · ≈{item.size} ГБ · <span className={"fit " + FIT[item.fit].tone}>{FIT[item.fit].label}</span></small></div>
          {active ? <span className="badge ok"><Check size={12} />Используется</span>
            : has ? <button className="secondary" onClick={() => void onSave({ local_model: item.tag })}>Использовать</button>
            : <button className={item.tag === recommended ? "primary" : "secondary"} disabled={pull?.status === "running" || item.fit === "no"} onClick={() => void download(item.tag)}>
              {pulling ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}Скачать</button>}
        </div>;
      })}
      {others.map(name => <div className={"model-row" + (current === name ? " active" : "")} key={name}>
        <div><b>{name}</b><small>Установлена ранее</small></div>
        {current === name ? <span className="badge ok"><Check size={12} />Используется</span> : <button className="secondary" onClick={() => void onSave({ local_model: name })}>Использовать</button>}
      </div>)}
    </div>
    {catalog.length > visible.length || showAll ? <button className="link" onClick={() => setShowAll(v => !v)}>{showAll ? "Показать подходящие" : `Все модели (${catalog.length})`}</button> : null}
  </section>;
}

function Workspace({ onError }: { onError: (text: string) => void }) {
  const [path, setPath] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    api<{ path: string }>("GET", "/v1/assistant/workspace").then(result => { setPath(result.path ?? ""); setSaved(result.path ?? ""); }).catch(() => undefined);
  }, []);
  const save = async () => {
    try { const result = await api<{ path: string }>("POST", "/v1/assistant/workspace", { path }); setPath(result.path); setSaved(result.path); }
    catch (reason) { onError(String(reason)); }
  };
  return <section className="card">
    <h3><FolderOpen size={17} /> Что Маления делает сама</h3>
    <p className="muted">Сама: считает, ищет в интернете, сохраняет планы, учит навыки, читает файлы рабочей папки и Google-таблицы, открывает и запускает инвентаризацию. <b>С вашего подтверждения</b>: создаёт и меняет файлы, записывает в таблицы.</p>
    <label className="field">Рабочая папка (Маления видит только её)
      <div className="row tight"><input className="text-input" aria-label="Рабочая папка" value={path} onChange={event => setPath(event.target.value)} />
        <button className="secondary" disabled={!path.trim() || path === saved} onClick={() => void save()}>Сохранить</button></div>
    </label>
  </section>;
}
