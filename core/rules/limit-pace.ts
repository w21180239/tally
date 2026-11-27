import type { Evidence, HintRule } from "../hint.ts";
import { durationText } from "./shared.ts";

/** Share of a window that must have elapsed before its pace says anything; earlier readings swing too much. */
export const MIN_ELAPSED_SHARE = 0.05;

const HOUR = 3_600_000;
const WINDOWS = [
  { key: "fiveHour", label: "5-hour window", short: "5h", length: 5 * HOUR },
  { key: "sevenDay", label: "7-day window", short: "7d", length: 7 * 24 * HOUR },
] as const;

export const limitPace: HintRule = {
  id: "limit-pace",
  run: ({ limits, nowMs }) => {
    if (limits === undefined) return [];
    const rows: Array<{ label: string; short: string; percent: number; elapsed: number; fullIn: number; spare: number }> = [];
    for (const w of WINDOWS) {
      const win = limits[w.key];
      if (win?.resetsAt === undefined || win.resetsAt <= nowMs) continue;
      const elapsed = w.length - (win.resetsAt - nowMs);
      // Nothing to extrapolate from before the window has run a while, once it is full, or while it is untouched.
      if (elapsed < w.length * MIN_ELAPSED_SHARE || win.percentUsed <= 0 || win.percentUsed >= 100) continue;
      // Linear pace: percentUsed per elapsed time reaches 100 before the window ends iff percentUsed / elapsed > 100 / length.
      if (win.percentUsed * w.length <= 100 * elapsed) continue;
      const fullIn = elapsed * (100 / win.percentUsed - 1);
      rows.push({ label: w.label, short: w.short, percent: win.percentUsed, elapsed, fullIn, spare: win.resetsAt - nowMs - fullIn });
    }
    if (rows.length === 0) return [];
    rows.sort((a, b) => a.fullIn - b.fullIn);
    const first = rows[0]!;
    const evidence: Evidence[] = rows.map((r) => ({
      label: r.label,
      detail: `${Math.round(r.percent)}% used, ${durationText(r.elapsed)} into the window; full in ${durationText(r.fullIn)}, ${durationText(r.spare)} before the reset`,
      kind: "text",
    }));
    return [
      {
        rule: "limit-pace",
        title: "Rate limit on course to run out",
        usd: 0,
        urgent: true,
        summary: `At the pace of the ${first.label} so far, usage reaches 100% in ${durationText(first.fullIn)}, ${durationText(first.spare)} ahead of its reset.`,
        action: "Hold the heavy jobs (parallel agents, large refactors) until the reset, or run routine steps on a cheaper model so the remaining allowance lasts.",
        evidence,
        short: `${first.short} limit full in ${durationText(first.fullIn)}`,
      },
    ];
  },
};
