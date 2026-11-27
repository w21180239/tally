// The values tally keeps in `$.state`, as the engine's plugin contract.
// Mirrors LiveState in core/live-state.ts; keep the two in step.

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
  messageCount: number;
  compactions: number;
  lastWrite?: { ts: number; ttl: "5m" | "1h" };
  toolCalls: Record<string, number>;
  toolChars: Record<string, number>;
}

declare module "claude-code" {
  interface PluginState {
    tally: {
      live: Shaped<TallyLive>;
    };
  }
}
