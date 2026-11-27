import { nearestSnapshot, residentTokens } from "../breakdown.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { LISTED, proxyNote, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

/** A server's resident schemas must cost at least this many dollars, and it must be called less than once per this many main requests. */
export const SCHEMA_MIN_USD = 1;
export const SCHEMA_REQUESTS_PER_CALL = 100;
/** Servers with fewer calls than this belong to unused-mcp-server. */
export const SCHEMA_MIN_CALLS = 1;

export const mcpSchemaHeavy: HintRule = {
  id: "mcp-schema-heavy",
  run: ({ summary, snaps, prices, live }) => {
    const near = nearestSnapshot(snaps, summary.to, live?.sessionId);
    const perToken = residentUsdPerToken(summary, prices);
    const requests = summary.main.requests;
    if (near === null || perToken <= 0) return [];
    const heavy = Object.entries(residentTokens(near.snap))
      .map(([server, tokens]) => ({ server, tokens, usd: tokens * perToken, calls: summary.byMcp[server]?.calls ?? 0 }))
      .filter((s) => s.usd >= SCHEMA_MIN_USD && s.calls >= SCHEMA_MIN_CALLS && s.calls * SCHEMA_REQUESTS_PER_CALL < requests)
      .sort((a, b) => b.usd - a.usd || (a.server < b.server ? -1 : 1));
    if (heavy.length === 0) return [];
    const usd = heavy.reduce((n, s) => n + s.usd, 0);
    const tokens = heavy.reduce((n, s) => n + s.tokens, 0);
    const evidence: Evidence[] = heavy.slice(0, LISTED).map((s) => ({ label: "MCP server", detail: `${s.server}: ${tokensText(s.tokens)} schema tokens, ${usdText(s.usd)}; ${s.calls} ${s.calls === 1 ? "call" : "calls"} in ${requests} requests`, kind: "text" }));
    evidence.push(...proxyNote(near));
    const n = heavy.length;
    return [
      {
        rule: "mcp-schema-heavy",
        title: "Bulky MCP tool schemas for rarely used servers",
        usd,
        summary: `${n} MCP ${n === 1 ? "server keeps" : "servers keep"} ${tokensText(tokens)} tokens of tool schemas loaded in every request but ${n === 1 ? "was" : "were"} called less than once in ${SCHEMA_REQUESTS_PER_CALL} requests. Carrying ${n === 1 ? "it" : "them"} cost ${usdText(usd)}.`,
        action: "Enable tool search so these schemas are fetched only when a task needs them, or disconnect the servers from sessions that never touch them.",
        evidence,
        short: `${n} MCP ${n === 1 ? "server" : "servers"} with rarely used schemas`,
      },
    ];
  },
};
