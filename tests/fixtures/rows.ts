// Small row builders for the flow and cache-life tests. Opus prices: see fixtures/month.ts.
import type { Tokens, ToolUse, UsageRow, UserRow } from "../../core/types.ts";

export const MIN = 60_000;
export const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
/** cache-read price used by the flow tests: $1 per MTok. */
export const READ_USD = 1e-6;

export type Req = {
  id: string;
  session?: string;
  at: number;
  tokens?: Partial<Tokens>;
  tools?: ToolUse[];
  sidechain?: boolean;
  agentType?: string;
  cwd?: string;
};

export function req(s: Req): UsageRow {
  const row: UsageRow = {
    requestId: s.id,
    sessionId: s.session ?? "s",
    ts: T0 + s.at,
    model: "claude-opus-5-5",
    tokens: { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, ...s.tokens },
    fast: false,
    sidechain: s.sidechain === true,
    synthetic: false,
    thinkingChars: 0,
    replyChars: 0,
    tools: s.tools ?? [],
  };
  if (s.cwd) row.cwd = s.cwd;
  if (s.agentType) row.agentType = s.agentType;
  return row;
}

export const prompt = (at: number, chars: number, text = "hello", session = "s"): UserRow => ({ sessionId: session, ts: T0 + at, kind: "prompt", chars, text });
export const notice = (at: number, chars: number, session = "s"): UserRow => ({ sessionId: session, ts: T0 + at, kind: "notice", chars });
export const summary = (at: number, chars: number, session = "s"): UserRow => ({ sessionId: session, ts: T0 + at, kind: "compaction", chars });
export const result = (at: number, toolUseId: string, chars: number, session = "s", sidechain = false): UserRow => {
  const row: UserRow = { sessionId: session, ts: T0 + at, kind: "toolResult", chars, toolUseId, results: [{ toolUseId, chars }] };
  if (sidechain) row.sidechain = true;
  return row;
};
export const read = (id: string, target: string, whole = true): ToolUse => ({ name: "Read", id, target, inputChars: 10, ...(whole ? { whole: true } : {}) });
export const bash = (id: string, command: string): ToolUse => ({ name: "Bash", id, command, inputChars: 10 });
