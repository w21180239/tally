import type { SwitchBreak } from "../cache-life.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { dayText, LISTED, shortModel, tokensText, usdText } from "./shared.ts";

/** Floor on what the rewrites after switches cost over reading the same prompt from a warm cache, in dollars. */
export const SWITCH_MIN_USD = 1;

const WHAT = { model: "model", fast: "speed", effort: "effort" } as const;
const name = (b: SwitchBreak, v: string): string => (b.kind === "model" ? shortModel(v) : v);

export const midSessionSwitch: HintRule = {
  id: "mid-session-switch",
  run: ({ summary }) => {
    const breaks = summary.cacheBreaks ?? [];
    const usd = breaks.reduce((n, b) => n + b.usd, 0);
    if (breaks.length === 0 || usd < SWITCH_MIN_USD) return [];
    const kinds = (["model", "fast", "effort"] as const).map((k) => ({ k, n: breaks.filter((b) => b.kind === k).length })).filter((x) => x.n > 0);
    const worst = [...breaks].sort((a, b) => b.usd - a.usd || a.ts - b.ts).slice(0, LISTED);
    const evidence: Evidence[] = worst.map((b) => ({ label: `Switch of ${WHAT[b.kind]}`, detail: `${dayText(b.ts)}: ${name(b, b.from)} to ${name(b, b.to)}, ${tokensText(b.tokens)} tokens rewritten (${usdText(b.usd)} over a warm read)`, kind: "text" }));
    const n = breaks.length;
    return [
      {
        rule: "mid-session-switch",
        title: "Cache lost to a mid-session switch",
        usd,
        summary: `${n} ${n === 1 ? "switch" : "switches"} (${kinds.map((x) => `${x.n} of ${WHAT[x.k]}`).join(", ")}) made the next request write the whole prompt into the cache again instead of reading it, ${usdText(usd)} more than reading it warm. Each model and each speed keeps its own cache${kinds.some((x) => x.k === "effort") ? ", and on some models so does each effort level" : ""}.`,
        action: "Choose model, effort and fast mode at the start of a session · a change in the middle of a task re-reads the whole context uncached. Switch at a task boundary, after /compact or /clear, when the context is small.",
        evidence,
        short: `${n} cache ${n === 1 ? "rewrite" : "rewrites"} after a switch`,
      },
    ];
  },
};
