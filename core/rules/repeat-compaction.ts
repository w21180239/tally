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
        title: "Compaction loops in long sessions",
        usd,
        summary: `${repeated.length} ${repeated.length === 1 ? "session hit" : "sessions hit"} ${REPEAT_MIN}+ compactions. Each one discards detail, invalidates the cache and leaves a recap that every later request re-reads${usd > 0 ? ` (${usdText(usd)} for ${repeated.length === 1 ? "that session" : "those sessions"})` : ""}.`,
        action: "Stop at a natural endpoint and begin a fresh session from a brief note, or delegate the long task to sub-agents, each starting with an empty context.",
        evidence,
        short: `${repeated.length} ${repeated.length === 1 ? "session" : "sessions"} with ${REPEAT_MIN}+ compactions`,
      },
    ];
  },
};
