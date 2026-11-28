import type { HintRule } from "../hint.ts";
import { LISTED, isSelf, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

export const unusedPlugin: HintRule = {
  id: "unused-plugin",
  run: ({ summary, plugins, prices }) => {
    const perToken = residentUsdPerToken(summary, prices);
    const idle = plugins.filter((p) => !p.used && p.tokensPerRequest > 0 && !isSelf(p.name));
    if (idle.length === 0 || perToken <= 0) return [];
    const rows = idle.map((p) => ({ p, usd: p.tokensPerRequest * perToken })).sort((a, b) => b.usd - a.usd || (a.p.name < b.p.name ? -1 : 1));
    const usd = rows.reduce((n, r) => n + r.usd, 0);
    return [
      {
        rule: "unused-plugin",
        title: "Plugins adding context without being used",
        usd,
        summary: `${usdText(usd)} went to carrying the skill, agent and MCP listings of ${rows.length} installed ${rows.length === 1 ? "plugin" : "plugins"} that never got used.`,
        action: "Open /plugin to switch these off; a plugin that only one project needs can be enabled in that project alone.",
        evidence: rows.slice(0, LISTED).map((r) => ({ label: r.p.name, detail: `${tokensText(r.p.tokensPerRequest)} tokens per request, ${usdText(r.usd)}`, kind: "text" as const })),
        short: `${rows.length} installed ${rows.length === 1 ? "plugin" : "plugins"} never used`,
      },
    ];
  },
};
