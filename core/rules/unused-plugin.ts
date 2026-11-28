import type { HintRule } from "../hint.ts";
import { LISTED, isSelf, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

const ELSEWHERE_LISTED = 3;

export const unusedPlugin: HintRule = {
  id: "unused-plugin",
  run: ({ summary, plugins, prices }) => {
    const perToken = residentUsdPerToken(summary, prices);
    const idle = plugins.filter((p) => !p.used && p.tokensPerRequest > 0 && !isSelf(p.name));
    if (idle.length === 0 || perToken <= 0) return [];
    const rows = idle.map((p) => ({ p, usd: p.tokensPerRequest * perToken })).sort((a, b) => b.usd - a.usd || (a.p.name < b.p.name ? -1 : 1));
    const usd = rows.reduce((n, r) => n + r.usd, 0);
    // A plugin another repo did use belongs to that repo alone: name it and the project-scoped install.
    const elsewhere = rows.filter((r) => r.p.usedIn !== undefined);
    const move = elsewhere
      .slice(0, ELSEWHERE_LISTED)
      .map((r) => `${r.p.name} was used in ${r.p.usedIn!.join(", ")}: disable it here and run \`claude plugin install ${r.p.name} -s project\` in ${r.p.usedIn!.length === 1 ? "that repo" : "each of them"}`)
      .join("; ");
    return [
      {
        rule: "unused-plugin",
        title: "Plugins adding context without being used",
        usd,
        summary: `${usdText(usd)} went to carrying the skill, agent and MCP listings of ${rows.length} installed ${rows.length === 1 ? "plugin" : "plugins"} that never got used${elsewhere.length > 0 ? " here (some are used in other repos)" : ""}.`,
        action: `Switch them off · open /plugin, or enable a plugin in the one project that needs it.${move === "" ? "" : ` ${move}.`} /skill-doctor lists each skill's cost and use.`,
        evidence: rows.slice(0, LISTED).map((r) => ({ label: r.p.name, detail: `${tokensText(r.p.tokensPerRequest)} tokens per request, ${usdText(r.usd)}${r.p.usedIn === undefined ? "" : `; used in ${r.p.usedIn.join(", ")}`}`, kind: "text" as const })),
        short: `${rows.length} installed ${rows.length === 1 ? "plugin" : "plugins"} never used`,
      },
    ];
  },
};
