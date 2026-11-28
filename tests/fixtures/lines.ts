// Synthetic transcript line builders.
const SID = "sess-1";
const TS = "2026-01-02T03:04:05.000Z";
const j = (o: unknown) => JSON.stringify(o);

export function assistant(o: {
  requestId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  content?: unknown[];
  extra?: Record<string, unknown>;
} = {}): string {
  return j({
    type: "assistant",
    sessionId: SID,
    timestamp: TS,
    cwd: "/work/demo",
    requestId: o.requestId ?? "req-1",
    message: {
      model: o.model ?? "claude-test-1",
      usage: o.usage ?? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      content: o.content ?? [],
    },
    ...o.extra,
  });
}

export function user(content: unknown, extra: Record<string, unknown> = {}): string {
  return j({ type: "user", sessionId: SID, timestamp: TS, message: { role: "user", content }, ...extra });
}

export function toolResult(toolUseId: string, content: unknown): string {
  return user([{ type: "tool_result", tool_use_id: toolUseId, content }]);
}

export function compactBoundary(compactMetadata?: unknown): string {
  return j({ type: "system", subtype: "compact_boundary", sessionId: SID, timestamp: TS, ...(compactMetadata !== undefined && { compactMetadata }) });
}

export function meta(type: string, fields: Record<string, unknown>): string {
  return j({ type, sessionId: SID, ...fields });
}

export const SESSION = SID;
export const TIME = Date.parse(TS);
