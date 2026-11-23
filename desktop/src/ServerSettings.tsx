import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, LoaderCircle, RefreshCw, Server, X } from "lucide-react";
import { api, type ServerStatus } from "./api";

const KIND: Record<string, string> = { lan: "Локальная сеть", tailscale: "Tailscale (из любой сети)", public: "Публичный адрес" };

export function ServerSettings({ connected, onOpenModels }: { connected: boolean; onOpenModels: () => void }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const load = useCallback(async () => {
    try { setStatus(await api<ServerStatus>("GET", "/v1/server")); } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => { if (connected) void load(); }, [connected, load]);
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError("");
    try {
      if (enabled) await invoke<string>("start_local_ai").catch(() => undefined);
      setStatus(await api<ServerStatus>("POST", "/v1/server", { enabled }));
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const rotate = async () => {
    if (!window.confirm("Создать новый ключ? Другие компьютеры нужно будет переподключить.")) return;
    try { setStatus(await api<ServerStatus>("POST", "/v1/server/rotate-token")); } catch (reason) { setError(String(reason)); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); setCopied(text); setTimeout(() => setCopied(""), 1500); };
  if (!connected) return <p className="muted">Маления запускается…</p>;
  if (!status) return <p className="muted"><LoaderCircle className="spin" size={14} /> Загрузка…</p>;
  return <div className="settings-stack">
    {error ? <div className="alert error">{error}<button onClick={() => setError("")}><X size={14} /></button></div> : null}
    <section className="card">
      <h3><Server size={17} /> Этот компьютер как сервер</h3>
      <p className="muted">Включите на мощном компьютере. Его локальная модель станет доступна Малении на других ваших компьютерах — например, на рабочем ноутбуке, где мало памяти. Открывается только чат с моделью; файлы, браузер и настройки этого компьютера недоступны.</p>
      <label className="switch-row big"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />
        <span><b>{status.running ? "Сервер работает" : status.enabled ? "Сервер включён, но не запустился" : "Сервер выключен"}</b>
          <small>{status.running ? `Порт ${status.port} · обработано запросов: ${status.requests_served}` : "Windows может спросить разрешение для брандмауэра — разрешите для частных сетей."}</small></span></label>
      {status.error ? <p className="bad-text">Не удалось запустить: {status.error}</p> : null}
    </section>
    {status.enabled ? <section className="card">
      <h3>Как подключить другой компьютер</h3>
      <ol className="steps">
        <li>На другом компьютере откройте Маления → «Настройки» → «Модели ИИ» → «Модель на другом компьютере».</li>
        <li>Вставьте адрес:
          <div className="copy-list">{status.addresses.length ? status.addresses.map(item => <button key={item.url} onClick={() => copy(item.url)}>
            <span><b>{item.url}</b><small>{KIND[item.kind]}</small></span>{copied === item.url ? <Check size={14} /> : <Copy size={14} />}</button>) : <p className="muted">Сетевые адреса не найдены. Проверьте подключение к сети.</p>}</div></li>
        <li>Вставьте ключ сопряжения:
          <div className="copy-list"><button onClick={() => copy(status.token)}><span><b className="mono">{status.token}</b><small>Никому не передавайте</small></span>{copied === status.token ? <Check size={14} /> : <Copy size={14} />}</button></div>
          <button className="link" onClick={() => void rotate()}><RefreshCw size={12} /> Создать новый ключ</button></li>
        <li>Нажмите «Сохранить». В режиме «Приватно» запросы идут только сюда.</li>
      </ol>
      <div className="note-box"><b>Компьютеры в разных сетях?</b> (сервер дома, ноутбук в офисе) Установите бесплатный Tailscale на оба компьютера и войдите в один аккаунт. Тогда используйте адрес вида 100.x.x.x — соединение зашифровано и работает через интернет без настройки роутера.</div>
      <p className="muted small">Серверу нужна установленная локальная модель. <button className="link" onClick={onOpenModels}>Выбрать модель под это железо</button></p>
    </section> : null}
  </div>;
}
