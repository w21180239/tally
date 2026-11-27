import type { Evidence, HintRule } from "../hint.ts";
import { LISTED, sessionsUsd, titleOf, usdText } from "./shared.ts";

/** Compactions of one session within the span from which it is reported. */
export const REPEAT_MIN = 3;

export const repeatCompaction: HintRule = {
  id: "repeat-compaction",
  run: ({ summary }) => {
    const repeated = Object.entries(summary.compactions)
      .filter(([, n]) => n >= REPEAT_MIN)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (repeated.length === 0) return [];
    // The sessions' own spend: what compacting over and over sat on top of.
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
        title: "Long sessions keep compacting",
        usd,
        summary: `${repeated.length} ${repeated.length === 1 ? "session was" : "sessions were"} compacted at least ${REPEAT_MIN} times. Every compaction drops detail, rewrites the cache and leaves a recap that later requests re-read${usd > 0 ? `; these sessions cost ${usdText(usd)}` : ""}.`,
        action: "Wrap up at a clean stopping point and open a new session with a short brief, or give the long task to sub-agents that begin with empty contexts.",
        evidence,
        short: `${repeated.length} ${repeated.length === 1 ? "session" : "sessions"} compacted ${REPEAT_MIN}+ times`,
      },
    ];
  },
};
