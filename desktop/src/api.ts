import { invoke } from "@tauri-apps/api/core";

export type Method = "GET" | "POST" | "DELETE";

/** Call an assistant/AI/server route of the local agent through Rust. */
export function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return invoke<T>("agent_api", { method, path, body: body ?? null });
}

export type Source = { title: string; url: string };
export type AgentAction = {
  id: string; tool: string; summary: string; status: "pending" | "running" | "done" | "failed" | "cancelled" | "ui";
  arguments: Record<string, unknown>; result: ({ ui?: string; start?: boolean; error?: string } & Record<string, unknown>) | null;
};
export type Attachment = { name: string; mime: string; data: string; size: number };
export type ChatMessage = {
  id: string; conversation_id: string; role: "user" | "assistant"; content: string;
  created_at: string; provider: string | null; model: string | null; feedback: number;
  meta: {
    sources?: Source[]; learned?: { id: string; content: string }[]; private?: boolean;
    attachments?: { name: string; kind: "image" | "file"; size: number }[];
    actions?: AgentAction[]; skills_learned?: { id: string; title: string }[];
  };
};
export type Conversation = { id: string; title: string; created_at: string; updated_at: string };
export type ConversationDetail = Conversation & { messages: ChatMessage[] };
export type ChatReply = { conversation_id: string; user_message: ChatMessage; message: ChatMessage; provider: string; model: string };
export type Memory = { id: string; content: string; kind: "fact" | "preference" | "lesson"; source: string; score: number; uses: number; created_at: string };

export type ProviderInfo = {
  id: string; name: string; kind: "cloud" | "server"; hint: string; key_url: string;
  base_url: string; has_key: boolean; enabled: boolean; model: string | null;
};
export type ProvidersInfo = {
  mode: "auto" | "cloud" | "local"; learning: boolean; auto_web: boolean;
  local_model: string | null; providers: ProviderInfo[]; order: string[];
};
export type PullState = { status: "idle" | "running" | "done" | "failed"; model: string | null; completed: number; total: number; error: string | null };
export type CatalogModel = { tag: string; name: string; size: number; moe: boolean; note: string; fit: "fast" | "ok" | "slow" | "no" };
export type EngineState = { installed: boolean; running: boolean; installing?: boolean; status: string };
export type HardwareInfo = {
  hardware: { ram_gb: number; gpu: string | null; vram_gb: number; cpu_threads: number; os: string;
    recommendation: { tier: string; label: string; models: string[]; note: string }; catalog?: CatalogModel[] };
  installed: string[]; ollama_running: boolean; pull: PullState;
};
export type ServerStatus = {
  enabled: boolean; running: boolean; port: number; token: string; error: string | null;
  requests_served: number; addresses: { address: string; kind: "lan" | "tailscale" | "public"; url: string }[];
};

export const providerLabel = (provider: string | null | undefined): string =>
  ({ ollama: "Локальная модель", gigachat: "GigaChat", gemini: "Gemini", groq: "Groq", openrouter: "OpenRouter",
     cerebras: "Cerebras", malenia: "Сервер Малении", custom: "Свой сервер" } as Record<string, string>)[provider ?? ""] ?? (provider || "");

export type TrainingStats = { conversations: number; answers: number; liked: number; disliked: number; memories: number; lessons: number; skills: number; ready_for_finetune: boolean };
