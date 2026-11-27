import type { Tokens } from "./types.ts";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Maps an API `usage` object to Tokens; without the cache_creation split, all writes count as 5m, and with it any
// remainder of cache_creation_input_tokens over the split's parts counts as 5m too (as in core/live-state.ts).
export function tokensOf(u: Record<string, any>): Tokens {
  const cc = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  const e5 = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const e1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cw5m: cc ? e5 + Math.max(0, num(u.cache_creation_input_tokens) - e5 - e1) : num(u.cache_creation_input_tokens),
    cw1h: e1,
  };
}
