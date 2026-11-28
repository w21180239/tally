import type { Evidence, HintInput, HintRule } from "../hint.ts";
import type { Money } from "../summary.ts";
import { isSelf, LISTED, percentText, residentUsdPerToken, usdText } from "./shared.ts";

/** Cutoff on an entry's portion of its own kind's attributed spend. */
export const COSTLY_SHARE = 0.2;
/** Floor on an entry's own attributed spend, in dollars: a large share of a small total is no finding. */
export const COSTLY_MIN_USD = 1;

type Row = { kind: "Skill" | "Plugin"; name: string; usd: number; share: number; note?: string };

// One kind at a time: entries whose share of that kind's total passes the cutoff.
function costly(kind: Row["kind"], entries: Array<{ name: string; usd: number; note?: string }>): Row[] {
  const total = entries.reduce((n, e) => n + e.usd, 0);
  if (total <= 0) return [];
  return entries
    .map((e) => ({ kind, name: e.name, usd: e.usd, share: e.usd / total, ...(e.note !== undefined && { note: e.note }) }))
    .filter((r) => r.share > COSTLY_SHARE && r.usd >= COSTLY_MIN_USD)
    .sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
}

const money = (by: Record<string, Money>): Array<{ name: string; usd: number }> => Object.entries(by).map(([name, m]) => ({ name, usd: m.usd }));

/**
 * What a plugin adds by itself: its listings (skill, agent and MCP schema tokens) in every main request, plus the requests of its own
 * skills and sub-agent types, which carry their outputs. The requests a plugin was merely loaded in are not its cost: an always-on plugin
 * would otherwise mirror the whole bill. MCP calls are left out (a calling request holds everything else the request did).
 */
function pluginOwn(i: HintInput): Array<{ name: string; usd: number; note: string }> {
  const perToken = residentUsdPerToken(i.summary, i.prices);
  const out: Array<{ name: string; usd: number; note: string }> = [];
  for (const p of i.plugins) {
    // A plugin never used is unused-plugin's finding, not a second one here.
    if (isSelf(p.name) || !p.used) continue;
    const ns = `${p.name.toLowerCase()}:`;
    const inNs = (k: string): boolean => k.toLowerCase().startsWith(ns);
    const listing = p.tokensPerRequest * perToken;
    let ran = 0;
    for (const [k, m] of Object.entries(i.summary.bySkill)) if (inNs(k)) ran += m.usd;
    for (const [k, byModel] of Object.entries(i.summary.bySubType)) if (inNs(k)) for (const m of Object.values(byModel)) ran += m.usd;
    const usd = listing + ran;
    if (usd > 0) out.push({ name: p.name, usd, note: `${usdText(listing)} listings in every request + ${usdText(ran)} in requests of its own skills and agents` });
  }
  return out;
}

export const costlyAttribution: HintRule = {
  id: "costly-attribution",
  run: (i) => {
    const skills = costly("Skill", money(i.summary.bySkill));
    const plugins = costly("Plugin", pluginOwn(i));
    const rows = [...skills, ...plugins].sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
    if (rows.length === 0) return [];
    // A request can involve a skill and a plugin together, so the kinds overlap; entries are not summed and the largest sets the amount.
    const top = rows[0]!;
    const usd = top.usd;
    const evidence: Evidence[] = rows.slice(0, LISTED).map((r) => ({
      label: `${r.kind} ${r.name}`,
      detail: r.kind === "Skill" ? `${usdText(r.usd)} in the requests it ran in, ${percentText(r.share)} of skill spend` : `${usdText(r.usd)} (${r.note}), ${percentText(r.share)} of plugin-owned spend`,
      kind: "text",
    }));
    const measures = [
      skills.length > 0 ? "A skill's figure is the cost of the requests it was active in, not the size of its text." : "",
      plugins.length > 0 ? "A plugin's figure is its own listings plus the requests of its own skills and agents, not the requests it was only loaded in." : "",
    ]
      .filter((s) => s !== "")
      .join(" ");
    return [
      {
        rule: "costly-attribution",
        title: "Cost concentrated in a few add-ons",
        usd,
        summary: `${rows.length === 1 ? `${top.kind} ${top.name} accounts for ${usdText(usd)}, over ${percentText(COSTLY_SHARE)} of all ${top.kind.toLowerCase()} spend` : `${rows.length} skills and plugins each pass ${percentText(COSTLY_SHARE)} of their kind's spend; the largest is ${usdText(usd)}`}. ${measures}`,
        action: "Start with the biggest entry and weigh its output against the tokens · run /usage for the attribution rows. Enable a plugin only for the projects that use it, trim the skill's steps, or trigger it less often.",
        evidence,
        short: `${top.kind.toLowerCase()} ${top.name} at ${percentText(top.share)} of its kind`,
      },
    ];
  },
};
