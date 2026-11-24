import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickApp } from "./Quick";
import { invoke } from "@tauri-apps/api/core";

// Heartbeat for the window watchdog: if the page dies (e.g. out of memory), the app reloads it.
if (window.location.hash !== "#quick") {
  const beat = () => { void invoke("ui_alive").catch(() => undefined); };
  beat();
  window.setInterval(beat, 5000);
}
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.hash === "#quick" ? <QuickApp /> : <App />}
  </React.StrictMode>,
);