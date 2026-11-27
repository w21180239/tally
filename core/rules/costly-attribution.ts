import type { Evidence, HintRule } from "../hint.ts";
import type { Money } from "../summary.ts";
import { LISTED, percentText, usdText } from "./shared.ts";

/** Fraction of its kind's attributed spend above which an entry is reported. */
export const COSTLY_SHARE = 0.2;

type Row = { kind: "Skill" | "Plugin"; name: string; usd: number; share: number };

// Entries of one kind over the share, judged against that kind's own total.
function costly(kind: Row["kind"], by: Record<string, Money>): Row[] {
  const total = Object.values(by).reduce((n, m) => n + m.usd, 0);
  if (total <= 0) return [];
  return Object.entries(by)
    .map(([name, m]) => ({ kind, name, usd: m.usd, share: m.usd / total }))
    .filter((r) => r.share > COSTLY_SHARE)
    .sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
}

export const costlyAttribution: HintRule = {
  id: "costly-attribution",
  run: ({ summary }) => {
    const skills = costly("Skill", summary.bySkill);
    const plugins = costly("Plugin", summary.byPlugin);
    const rows = [...skills, ...plugins].sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
    if (rows.length === 0) return [];
    // A request can carry a skill and a plugin at once, so the kinds overlap and entries are not added: the costliest sets the amount.
    const top = rows[0]!;
    const usd = top.usd;
    const evidence: Evidence[] = rows.slice(0, LISTED).map((r) => ({ label: `${r.kind} ${r.name}`, detail: `${usdText(r.usd)}, ${percentText(r.share)} of ${r.kind.toLowerCase()} spend`, kind: "text" }));
    return [
      {
        rule: "costly-attribution",
        title: "Skills and plugins behind the bill",
        usd,
        summary: `${rows.length === 1 ? `${top.kind} ${top.name} accounts` : `${rows.length} skills and plugins account`} for more than ${percentText(COSTLY_SHARE)} of the spend its kind carries: ${usdText(usd)} in all.`,
        action: "Check that each earns its keep: shorten a skill's instructions, restrict a plugin to the projects that use it, or invoke it less often.",
        evidence,
        short: `${top.kind.toLowerCase()} ${top.name} takes ${percentText(top.share)}`,
      },
    ];
  },
};
