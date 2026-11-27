import { nearestSnapshot, residentTokens } from "../breakdown.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { pluginServerName } from "../plugins.ts";
import { dayText, LISTED, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

export const unusedMcpServer: HintRule = {
  id: "unused-mcp-server",
  run: ({ summary, snaps, plugins, prices, live }) => {
    const near = nearestSnapshot(snaps, summary.to, live?.sessionId);
    const perToken = residentUsdPerToken(summary, prices);
    if (near === null || perToken <= 0) return [];
    // A server a named-unused plugin ships is that rule's cost already.
    const idlePlugins = plugins.filter((p) => !p.used).map((p) => pluginServerName(p.name, ""));
    const idle = Object.entries(residentTokens(near.snap))
      .filter(([server]) => (summary.byMcp[server]?.calls ?? 0) === 0 && !idlePlugins.some((prefix) => server.startsWith(prefix)))
      .map(([server, tokens]) => ({ server, tokens, usd: tokens * perToken }))
      .sort((a, b) => b.usd - a.usd || (a.server < b.server ? -1 : 1));
    if (idle.length === 0) return [];
    const usd = idle.reduce((n, s) => n + s.usd, 0);
    const evidence: Evidence[] = idle.slice(0, LISTED).map((s) => ({ label: s.server, detail: `${tokensText(s.tokens)} schema tokens per request, ${usdText(s.usd)}`, kind: "text" }));
    if (near.proxy) evidence.push({ label: "Estimate", detail: `based on the context snapshot from ${dayText(near.snap.ts)}`, kind: "text" });
    return [
      {
        rule: "unused-mcp-server",
        title: "Unused MCP tool schemas in context",
        usd,
        summary: `${usdText(usd)} went to carrying the tool schemas of ${idle.length} MCP ${idle.length === 1 ? "server" : "servers"} that made no calls in this span.`,
        action: "Drop these servers through /mcp when the work does not need them, or enable tool search so their schemas load on demand.",
        evidence,
        short: `${idle.length} MCP ${idle.length === 1 ? "server" : "servers"} with zero calls`,
      },
    ];
  },
};
