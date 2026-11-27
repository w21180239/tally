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
    const evidence: Evidence[] = idle.slice(0, LISTED).map((s) => ({ label: s.server, detail: `${tokensText(s.tokens)} tokens of tool schemas per request, ${usdText(s.usd)}`, kind: "text" }));
    if (near.proxy) evidence.push({ label: "Estimate", detail: `from the context snapshot of ${dayText(near.snap.ts)}`, kind: "text" });
    return [
      {
        rule: "unused-mcp-server",
        title: "MCP servers nobody called",
        usd,
        summary: `${idle.length} MCP ${idle.length === 1 ? "server made" : "servers made"} no calls, yet ${idle.length === 1 ? "its" : "their"} tool schemas were in every request's context, ${usdText(usd)} in all.`,
        action: "Disconnect them in /mcp, or enable deferred tool loading so a schema reaches the context only once Claude looks the tool up.",
        evidence,
        short: `${idle.length} unused MCP ${idle.length === 1 ? "server" : "servers"}`,
      },
    ];
  },
};
