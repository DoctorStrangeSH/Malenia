import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Cloud, Cpu, ExternalLink, FolderOpen, HardDrive, KeyRound, LoaderCircle, RefreshCw, Server, X } from "lucide-react";
import { api, type HardwareInfo, type ProviderInfo, type ProvidersInfo } from "./api";

const open = (url: string) => { void invoke("open_search_source", { url }).catch(() => undefined); };
const MODES: { id: ProvidersInfo["mode"]; title: string; text: string }[] = [
  { id: "auto", title: "Авто", text: "Облако, при сбое — ваш сервер или локальная модель" },
  { id: "cloud", title: "Только облако", text: "Максимум качества, нужен интернет" },
  { id: "local", title: "Только свои компьютеры", text: "Данные не уходят в интернет" },
];

export function AiSettings({ connected }: { connected: boolean }) {
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
  useEffect(() => {
    if (hardware?.pull.status !== "running") return;
    const id = window.setInterval(() => void loadHardware(), 1500);
    return () => window.clearInterval(id);
  }, [hardware?.pull.status, loadHardware]);

  const save = async (body: Record<string, unknown>) => {
    try { setInfo(await api<ProvidersInfo>("POST", "/v1/ai/settings", body)); } catch (reason) { setError(String(reason)); }
  };
  if (!connected) return <p className="muted">Маления запускается…</p>;
  if (!info) return error ? <div className="alert error">{error}</div> : <p className="muted"><LoaderCircle className="spin" size={14} /> Загрузка…</p>;
  const clouds = info.providers.filter(p => p.kind === "cloud" && p.id !== "custom");
  const server = info.providers.find(p => p.id === "malenia");
  const custom = info.providers.find(p => p.id === "custom");

  return <div className="settings-stack">
    {error ? <div className="alert error">{error}<button onClick={() => setError("")}><X size={14} /></button></div> : null}
    <section className="card">
      <h3>Какие модели использовать</h3>
      <div className="segmented" role="radiogroup" aria-label="Режим моделей">
        {MODES.map(mode => <button key={mode.id} role="radio" aria-checked={info.mode === mode.id} className={info.mode === mode.id ? "on" : ""} onClick={() => void save({ mode: mode.id })}>
          <b>{mode.title}</b><small>{mode.text}</small></button>)}
      </div>
      <label className="switch-row"><input type="checkbox" checked={info.learning} onChange={event => void save({ learning: event.target.checked })} />
        <span><b>Самообучение</b><small>Шерлок запоминает факты о вас и ваши поправки. Всё видно и удаляется в разделе «Память».</small></span></label>
      <label className="switch-row"><input type="checkbox" checked={info.auto_web} onChange={event => void save({ auto_web: event.target.checked })} />
        <span><b>Интернет-поиск по необходимости</b><small>Модель сама ищет свежие данные, когда это нужно для ответа.</small></span></label>
      <p className="muted small">Порядок сейчас: {info.order.map(id => info.providers.find(p => p.id === id)?.name ?? "Локальная модель").join(" → ")}</p>
    </section>

    <Workspace onError={setError} />

    <section className="card">
      <h3><Cloud size={17} /> Бесплатные облачные модели</h3>
      <p className="muted">Достаточно одного ключа. Если добавить несколько, при исчерпании лимита Шерлок переключится на следующий. Лучшая доступная модель выбирается автоматически.</p>
      <div className="provider-list">{clouds.map(provider => <ProviderCard key={provider.id} provider={provider} onChanged={setInfo} onError={setError} />)}</div>
    </section>

    <LocalModels info={info} hardware={hardware} onRefresh={loadHardware} onSave={save} onError={setError} />

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

function ProviderCard({ provider, onChanged, onError, withUrl }: { provider: ProviderInfo; onChanged: (info: ProvidersInfo) => void; onError: (text: string) => void; withUrl?: boolean }) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.base_url);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; models?: string[]; model?: string | null; error?: string } | null>(null);
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
  const errorText = (code?: string) => ({ invalid_key: "Ключ не подошёл", rate_limited: "Лимит исчерпан, попробуйте позже", unavailable: "Нет связи", not_configured: "Укажите адрес" } as Record<string, string>)[code ?? ""] ?? "Не удалось проверить";
  return <div className={"provider" + (provider.enabled ? " active" : "")}>
    <div className="provider-head">
      <div><b>{provider.name}</b>{provider.enabled ? <span className="badge ok"><Check size={12} />Подключён</span> : null}<small>{provider.hint}</small></div>
      {provider.key_url ? <button className="link" onClick={() => open(provider.key_url)}>Получить ключ <ExternalLink size={12} /></button> : null}
    </div>
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

function LocalModels({ info, hardware, onRefresh, onSave, onError }: { info: ProvidersInfo; hardware: HardwareInfo | null; onRefresh: (refresh?: boolean) => Promise<void>; onSave: (body: Record<string, unknown>) => Promise<void>; onError: (text: string) => void }) {
  const [starting, setStarting] = useState(false);
  const pull = hardware?.pull;
  const recommendation = hardware?.hardware.recommendation;
  const startEngine = async () => {
    setStarting(true);
    try { await invoke<string>("start_local_ai"); await onRefresh(); }
    catch (reason) { onError(String(reason)); } finally { setStarting(false); }
  };
  const download = async (model?: string) => {
    try {
      if (!hardware?.ollama_running) await invoke<string>("start_local_ai");
      await api("POST", "/v1/ai/local/pull", model ? { model } : {});
      await onRefresh();
    } catch (reason) { onError(String(reason)); }
  };
  const percent = pull && pull.total ? Math.round(pull.completed / pull.total * 100) : 0;
  return <section className="card">
    <h3><HardDrive size={17} /> Локальная модель на этом компьютере</h3>
    {hardware ? <div className="hw">
      <div><Cpu size={16} /><span>ОЗУ<b>{hardware.hardware.ram_gb} ГБ</b></span></div>
      <div><HardDrive size={16} /><span>Видеокарта<b>{hardware.hardware.gpu ?? "—"}{hardware.hardware.vram_gb ? ` · ${hardware.hardware.vram_gb} ГБ` : ""}</b></span></div>
      <div><Check size={16} /><span>Профиль<b>{recommendation?.label}</b></span></div>
      <button className="icon-btn" title="Определить заново" aria-label="Определить оборудование заново" onClick={() => void onRefresh(true)}><RefreshCw size={14} /></button>
    </div> : <p className="muted">Определяем оборудование…</p>}
    {recommendation?.note ? <p className="note-box">{recommendation.note}</p> : null}
    {hardware && !hardware.ollama_running ? <button className="secondary" disabled={starting} onClick={() => void startEngine()}>{starting ? <LoaderCircle className="spin" size={14} /> : null}Запустить локальный движок</button> : null}
    {hardware?.installed.length ? <label className="field">Модель по умолчанию
      <select value={info.local_model ?? ""} onChange={event => void onSave({ local_model: event.target.value || null })}>
        <option value="">Авто ({hardware.installed[0]})</option>
        {hardware.installed.map(model => <option key={model} value={model}>{model}</option>)}
      </select></label> : null}
    {pull?.status === "running" ? <div className="pull"><span>Скачивается {pull.model}… {percent ? percent + "%" : ""}</span><div className="bar"><i style={{ width: percent + "%" }} /></div></div>
      : <div className="row">
        <button className="primary" onClick={() => void download()}>Скачать рекомендованную{recommendation ? ` (${recommendation.models[0]})` : ""}</button>
        {recommendation && recommendation.models.length > 1 ? <select aria-label="Другая модель" defaultValue="" onChange={event => { if (event.target.value) void download(event.target.value); }}>
          <option value="">Другая модель…</option>{recommendation.models.slice(1).map(model => <option key={model} value={model}>{model}</option>)}</select> : null}
      </div>}
    {pull?.status === "failed" ? <p className="bad-text">Не удалось скачать: {pull.error}</p> : null}
    {pull?.status === "done" ? <p className="ok-text">Модель {pull.model} установлена.</p> : null}
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
