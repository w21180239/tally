import type { Evidence, HintRule } from "../hint.ts";
import { LISTED, sessionsUsd, titleOf, usdText } from "./shared.ts";

/** A session needs at least this many compactions to be reported. */
export const REPEAT_MIN = 3;

export const repeatCompaction: HintRule = {
  id: "repeat-compaction",
  run: ({ summary }) => {
    const repeated = Object.entries(summary.compactions)
      .filter(([, n]) => n >= REPEAT_MIN)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (repeated.length === 0) return [];
    // Spend of those sessions: the base the repeated compactions sat on.
    const usd = sessionsUsd(summary, repeated.map(([id]) => id));
    const evidence: Evidence[] = [];
    for (const [id, n] of repeated.slice(0, LISTED)) {
      const title = titleOf(summary, id);
      if (title !== undefined && title !== "") evidence.push({ label: "Session", detail: title, kind: "title" });
      evidence.push({ label: "Compactions", detail: `${n} compactions`, kind: "text" });
    }
    return [
      {
        rule: "repeat-compaction",
        title: "Repeated compaction within sessions",
        usd,
        summary: `${repeated.length} ${repeated.length === 1 ? "session went" : "sessions went"} through ${REPEAT_MIN}+ compactions. Each drops detail and restarts the cache, and the recap it leaves is read back on every later request${usd > 0 ? ` (${usdText(usd)} spent in ${repeated.length === 1 ? "that session" : "those sessions"})` : ""}.`,
        action: "Break the job up: wrap up once a task finishes and open the next session from a short note, or give the long tasks to sub-agents, which each begin with an empty context.",
        evidence,
        short: `${repeated.length} ${repeated.length === 1 ? "session" : "sessions"} compacted ${REPEAT_MIN}+ times`,
      },
    ];
  },
};
