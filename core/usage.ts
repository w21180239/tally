import type { Tokens } from "./types.ts";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Maps an API `usage` object to Tokens; without the cache_creation split, all writes count as 5m.
export function tokensOf(u: Record<string, any>): Tokens {
  const cc = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cw5m: cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
    cw1h: cc ? num(cc.ephemeral_1h_input_tokens) : 0,
  };
}
