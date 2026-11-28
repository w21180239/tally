import type { Evidence, HintRule } from "../hint.ts";
import type { Money } from "../summary.ts";
import { LISTED, percentText, usdText } from "./shared.ts";

/** Cutoff on an entry's portion of its own kind's attributed spend. */
export const COSTLY_SHARE = 0.2;
/** Floor on an entry's own attributed spend, in dollars: a large share of a small total is no finding. */
export const COSTLY_MIN_USD = 1;

type Row = { kind: "Skill" | "Plugin"; name: string; usd: number; share: number };

// One kind at a time: entries whose share of that kind's total passes the cutoff.
function costly(kind: Row["kind"], by: Record<string, Money>): Row[] {
  const total = Object.values(by).reduce((n, m) => n + m.usd, 0);
  if (total <= 0) return [];
  return Object.entries(by)
    .map(([name, m]) => ({ kind, name, usd: m.usd, share: m.usd / total }))
    .filter((r) => r.share > COSTLY_SHARE && r.usd >= COSTLY_MIN_USD)
    .sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
}

export const costlyAttribution: HintRule = {
  id: "costly-attribution",
  run: ({ summary }) => {
    const skills = costly("Skill", summary.bySkill);
    const plugins = costly("Plugin", summary.byPlugin);
    const rows = [...skills, ...plugins].sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
    if (rows.length === 0) return [];
    // A request can involve a skill and a plugin together, so the kinds overlap; entries are not summed and the largest sets the amount.
    const top = rows[0]!;
    const usd = top.usd;
    const evidence: Evidence[] = rows.slice(0, LISTED).map((r) => ({ label: `${r.kind} ${r.name}`, detail: `${usdText(r.usd)}, ${percentText(r.share)} of ${r.kind.toLowerCase()} spend`, kind: "text" }));
    return [
      {
        rule: "costly-attribution",
        title: "Cost concentrated in a few add-ons",
        usd,
        summary: `${rows.length === 1 ? `Requests that ran under ${top.kind.toLowerCase()} ${top.name} cost ${usdText(usd)}, over ${percentText(COSTLY_SHARE)} of all ${top.kind.toLowerCase()} spend` : `${rows.length} skills and plugins each pass ${percentText(COSTLY_SHARE)} of their kind's spend; the largest is ${usdText(usd)}`}. The figure is the cost of the requests it was active in, not the size of its text.`,
        action: "Start with the biggest entry and weigh its output against the tokens · run /usage for the attribution rows. Enable a plugin only for the projects that use it, trim the skill's steps, or trigger it less often.",
        evidence,
        short: `${top.kind.toLowerCase()} ${top.name} at ${percentText(top.share)} of its kind`,
      },
    ];
  },
};
