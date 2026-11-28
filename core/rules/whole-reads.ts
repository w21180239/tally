import type { Evidence, HintInput, HintRule } from "../hint.ts";
import { activeDays, usdText } from "./shared.ts";

export const WHOLE_READS_MIN = 3;
const FILES_LISTED = 4;

/** Images and PDFs are media reads: re-reading one is no text-duplication pattern to fix. */
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|pdf)$/i;
/** Figures that round to under half a cent are hidden. */
const MIN_USD = 0.005;

// Duplicate whole reads (copies beyond the first) of files read whole WHOLE_READS_MIN+ times, per active day. Base: a copy's re-read cost times the active days.
const duplicatesPerDay = ({ summary }: HintInput): number => {
  let extra = 0;
  for (const [path, n] of Object.entries(summary.wholeReads)) if (n >= WHOLE_READS_MIN && !MEDIA_FILE.test(path)) extra += n - 1;
  return extra / activeDays(summary);
};

export const wholeReads: HintRule = {
  id: "whole-reads",
  metric: duplicatesPerDay,
  run: (i) => {
    const { summary } = i;
    const costOf = new Map<string, number>();
    for (const f of summary.flow) if (f.source === "read") costOf.set(f.label, (costOf.get(f.label) ?? 0) + f.rereadUsd);
    // The first read is necessary; the saving is what the extra copies cost in cache reads.
    const files = Object.entries(summary.wholeReads)
      .filter(([path, n]) => n >= WHOLE_READS_MIN && !MEDIA_FILE.test(path))
      .map(([path, n]) => ({ path, n, usd: ((costOf.get(path) ?? 0) * (n - 1)) / n }))
      .sort((a, b) => b.usd - a.usd || b.n - a.n || (a.path < b.path ? -1 : 1));
    if (files.length === 0) return [];
    const usd = files.reduce((n, f) => n + f.usd, 0);
    if (usd < MIN_USD) return [];
    const evidence: Evidence[] = [];
    for (const f of files.slice(0, FILES_LISTED)) {
      evidence.push({ label: "File", detail: f.path, kind: "path" }, { label: "Full reads", detail: `${f.n} complete Read calls`, kind: "text" });
    }
    return [
      {
        rule: "whole-reads",
        title: "Duplicate Read calls on the same file",
        usd,
        projected: true,
        summary: `Within one stretch of a session (between compactions, with no edit to the file in between), ${files.length} ${files.length === 1 ? "file" : "files"} got ${WHOLE_READS_MIN}+ complete Read calls. The duplicates stay in context and are re-billed every turn, roughly ${usdText(usd)} across the extras.`,
        action: "Read once and refer back to that copy; for big files pass offset and limit, or let a sub-agent explore them. A read after /compact or /clear is expected and not counted.",
        evidence,
        short: `${files.length} ${files.length === 1 ? "file" : "files"} with ${WHOLE_READS_MIN}+ full-file Reads`,
        metric: { name: "duplicate whole reads per day", value: duplicatesPerDay(i) },
      },
    ];
  },
};
