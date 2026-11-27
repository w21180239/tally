// The values tally keeps in `$.state`, as the engine's plugin contract.
// Mirrors LiveState in core/live-state.ts, ViewState in engine/window.ts, Foot and Chart in view/data.ts, SessionData in engine/session-view.ts, UsageData in engine/usage-view.ts; keep them in step.

export interface TallyTokens {
  input: number;
  output: number;
  cacheRead: number;
  cw5m: number;
  cw1h: number;
}

export interface TallyAgentLive {
  id: string;
  type: string;
  description: string;
  model: string;
  context: number;
  peak: number;
  firstPrompt: string;
  tools: Record<string, number>;
  usd: number;
  lastTs: number;
}

export interface TallyLive {
  sessionId: string;
  startedAt: number;
  restoredUsd: number;
  main: TallyTokens & { usd: number };
  agents: Record<string, TallyAgentLive>;
  other: { usd: number; tokens: TallyTokens; requests: number };
  stepped: Record<string, { usd: number; tokens: TallyTokens; requests: number }>;
  messageCount: number;
  compactions: number;
  lastWrite?: { ts: number; ttl: "5m" | "1h" };
  toolCalls: Record<string, number>;
  toolChars: Record<string, number>;
  activeMs: number;
  mainModels: Record<string, number>;
  restored: Record<string, { usd: number; tokens: TallyTokens; requests: number }>;
  restoredSub: Record<string, number>;
  otherByModel: Record<string, number>;
}

export interface TallyView {
  mode: "closed" | "open" | "folded";
  tab: "session" | "usage" | "context" | "history" | "hints" | "help";
  span: "session" | "24h" | "30d";
  repoOnly: boolean;
  machines: "this" | "all";
  hasSent: boolean;
  hasWarned: boolean;
  hasTipped: boolean;
  more: boolean;
  agent: string;
  listing: boolean;
  full: boolean;
  shown: string[];
}

export interface TallyFoot {
  contextTokens: number | null;
  contextWindow: number;
  compactAt: number | null;
  limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>;
  refillUsd: number | null;
}

export interface TallySession {
  sessionId: string;
  at: number;
  skills: Array<{ name: string; usd: number }>;
  mcp: Array<{ server: string; usd: number; schemaUsd: number; resultUsd: number; calls: number }>;
  snapshot: { ts: number; proxy: boolean } | null;
}

export interface TallyDetailRow {
  label: string;
  tokens: number;
  usd: number;
  estimated: boolean;
  full?: string;
  id?: string;
}

export interface TallyUsageSection {
  kind: "input" | "output" | "cacheRead" | "cacheWrite";
  total: { tokens: number; usd: number };
  rows: TallyDetailRow[];
  largest?: TallyDetailRow[];
}

export interface TallyUsage {
  key: string;
  at: number;
  requests: number;
  agents: Array<{ key: string; label: string; usd: number }>;
  by: Record<string, TallyUsageSection[]>;
  snapshot: { ts: number; proxy: boolean } | null;
  failure?: { key: string; why: string };
}

export interface TallyChart {
  values: number[];
  bands: number[];
}

declare module "claude-code" {
  interface PluginState {
    tally: {
      live: Shaped<TallyLive>;
      view: Shaped<TallyView>;
      foot: Shaped<TallyFoot>;
      chart: Shaped<TallyChart>;
      session: Shaped<TallySession>;
      usage: Shaped<TallyUsage>;
    };
  }
}
