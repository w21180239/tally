export type Tokens = { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number };

export type RawUsage = {
  requestId: string;
  sessionId: string;
  ts: number;
  model: string;
  tokens: Tokens;
  fast: boolean;
  sidechain: boolean;
  cwd?: string;
};

export type ToolUse = { name: string; mcpServer?: string; target?: string; command?: string; inputChars: number };

export type UsageRow = RawUsage & {
  synthetic: boolean;
  thinkingChars: number;
  replyChars: number;
  tools: ToolUse[];
  skill?: string;
  plugin?: string;
  effort?: string;
};

export type UserRow = {
  sessionId: string;
  ts: number;
  kind: "prompt" | "notice" | "compaction" | "toolResult";
  chars: number;
  toolUseId?: string;
  text?: string;
};

export type MetaRow = {
  sessionId: string;
  key: "custom-title" | "ai-title" | "agent-name" | "last-prompt" | "pr-link" | "cost-state";
  value: unknown;
};

export type CompactRow = { sessionId: string; ts: number };

export type Parsed =
  | { t: "usage"; row: UsageRow }
  | { t: "user"; row: UserRow }
  | { t: "meta"; row: MetaRow }
  | { t: "compact"; row: CompactRow };

export type FileCtx = { path: string; isSub: boolean; agentType?: string; repo: string };
