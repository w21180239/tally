import type { Evidence, HintRule, LimitWindow } from "../hint.ts";
import { durationText } from "./shared.ts";

/** Window usage strictly above this percent is reported. */
export const NEAR_LIMIT_PERCENT = 80;

type Row = { label: string; short: string; window: LimitWindow };

export const nearLimit: HintRule = {
  id: "near-limit",
  run: ({ limits, nowMs }) => {
    if (limits === undefined) return [];
    const rows: Row[] = [];
    if (limits.fiveHour !== undefined) rows.push({ label: "5-hour window", short: "5h", window: limits.fiveHour });
    if (limits.sevenDay !== undefined) rows.push({ label: "7-day window", short: "7d", window: limits.sevenDay });
    // A window past its reset is stale; one with no reset time is kept, since nothing can expire it.
    const near = rows.filter((r) => r.window.percentUsed > NEAR_LIMIT_PERCENT && (r.window.resetsAt === undefined || r.window.resetsAt > nowMs));
    if (near.length === 0) return [];
    const evidence: Evidence[] = near.map((r) => ({ label: r.label, detail: `${Math.round(r.window.percentUsed)}% consumed${r.window.resetsAt === undefined ? "" : `; ${durationText(r.window.resetsAt - nowMs)} until reset`}`, kind: "text" }));
    const worst = near.reduce((a, b) => (b.window.percentUsed > a.window.percentUsed ? b : a));
    return [
      {
        rule: "near-limit",
        title: "Rate-limit window almost spent",
        usd: 0,
        urgent: true,
        summary: `${worst.label}: ${Math.round(worst.window.percentUsed)}% used. Requests stop at 100% until the window rolls over.`,
        action: "Anything that can wait until the reset (big refactors, parallel agents) should; until then, use a cheaper model for routine steps.",
        evidence,
        short: `${worst.short} window ${Math.round(worst.window.percentUsed)}% used`,
      },
    ];
  },
};
