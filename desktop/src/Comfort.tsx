import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bug, Copy, Download, Keyboard, Power, RefreshCw, X } from "lucide-react";
import { api } from "./api";
import { downloadText } from "./Markdown";

type Status = { autostart: boolean; hotkey: string; version: string };
export type UpdateInfo = { available: boolean; current: string; version: string; notes: string };

/** Settings → System: start with Windows, hotkey, updates. */
export function Comfort({ onUpdate }: { onUpdate: (info: UpdateInfo | null) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [reporting, setReporting] = useState(false);
  useEffect(() => { invoke<Status>("comfort_status").then(setStatus).catch(() => undefined); }, []);
  const toggle = async () => {
    if (!status) return;
    try { setStatus({ ...status, autostart: await invoke<boolean>("set_autostart", { enabled: !status.autostart }) }); }
    catch (reason) { setMessage(String(reason)); }
  };
  const check = async () => {
    setChecking(true); setMessage("");
    try {
      const info = await invoke<UpdateInfo>("check_update");
      onUpdate(info.available ? info : null);
      setMessage(info.available ? `Доступна версия ${info.version}` : `Установлена последняя версия (${info.current})`);
    } catch (reason) { setMessage(String(reason)); } finally { setChecking(false); }
  };
  return <div className="comfort card">
    <h3>Удобство</h3>
    <label className="comfort-row"><Power size={16} /><span><b>Запускать вместе с Windows</b><small>Маления тихо стартует в трее и сразу готова к работе.</small></span>
      <input type="checkbox" role="switch" checked={!!status?.autostart} disabled={!status} onChange={() => void toggle()} /></label>
    <div className="comfort-row"><Keyboard size={16} /><span><b>Быстрый вопрос: {status?.hotkey || "Alt+Space"}</b><small>Окно чата поверх любой программы. Esc — скрыть. Закрытие главного окна оставляет Малению работать в трее.</small></span></div>
    <div className="comfort-row"><Download size={16} /><span><b>Обновления</b><small>Версия {status?.version ?? "—"}. Маления сама проверяет обновления при запуске.</small></span>
      <button className="secondary" disabled={checking} onClick={() => void check()}><RefreshCw size={14} className={checking ? "spin" : undefined} />Проверить</button></div>
    <div className="comfort-row"><Bug size={16} /><span><b>Что-то не работает?</b><small>Соберу отчёт о проблеме: версия, настройки моделей без ключей, последние ошибки. Тексты переписки в него не попадают.</small></span>
      <button className="secondary" onClick={() => setReporting(true)}>Сообщить о проблеме</button></div>
    {message ? <p className="comfort-note">{message}</p> : null}
    {reporting ? <ReportDialog version={status?.version ?? ""} onClose={() => setReporting(false)} /> : null}
  </div>;
}

function ReportDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const [what, setWhat] = useState("");
  const [report, setReport] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api("GET", "/v1/assistant/diagnostics").then(setReport).catch(reason => setReport({ error: String(reason) })); }, []);
  const text = () => `# Отчёт о проблеме Малении\n\nЧто случилось: ${what.trim() || "(не описано)"}\nПриложение: ${version}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  return <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal report-modal">
      <div className="modal-head"><div><small className="eyebrow">ОТЧЁТ</small><h2>Сообщить о проблеме</h2></div>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}><X size={16} /></button></div>
      <label>Что случилось и что вы делали перед этим?
        <textarea rows={4} value={what} onChange={event => setWhat(event.target.value)} placeholder="Например: нажал «Начать проверку», на 60-м заказе всё остановилось" /></label>
      <pre className="report-preview">{report ? JSON.stringify(report, null, 2).slice(0, 4000) : "Собираю сведения…"}</pre>
      <p className="hint">Скопируйте отчёт и пришлите его тому, кто помогает с Маленией (например, в чат со мной). Ключи и пароли в отчёт не попадают.</p>
      <div className="modal-foot"><button className="secondary" disabled={!report} onClick={() => downloadText("Маления-отчёт.md", text(), "text/markdown")}><Download size={14} />Сохранить файл</button>
        <button className="primary" disabled={!report} onClick={() => { void navigator.clipboard?.writeText(text()); setCopied(true); }}><Copy size={14} />{copied ? "Скопировано" : "Копировать отчёт"}</button></div>
    </div>
  </div>;
}

export function UpdateBanner({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const install = async () => {
    setBusy(true); setError("");
    try { await invoke("install_update"); } catch (reason) { setError(String(reason)); setBusy(false); }
  };
  return <div className="update-banner" role="status">
    <Download size={16} /><span><b>Доступна Маления {info.version}</b>{error ? <small className="bad-text">{error}</small> : <small>Обновление скачается и установится, Маления перезапустится.</small>}</span>
    <button className="primary" disabled={busy} onClick={() => void install()}>{busy ? "Скачиваю…" : "Обновить"}</button>
    <button className="secondary" disabled={busy} onClick={onClose}>Позже</button>
  </div>;
}
