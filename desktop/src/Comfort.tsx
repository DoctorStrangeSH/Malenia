import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Keyboard, Power, RefreshCw } from "lucide-react";

type Status = { autostart: boolean; hotkey: string; version: string };
export type UpdateInfo = { available: boolean; current: string; version: string; notes: string };

/** Settings → System: start with Windows, hotkey, updates. */
export function Comfort({ onUpdate }: { onUpdate: (info: UpdateInfo | null) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
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
    {message ? <p className="comfort-note">{message}</p> : null}
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
