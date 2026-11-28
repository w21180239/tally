// Adopted hints: what is recorded when someone acts on a hint, and when and how it is checked again.
// The store holds the records under ADOPTIONS_KEY; the optimizing skill writes this same shape.
import { formatMoney } from "./money.ts";
import type { Settings } from "./settings.ts";

export type Adoption = {
  rule: string;
  /** The hint's title when adopted, for the recheck toast; older records have none and the toast names the rule. */
  title?: string;
  /** When the hint was adopted (epoch ms). */
  at: number;
  /** The rule's metric: its name and value at adoption. A rule with no metric records neither and is never rechecked. */
  metricName?: string;
  before?: number;
  /** Dollars the hint said acting would save. */
  expectedUsd: number;
};

export const ADOPTIONS_KEY = "adoptions";
/** Ids (`adoptionId`) of adoptions whose recheck has been shown. */
export const CHECKED_KEY = "adoptions-checked";

const DAY_MS = 86_400_000;

/** One record per adoption: a rule adopted again starts over, so a rule and a date name it. */
export const adoptionId = (a: Adoption): string => `${a.rule}|${a.at}`;

/** The adoptions that carry a metric and are at least `recheckDays` days old. */
export const dueRechecks = (adoptions: Adoption[], nowMs: number, recheckDays: number): Adoption[] =>
  adoptions.filter((a) => a.metricName !== undefined && a.before !== undefined && nowMs - a.at >= recheckDays * DAY_MS);

/**
 * Expected and actual saving. Base: dollars per unit of the metric, the expected saving over the metric's value at
 * adoption (spend for a share, output spend for the thinking share, a read's cost times active days for whole reads).
 * Actual is the metric's fall times that base; a rise gives a negative saving.
 */
export function recheckResult(a: Adoption, nowMetric: number): { expectedUsd: number; actualUsd: number } {
  const before = a.before ?? 0;
  if (!(before > 0)) return { expectedUsd: a.expectedUsd, actualUsd: 0 };
  return { expectedUsd: a.expectedUsd, actualUsd: (before - nowMetric) * (a.expectedUsd / before) };
}

/** A rule adopted again replaces its earlier record. */
export const withAdoption = (list: Adoption[], a: Adoption): Adoption[] => [...list.filter((x) => x.rule !== a.rule), a];

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The records in a stored value; anything malformed is dropped. */
export function parseAdoptions(raw: unknown): Adoption[] {
  if (!Array.isArray(raw)) return [];
  const out: Adoption[] = [];
  for (const x of raw as Array<Record<string, unknown> | null>) {
    if (x === null || typeof x !== "object" || typeof x.rule !== "string" || !num(x.at) || !num(x.expectedUsd)) continue;
    if ((x.metricName !== undefined && typeof x.metricName !== "string") || (x.before !== undefined && !num(x.before))) continue;
    out.push({ rule: x.rule, at: x.at, expectedUsd: x.expectedUsd, ...(typeof x.title === "string" && { title: x.title }),...(x.metricName !== undefined && { metricName: x.metricName }), ...(x.before !== undefined && { before: x.before }) });
  }
  return out;
}

/** The toast for a finished recheck: the rule's title, then both savings in the person's money format. */
export const recheckText = (title: string, r: { expectedUsd: number; actualUsd: number }, s: Pick<Settings, "money" | "decimals">): string =>
  `tally: ${title}: expected save ${formatMoney(r.expectedUsd, s.money, s.decimals)}, actual ${formatMoney(r.actualUsd, s.money, s.decimals)}`;
