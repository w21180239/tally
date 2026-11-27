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
        summary: `${rows.length} installed ${rows.length === 1 ? "plugin saw" : "plugins saw"} no use in this span, yet ${rows.length === 1 ? "its" : "their"} skill, agent and MCP listings went out with every request, ${usdText(usd)} in all.`,
        action: "Disable or uninstall them with /plugin and re-enable per project where they are needed.",
        evidence: rows.slice(0, LISTED).map((r) => ({ label: r.p.name, detail: `${tokensText(r.p.tokensPerRequest)} tokens per request, ${usdText(r.usd)}`, kind: "text" as const })),
        short: `${rows.length} unused ${rows.length === 1 ? "plugin" : "plugins"}`,
      },
    ];
  },
};
