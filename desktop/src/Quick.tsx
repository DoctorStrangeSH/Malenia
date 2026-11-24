import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, X } from "lucide-react";
import { api } from "./api";
import { Chat } from "./Chat";
import { Logo } from "./Logo";

/** Small always-on-top window opened with Alt+Space from anywhere in Windows. */
export function QuickApp() {
  const [connected, setConnected] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try { await api("GET", "/v1/ai/providers"); if (alive) setConnected(true); }
      catch { if (alive) window.setTimeout(() => void probe(), 1500); }
    };
    void probe();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".send.stop")) void invoke("hide_quick_window").catch(() => undefined);
      if (event.key.toLowerCase() === "n" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); setConversationId(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => { alive = false; window.removeEventListener("keydown", onKey); };
  }, []);
  const openInApp = () => {
    try { if (conversationId) localStorage.setItem("malenia:open-conversation", `${conversationId}|${Date.now()}`); } catch { /* storage unavailable */ }
    void invoke("show_main_window").catch(() => undefined);
    void invoke("hide_quick_window").catch(() => undefined);
  };
  return <div className="quick-shell">
    <header className="quick-head">
      <Logo size={22} /><b>Маления</b>
      <button className="link-btn" onClick={() => setConversationId(null)}>Новый чат</button>
      <span className="quick-spacer" />
      <button className="icon-btn tiny" title="Открыть в приложении" aria-label="Открыть в приложении" onClick={openInApp}><Maximize2 size={15} /></button>
      <button className="icon-btn tiny" title="Скрыть (Esc)" aria-label="Скрыть" onClick={() => void invoke("hide_quick_window").catch(() => undefined)}><X size={15} /></button>
    </header>
    <Chat compact connected={connected} conversationId={conversationId} onConversation={setConversationId} onChanged={() => undefined}
      instruction={null} onClearInstruction={() => undefined} onOpenSettings={openInApp} onOpenTools={openInApp} onUiAction={openInApp} />
  </div>;
}
