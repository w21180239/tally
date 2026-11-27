// A synthetic report snapshot in the shape Task 8.1 writes to `<config>/tally/report-<span>.json`.
import type { Hint } from "../../core/hint.ts";
import type { Span } from "../../core/summary.ts";

export type SnapshotFixture = {
  span: Span;
  generatedAt: number;
  summary: {
    total: { usd: number; requests: number };
    main: { usd: number };
    sub: { usd: number };
    byModel: Record<string, { usd: number; requests: number }>;
    byRepo: Record<string, { usd: number; requests: number }>;
  };
  hints: Hint[];
};

export const REPORT_24H: SnapshotFixture = {
  span: "24h",
  generatedAt: Date.UTC(2026, 10, 27, 1, 0),
  summary: {
    total: { usd: 12.5, requests: 240 },
    main: { usd: 9.25 },
    sub: { usd: 3.25 },
    byModel: { "model-a": { usd: 10, requests: 200 }, "model-b": { usd: 2.5, requests: 40 } },
    byRepo: { "repo-one": { usd: 8, requests: 150 }, "repo-two": { usd: 4.5, requests: 90 } },
  },
  hints: [
    {
      rule: "cache-rebuilt",
      title: "Cache rebuilt after idle gaps",
      usd: 3.2,
      summary: "Five long pauses made the prompt cache expire and refill.",
      action: "Keep sessions short or use the 1h cache.",
      evidence: [],
      short: "cache rebuilt",
    },
    {
      rule: "big-paste",
      title: "Large pasted prompts",
      usd: 1.1,
      summary: "Two prompts over 5000 tokens were re-read on every request.",
      action: "Put long text in a file and reference it.",
      evidence: [],
      short: "big paste",
    },
  ],
};

export const REPORT_30D: SnapshotFixture = { ...REPORT_24H, span: "30d", hints: [] };
