// Adopting a hint and checking it again later. Both measure over every repo, so the figure before and after compare
// whichever scope the adopted hint was shown in.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { ADOPTIONS_KEY, CHECKED_KEY, adoptionId, dueRechecks, parseAdoptions, recheckResult, recheckText, withAdoption } from "../core/adopt.ts";
import type { Adoption } from "../core/adopt.ts";
import { HINT_RULES } from "../core/hint.ts";
import type { Hint, HintInput } from "../core/hint.ts";
import { summarizeAsync } from "../core/summary.ts";
import { inputOf, loadScope, sharedOf } from "./hints-view.ts";
import { locate } from "./locate.ts";
import { makeSlicer } from "./slicer.ts";
import { invalidateWindow } from "./window.ts";

// The rules' input for a 30-day window, cut to what came after `since` when given, and how many requests it holds.
async function measure($: EngineInterface, since?: number): Promise<{ input: HintInput; requests: number; unread: number }> {
  const now = await $.clock.now();
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const { shards, snaps, unread } = await loadScope($, loc, now, tick);
  const sh = await sharedOf($, loc.cfg, snaps, now, tick);
  const summary = await summarizeAsync(shards, sh.prices, { span: "30d", nowMs: now, tzOffsetMin: -new Date(now).getTimezoneOffset(), usage: true, ...(since !== undefined && { since }) }, tick);
  return { input: inputOf(sh, "span", summary, ""), requests: summary.total.requests, unread };
}

export async function readAdoptions($: EngineInterface): Promise<Adoption[]> {
  return parseAdoptions(await $.store.get(ADOPTIONS_KEY).catch(() => undefined));
}

// What the Hints tab draws from: the records, read from the store once, then kept as they change.
export type AdoptedView = { loaded: boolean; list: Adoption[] };
const adoptedAtom = atom({ plugin: "tally", key: "adopted" } as const, { loaded: false, list: [] } as AdoptedView, { shape: "adopted-1" });

export function readAdopted($: EngineInterface): Promise<AdoptedView> {
  return read($, adoptedAtom);
}

/** Fills the view from the store. Marked loaded first, so a redraw does not start a second load; an adoption made meanwhile is kept. */
export async function loadAdopted($: EngineInterface): Promise<void> {
  await update($, adoptedAtom, () => ({ loaded: true, list: [] }));
  const list = await readAdoptions($);
  await update($, adoptedAtom, (v) => ({ loaded: true, list: v.list.length > 0 ? v.list : list }));
}

/** Records `hint` as adopted. A rule with a metric also gets its value now, measured over all repos, and the saving that same measurement predicts. */
export async function adoptHint($: EngineInterface, hint: Hint): Promise<void> {
  const now = await $.clock.now();
  let record: Adoption = { rule: hint.rule, at: now, expectedUsd: hint.usd };
  const rule = HINT_RULES.find((r) => r.id === hint.rule);
  if (rule?.metric !== undefined && hint.metric !== undefined) {
    // Without a measurement the shown hint's own figures stand in.
    record = { ...record, metricName: hint.metric.name, before: hint.metric.value };
    try {
      const m = await measure($);
      if (m.requests > 0) {
        // Value and saving must come from one measurement: a window where the rule stays silent keeps the stand-in pair.
        const own = rule.run(m.input).find((h) => h.rule === rule.id);
        if (own !== undefined) record = { ...record, before: rule.metric(m.input), expectedUsd: own.usd };
      }
    } catch {
      /* keep the stand-in figures */
    }
  }
  const list = withAdoption(await readAdoptions($), record);
  await $.store.set(ADOPTIONS_KEY, list);
  await update($, adoptedAtom, () => ({ loaded: true, list }));
  invalidateWindow($);
}

const idsOf = (stored: unknown): string[] => (Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : []);

/** Toasts the saving of each due adoption once, then marks it done. An adoption with nothing to measure yet, or over a history not fully indexed, waits for a later start. */
async function recheck($: EngineInterface, days: number): Promise<void> {
  const now = await $.clock.now();
  const checked = idsOf(await $.store.get(CHECKED_KEY).catch(() => undefined));
  for (const a of dueRechecks(await readAdoptions($), now, days)) {
    if (checked.includes(adoptionId(a))) continue;
    const rule = HINT_RULES.find((r) => r.id === a.rule);
    if (rule?.metric === undefined) continue;
    const m = await measure($, a.at);
    // A partly indexed history would read as a saving; wait for a start that finds it whole.
    if (m.requests === 0 || m.unread > 0) continue;
    const result = recheckResult(a, rule.metric(m.input));
    // Marked before the toast, so one adoption never toasts twice.
    checked.push(adoptionId(a));
    await $.store.set(CHECKED_KEY, checked);
    $.ui.toast(recheckText(a.rule, result));
  }
}

let running: Promise<void> | undefined;

/** Rechecks what is due, one run at a time, off the caller's path. Never rejects. */
export function recheckSoon($: EngineInterface, days: () => number): void {
  if (running !== undefined) return;
  running = recheck($, days())
    .catch(() => {})
    .finally(() => {
      running = undefined;
    });
}
