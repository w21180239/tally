import type { HintRule } from "../hint.ts";
import { LISTED, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

export const unusedPlugin: HintRule = {
  id: "unused-plugin",
  run: ({ summary, plugins, prices }) => {
    const perToken = residentUsdPerToken(summary, prices);
    const idle = plugins.filter((p) => !p.used && p.tokensPerRequest > 0);
    if (idle.length === 0 || perToken <= 0) return [];
    const rows = idle.map((p) => ({ p, usd: p.tokensPerRequest * perToken })).sort((a, b) => b.usd - a.usd || (a.p.name < b.p.name ? -1 : 1));
    const usd = rows.reduce((n, r) => n + r.usd, 0);
    return [
      {
        rule: "unused-plugin",
        title: "Plugins loaded but unused",
        usd,
        summary: `${rows.length} installed ${rows.length === 1 ? "plugin stayed" : "plugins stayed"} idle throughout, while ${rows.length === 1 ? "its" : "their"} skill, agent and MCP listings rode along in every request: ${usdText(usd)} in all.`,
        action: "Turn them off in /plugin and switch them back on only in the projects that need them.",
        evidence: rows.slice(0, LISTED).map((r) => ({ label: r.p.name, detail: `${tokensText(r.p.tokensPerRequest)} tokens per request, ${usdText(r.usd)}`, kind: "text" as const })),
        short: `${rows.length} idle ${rows.length === 1 ? "plugin" : "plugins"} loaded`,
      },
    ];
  },
};
