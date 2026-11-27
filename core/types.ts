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

export type ToolUse = {
  name: string;
  mcpServer?: string;
  target?: string;
  command?: string;
  inputChars: number;
  /** tool_use id: pairs the call with its tool_result row. Absent in shards written before it existed. */
  id?: string;
  /** A Read with no offset, limit or pages. */
  whole?: boolean;
};

export type UsageRow = RawUsage & {
  synthetic: boolean;
  thinkingChars: number;
  replyChars: number;
  tools: ToolUse[];
  skill?: string;
  plugin?: string;
  effort?: string;
  /** Sub-agent type of the transcript the request came from; absent for main-session rows. */
  agentType?: string;
};

export type UserRow = {
  sessionId: string;
  ts: number;
  kind: "prompt" | "notice" | "compaction" | "toolResult";
  chars: number;
  toolUseId?: string;
  results?: { toolUseId: string; chars: number }[];
  /** The line came from a sub-agent transcript. */
  sidechain?: boolean;
  text?: string;
  /** Where a prompt line starts: transcript path and byte offset, so the full text can be fetched on demand. */
  fileKey?: string;
  offset?: number;
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

export type FileState = { size: number; mtimeMs: number; offset: number };
