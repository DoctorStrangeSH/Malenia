import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Download, GraduationCap, LoaderCircle, Sparkles, X } from "lucide-react";
import { api, type HardwareInfo, type TrainingStats } from "./api";

export function OwnModel({ connected, onOpenModels }: { connected: boolean; onOpenModels: () => void }) {
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState<"" | "create" | "export">("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setStats((await api<{ stats: TrainingStats }>("GET", "/v1/assistant/training")).stats);
      const info = await api<HardwareInfo>("GET", "/v1/ai/hardware");
      setHardware(info);
      setBase(current => current || info.installed.find(m => !m.startsWith("sherlock")) || "");
    } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => { if (connected) void load(); }, [connected, load]);

  const create = async () => {
    setBusy("create"); setError(""); setNotice("");
    try {
      if (!hardware?.ollama_running) await invoke<string>("start_local_ai");
      const result = await api<{ model: string }>("POST", "/v1/ai/local/personal", { base });
      setNotice(`Готово: модель ${result.model} создана и выбрана локальной моделью по умолчанию.`);
      await load();
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const exportData = async () => {
    setBusy("export"); setError(""); setNotice("");
    try {
      const result = await api<{ path: string; examples: number }>("POST", "/v1/assistant/training/export");
      setNotice(`Выгружено примеров: ${result.examples}. Файл: ${result.path}`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const bases = (hardware?.installed ?? []).filter(model => !model.startsWith("sherlock"));
  const progress = stats ? Math.min(100, Math.round((stats.answers - stats.disliked) / 2)) : 0;

  return <div className="settings-stack">
    <p className="muted">Шерлок может быть вашей собственной моделью: открытая модель (Qwen, Gemma) плюс всё, чему вы его научили. Она работает на ваших компьютерах без интернета.</p>
    {error ? <div className="alert error">{error}<button onClick={() => setError("")}><X size={14} /></button></div> : null}
    {notice ? <div className="alert success"><Check size={15} />{notice}<button onClick={() => setNotice("")}><X size={14} /></button></div> : null}
    {stats ? <section className="card">
      <h3><GraduationCap size={17} /> Чему Шерлок уже научился</h3>
      <div className="stat-grid">
        <div><b>{stats.conversations}</b><span>диалогов</span></div>
        <div><b>{stats.liked}</b><span>👍 хороших ответов</span></div>
        <div><b>{stats.lessons}</b><span>уроков из поправок</span></div>
        <div><b>{stats.skills}</b><span>выученных навыков</span></div>
        <div><b>{stats.memories}</b><span>фактов о вас</span></div>
      </div>
      <p className="muted small">Учите его прямо в чате: «запомни, как я делаю…», «в следующий раз делай так», 👍/👎 с поправкой под ответами.</p>
    </section> : null}

    <section className="card">
      <h3><Sparkles size={17} /> Шаг 1. Моя модель — сразу, без видеокарты</h3>
      <p className="muted">Создаёт модель <b>sherlock-personal</b> на основе выбранной локальной модели. В неё встроены ваши факты, предпочтения, уроки и навыки. Пересоздавайте её, когда Шерлок узнает много нового.</p>
      {bases.length ? <div className="row">
        <select aria-label="Базовая модель" value={base} onChange={event => setBase(event.target.value)}>
          {bases.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
        <button className="primary" disabled={!base || busy !== ""} onClick={() => void create()}>{busy === "create" ? <LoaderCircle className="spin" size={14} /> : null}Создать мою модель</button>
      </div> : <p className="muted">Сначала установите локальную модель. <button className="link" onClick={onOpenModels}>Выбрать модель под это железо</button></p>}
    </section>

    <section className="card">
      <h3><GraduationCap size={17} /> Шаг 2. Дообучение на ваших диалогах</h3>
      <p className="muted">Модель перенимает ваш стиль и типичные задачи. Нужен компьютер с видеокартой NVIDIA (например, ваш сервер) или бесплатный Google Colab. Ответы с 👎 в обучение не попадают, а с 👍 учитываются вдвойне.</p>
      <div className="bar" title="Желательно 200+ оценённых ответов"><i style={{ width: progress + "%" }} /></div>
      <p className="muted small">{stats?.ready_for_finetune ? "Данных достаточно для дообучения." : `Собрано ${Math.max(0, (stats?.answers ?? 0) - (stats?.disliked ?? 0))} из ~200 желательных ответов. Выгрузить можно и сейчас.`}</p>
      <div className="row">
        <button className="secondary" disabled={busy !== ""} onClick={() => void exportData()}>{busy === "export" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}Выгрузить данные для обучения</button>
      </div>
      <ol className="steps small-steps">
        <li>Скопируйте выгруженный файл и <code>training/train_sherlock.py</code> из репозитория на компьютер с видеокартой или в Colab.</li>
        <li><code>pip install unsloth</code>, затем <code>python train_sherlock.py файл.jsonl</code> — 20–60 минут.</li>
        <li><code>ollama create sherlock -f sherlock-out/Modelfile</code> и выберите <b>sherlock</b> в «Модели ИИ».</li>
      </ol>
    </section>
  </div>;
}
