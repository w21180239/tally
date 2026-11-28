import { nearestSnapshot, residentTokens } from "../breakdown.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { fold } from "../plugins.ts";
import { LISTED, proxyNote, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

/**
 * A server's resident schemas must cost at least this many dollars and pass this share of all spend (strictly over), and it must be called less than once per this many main requests.
 * The share scales the bar with spend: on a 30-day, $5.7k span one 1k-token server costs 0.3%; a 0.25% bar keeps a small server on a small bill reportable.
 */
export const SCHEMA_MIN_USD = 1;
export const SCHEMA_MIN_SHARE = 0.0025;
/** A server that is called at all must also cost this much per 30 days to carry (scaled down for a shorter window, never below SCHEMA_MIN_USD): a control tool used rarely is cheap by design. */
export const SCHEMA_MIN_USD_PER_30D = 25;
const DAY_MS = 86_400_000;
export const SCHEMA_REQUESTS_PER_CALL = 100;
/** Servers with fewer calls than this belong to unused-mcp-server. */
export const SCHEMA_MIN_CALLS = 1;

export const mcpSchemaHeavy: HintRule = {
  id: "mcp-schema-heavy",
  run: ({ summary, snaps, prices, live, plugins }) => {
    const near = nearestSnapshot(snaps, summary.to, live?.sessionId);
    const perToken = residentUsdPerToken(summary, prices);
    const requests = summary.main.requests;
    if (near === null || perToken <= 0 || summary.total.usd <= 0) return [];
    // A plugin's own tools (registered by a mod, so the wire name is the plugin's name) are no MCP server: the user cannot defer or disable them apart from the plugin.
    const modTools = new Set(plugins.map((p) => fold(p.name)));
    const floor = Math.max(SCHEMA_MIN_USD, (SCHEMA_MIN_USD_PER_30D * Math.min(30, (summary.to - summary.from) / DAY_MS)) / 30);
    const heavy = Object.entries(residentTokens(near.snap))
      .filter(([server]) => !modTools.has(fold(server)))
      .map(([server, tokens]) => ({ server, tokens, usd: tokens * perToken, calls: summary.byMcp[server]?.calls ?? 0 }))
      .filter((s) => s.usd >= floor &&s.usd / summary.total.usd > SCHEMA_MIN_SHARE && s.calls >= SCHEMA_MIN_CALLS && s.calls * SCHEMA_REQUESTS_PER_CALL < requests)
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
        summary: `${n} MCP ${n === 1 ? "server keeps" : "servers keep"} ${tokensText(tokens)} tokens of tool schemas loaded in every request (not deferred) but ${n === 1 ? "was" : "were"} called less than once in ${SCHEMA_REQUESTS_PER_CALL} requests. Carrying ${n === 1 ? "it" : "them"} cost ${usdText(usd)}.`,
        action: "Find out why they are not deferred (Claude Code defers MCP schemas by default) · check ENABLE_TOOL_SEARCH, alwaysLoad on the server, a gateway or an older model. Otherwise run /mcp disable <server> for projects that never touch it, or use the server's CLI (gh, aws) where it has one.",
        evidence,
        short: `${n} MCP ${n === 1 ? "server" : "servers"} with rarely used schemas`,
      },
    ];
  },
};
