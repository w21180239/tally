import type { Evidence, HintRule } from "../hint.ts";
import { baseName } from "../path.ts";
import { usdText } from "./shared.ts";

/** Number of full reads of the same file in a single conversation that triggers a report. */
export const WHOLE_READS_MIN = 3;
const FILES_LISTED = 4;

export const wholeReads: HintRule = {
  id: "whole-reads",
  run: ({ summary }) => {
    const costOf = new Map<string, number>();
    for (const f of summary.flow) if (f.source === "read") costOf.set(f.label, (costOf.get(f.label) ?? 0) + f.rereadUsd);
    // The first read is needed; what the extra copies cost in cache reads is the possible saving.
    const files = Object.entries(summary.wholeReads)
      .filter(([, n]) => n >= WHOLE_READS_MIN)
      .map(([path, n]) => ({ path, n, usd: ((costOf.get(path) ?? 0) * (n - 1)) / n }))
      .sort((a, b) => b.usd - a.usd || b.n - a.n || (a.path < b.path ? -1 : 1));
    if (files.length === 0) return [];
    const usd = files.reduce((n, f) => n + f.usd, 0);
    const evidence: Evidence[] = [];
    for (const f of files.slice(0, FILES_LISTED)) {
      evidence.push({ label: "File", detail: f.path, kind: "path" }, { label: "Whole reads", detail: `${f.n} whole reads in one conversation`, kind: "text" });
    }
    const top = files[0]!;
    return [
      {
        rule: "whole-reads",
        title: "Repeated full-file reads",
        usd,
        projected: true,
        summary: `${files.length} ${files.length === 1 ? "file was" : "files were"} opened in full at least ${WHOLE_READS_MIN} times by one conversation; each copy stays in context and is billed again on every following request (${usdText(usd)} for the extra copies).`,
        action: "Read each file once and keep working from that copy; when you need less, use offset and limit. After an edit, rely on the edit result instead of re-reading the file.",
        evidence,
        short: `${baseName(top.path)} read whole ${top.n}x`,
      },
    ];
  },
};
