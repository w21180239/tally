// The values tally keeps in `$.state`, as the engine's plugin contract.
// Mirrors LiveState in core/live-state.ts, ViewState in engine/window.ts, Foot and Chart in view/data.ts; keep them in step.

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
}

export interface TallyFoot {
  contextTokens: number | null;
  contextWindow: number;
  compactAt: number | null;
  limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>;
  refillUsd: number | null;
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
    };
  }
}
