// Cross-machine sync: what one machine writes to `<syncDir>/tally/<machine>.json` and how the others fold it in.
// Pure. The file is one JSON document <= MACHINE_FILE_MAX bytes (a single `$.fs.write`).
// CPU: build is linear in the rows and yields every STEP_ROWS through `buildMachineFileAsync`'s tick, so a caller on
// the event loop uses that; the sync variants (`buildMachineFile`, `mergeMachines`, `parseMachineFile`) run to the end.
// `mergeMachines` is linear in cells, files are small enough (<= 4 MiB each) that one call stays within a slice for a handful of machines.
import { hmacSha256Hex } from "./sha256.ts";
import { costOf, memoResolver } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import { TOP_SESSIONS, UNKNOWN_REPO, UNKNOWN_SUB, repoFor } from "./summary.ts";
import type { Money, Summary, TopSession } from "./summary.ts";
import { redact } from "./hint.ts";
import type { Hint } from "./hint.ts";
import { dict } from "./dict.ts";
import { utf8Length } from "./lines.ts";
import { DAY_MS, HOUR_MS, localDayStart } from "./time.ts";
import { drain, drainAsync, sortSteps, STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";
import type { Settings } from "./settings.ts";
import type { Shard } from "./shard.ts";
import type { Tokens } from "./types.ts";

export const MACHINE_FILE_MAX = 4 * 1024 * 1024;
/** Sessions a `full` file lists, costliest first. */
export const SESSIONS_MAX = 100;

export type Detail = "numbers" | "repos" | "full";
type Optional = "sessions" | "hints" | "toolFill";

/** One UTC hour of one (model, repo, sub-agent type, fast) combination. `h` is hours since the epoch; `sub` is the sub-agent type, null on the main thread. */
export type HourCell = { h: number; model: string; repo: string; sub: string | null; fast: boolean; tokens: Tokens; usd: number; requests: number };

export type MachineFile = {
  v: 1;
  machine: string;
  detail: Detail;
  writtenAt: number;
  /** Optional sections dropped to fit MACHINE_FILE_MAX. */
  omitted?: Optional[];
  /** Set when the oldest hours were dropped to fit: the first hour kept. */
  hoursFrom?: number;
  hours: HourCell[];
  sessions?: TopSession[];
  hints?: Hint[];
  toolFill?: Record<string, number>;
};

/** `numbers` files hold this in place of the repo name: the same repo gets the same alias on every machine sharing the salt. */
export const repoAlias = (repo: string, salt: string): string => `r-${hmacSha256Hex(salt, repo).slice(0, 10)}`;

/** Summary blocks no file carries at any detail level; a merged view shows them as this machine only. */
export const NEVER_SYNCED = ["bySkill", "byPlugin", "byMcp", "elsewhere", "hourBands", "unpriced", "cacheRebuilds", "peakContext", "flow", "flowByAgent", "mcpReread", "usage", "pastes", "wholeReads", "compactions", "compaction"] as const;

/** What the engine supplies beyond the shards: the sections only the engine's rules and flow pass can produce. Used for `full` only. */
export type Extra = { hints?: Hint[]; toolFill?: Record<string, number> };

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });
const zero = (): Money => ({ usd: 0, tokens: zeroTokens(), requests: 0 });

// ---- build ----

/** A first-seen repo's HMAC costs about this many rows of the main loop. */
const ALIAS_WORK = 16;

type Acc = { usd: number; started: number; byRepo: Map<string, number> };

function* buildSteps(shards: Shard[], prices: PriceTable, s: Pick<Settings, "shareDetail" | "machineName" | "redactEvidence">, salt: string, nowMs: number, extra: Extra | undefined): Steps<MachineFile> {
  const detail = s.shareDetail;
  const resolve = memoResolver(prices);
  const aliases = new Map<string, string>();
  let work = 0;
  const nameOf = (repo: string): string => {
    if (detail !== "numbers") return repo;
    let a = aliases.get(repo);
    if (a === undefined) {
      aliases.set(repo, (a = repoAlias(repo, salt)));
      work += ALIAS_WORK;
    }
    return a;
  };
  const cells = new Map<string, HourCell>();
  const sessions = new Map<string, Acc>();
  for (const sh of shards) {
    for (const r of sh.usage) {
      if (++work >= STEP_ROWS) {
        work = 0;
        yield;
      }
      if (r.synthetic) continue;
      const usd = costOf(r, prices, resolve).usd;
      const real = repoFor(r);
      const repo = nameOf(real);
      const sub = r.sidechain ? (r.agentType ?? UNKNOWN_SUB) : null;
      const h = Math.floor(r.ts / HOUR_MS);
      const key = `${h}\0${r.fast ? 1 : 0}\0${r.model}\0${sub === null ? "-" : `+${sub}`}\0${repo}`;
      let c = cells.get(key);
      if (c === undefined) cells.set(key, (c = { h, model: r.model, repo, sub, fast: r.fast, tokens: zeroTokens(), usd: 0, requests: 0 }));
      c.usd += usd;
      c.requests++;
      c.tokens.input += r.tokens.input;
      c.tokens.output += r.tokens.output;
      c.tokens.cacheRead += r.tokens.cacheRead;
      c.tokens.cw5m += r.tokens.cw5m;
      c.tokens.cw1h += r.tokens.cw1h;
      if (detail === "full") {
        let a = sessions.get(r.sessionId);
        if (a === undefined) sessions.set(r.sessionId, (a = { usd: 0, started: r.ts, byRepo: new Map() }));
        a.usd += usd;
        a.started = Math.min(a.started, r.ts);
        a.byRepo.set(real, (a.byRepo.get(real) ?? 0) + usd);
      }
    }
  }
  yield;

  const hours = yield* sortSteps([...cells.values()], (a, b) => a.h - b.h || cmpStr(a.model, b.model) || cmpStr(a.repo, b.repo) || cmpStr(a.sub ?? "", b.sub ?? "") || Number(a.fast) - Number(b.fast));
  yield;

  const opt: { sessions?: TopSession[]; hints?: Hint[]; toolFill?: Record<string, number> } = {};
  if (detail === "full") {
    const metas = new Map<string, { custom?: string; ai?: string; pr?: string }>();
    for (const sh of shards) {
      for (const m of sh.metas) {
        if (typeof m.value !== "string" || !sessions.has(m.sessionId)) continue;
        const e = metas.get(m.sessionId) ?? {};
        if (m.key === "custom-title") e.custom = m.value;
        else if (m.key === "ai-title") e.ai = m.value;
        else if (m.key === "pr-link") e.pr = m.value;
        metas.set(m.sessionId, e);
      }
    }
    const top: TopSession[] = [];
    for (const [sessionId, a] of sessions) {
      let repo = UNKNOWN_REPO;
      let best = -Infinity;
      for (const [k, v] of a.byRepo) if (v > best) ((best = v), (repo = k));
      const t: TopSession = { sessionId, repo, started: a.started, usd: a.usd, resume: `claude --resume ${sessionId}` };
      const m = metas.get(sessionId);
      const title = m?.custom ?? m?.ai;
      if (title && !s.redactEvidence) t.title = title;
      if (m?.pr) t.pr = m.pr;
      top.push(t);
    }
    top.sort((x, y) => y.usd - x.usd || x.started - y.started || (x.sessionId < y.sessionId ? -1 : 1));
    opt.sessions = top.slice(0, SESSIONS_MAX);
    if (extra?.hints !== undefined) opt.hints = extra.hints.map((h) => ({ ...h, evidence: h.evidence.map((e) => redact(e, s.redactEvidence)) }));
    if (extra?.toolFill !== undefined) opt.toolFill = { ...extra.toolFill };
    yield;
  }
  return yield* fitSteps({ v: 1, machine: s.machineName, detail, writtenAt: nowMs, hours }, opt);
}

const bytesOf = (v: unknown): number => utf8Length(JSON.stringify(v));

// Drops the largest optional section until the file fits, then the oldest hours. Sizes are summed from per-part
// JSON, which is exact because a JSON array is its elements joined by commas.
function* fitSteps(base: MachineFile, opt: { sessions?: TopSession[]; hints?: Hint[]; toolFill?: Record<string, number> }): Steps<MachineFile> {
  const hours = base.hours;
  const sizes: [Optional, number][] = [];
  for (const k of ["sessions", "hints", "toolFill"] as const) if (opt[k] !== undefined) sizes.push([k, bytesOf(opt[k])]);
  const cellBytes: number[] = [];
  for (let i = 0; i < hours.length; i++) {
    cellBytes.push(bytesOf(hours[i]));
    if ((i + 1) % STEP_ROWS === 0) yield;
  }
  let sum = 0;
  for (const b of cellBytes) sum += b;
  const make = (keep: Optional[], omitted: Optional[], from: number, hs: HourCell[]): MachineFile => {
    const f: MachineFile = { v: 1, machine: base.machine, detail: base.detail, writtenAt: base.writtenAt, hours: hs };
    if (omitted.length) f.omitted = omitted;
    if (from >= 0) f.hoursFrom = from;
    for (const k of keep) (f as Record<string, unknown>)[k] = opt[k];
    return f;
  };
  // Size with `hours` swapped for the per-cell sum.
  const total = (f: MachineFile, cellSum: number, count: number) => bytesOf({ ...f, hours: [] }) + cellSum + Math.max(0, count - 1);

  const keep = sizes.map(([k]) => k);
  const omitted: Optional[] = [];
  let f = make(keep, omitted, -1, hours);
  const order = [...sizes].sort((a, b) => b[1] - a[1]);
  for (const [k] of order) {
    yield;
    if (total(f, sum, hours.length) <= MACHINE_FILE_MAX) return f;
    keep.splice(keep.indexOf(k), 1);
    omitted.push(k);
    f = make(keep, omitted, -1, hours);
  }
  if (total(f, sum, hours.length) <= MACHINE_FILE_MAX) return f;

  // Still too big: keep the newest hours. hoursFrom is sized at its widest.
  const probe = make(keep, omitted, Number.MAX_SAFE_INTEGER, []);
  let room = MACHINE_FILE_MAX - bytesOf(probe);
  let first = hours.length;
  for (let i = hours.length - 1; i >= 0; i--) {
    const need = cellBytes[i] + (first < hours.length ? 1 : 0);
    if (need > room) break;
    room -= need;
    first = i;
  }
  const kept = hours.slice(first);
  return make(keep, omitted, kept.length ? kept[0].h : Math.floor(base.writtenAt / HOUR_MS) + 1, kept);
}

type BuildSettings = Pick<Settings, "shareDetail" | "machineName" | "redactEvidence">;

/** The file this machine writes; `settings.machineName` must already be resolved (not ""). */
export function buildMachineFile(shards: Shard[], prices: PriceTable, settings: BuildSettings, salt: string, nowMs: number, extra?: Extra): MachineFile {
  return drain(buildSteps(shards, prices, settings, salt, nowMs, extra));
}

/** Same file, awaiting `tick` about every STEP_ROWS rows and between phases. */
export function buildMachineFileAsync(shards: Shard[], prices: PriceTable, settings: BuildSettings, salt: string, nowMs: number, extra: Extra | undefined, tick: () => Promise<void> | void): Promise<MachineFile> {
  return drainAsync(buildSteps(shards, prices, settings, salt, nowMs, extra), tick);
}

export const encodeMachineFile = (f: MachineFile): string => JSON.stringify(f);

// ---- parse ----

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function tokensOk(t: unknown): t is Tokens {
  return obj(t) && num(t.input) && num(t.output) && num(t.cacheRead) && num(t.cw5m) && num(t.cw1h);
}
function cellOk(c: unknown): c is HourCell {
  return obj(c) && Number.isInteger(c.h) && str(c.model) && str(c.repo) && (c.sub === null || str(c.sub)) && typeof c.fast === "boolean" && tokensOk(c.tokens) && num(c.usd) && num(c.requests);
}
function sessionOk(s: unknown): s is TopSession {
  return obj(s) && str(s.sessionId) && str(s.repo) && num(s.started) && num(s.usd) && str(s.resume) && (s.title === undefined || str(s.title)) && (s.pr === undefined || str(s.pr));
}
function hintOk(h: unknown): h is Hint {
  return (
    obj(h) &&
    str(h.rule) &&
    str(h.title) &&
    num(h.usd) &&
    str(h.summary) &&
    str(h.action) &&
    str(h.short) &&
    Array.isArray(h.evidence) &&
    h.evidence.every((e) => obj(e) && str(e.label) && str(e.detail) && str(e.kind))
  );
}

/** A machine file read from disk, or null if it is not valid version 1. Another machine wrote it, so no field is trusted. */
export function parseMachineFile(text: string): MachineFile | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj(j) || j.v !== 1 || !str(j.machine) || !num(j.writtenAt) || !Array.isArray(j.hours)) return null;
  if (j.detail !== "numbers" && j.detail !== "repos" && j.detail !== "full") return null;
  if (!j.hours.every(cellOk)) return null;
  const f: MachineFile = { v: 1, machine: j.machine, detail: j.detail, writtenAt: j.writtenAt, hours: j.hours as HourCell[] };
  if (j.omitted !== undefined) {
    if (!Array.isArray(j.omitted) || !j.omitted.every((x) => x === "sessions" || x === "hints" || x === "toolFill")) return null;
    f.omitted = j.omitted as Optional[];
  }
  if (j.hoursFrom !== undefined) {
    if (!Number.isInteger(j.hoursFrom)) return null;
    f.hoursFrom = j.hoursFrom as number;
  }
  if (j.sessions !== undefined) {
    if (!Array.isArray(j.sessions) || !j.sessions.every(sessionOk)) return null;
    f.sessions = j.sessions as TopSession[];
  }
  if (j.hints !== undefined) {
    if (!Array.isArray(j.hints) || !j.hints.every(hintOk)) return null;
    f.hints = j.hints as Hint[];
  }
  if (j.toolFill !== undefined) {
    if (!obj(j.toolFill) || !Object.values(j.toolFill).every(num)) return null;
    f.toolFill = j.toolFill as Record<string, number>;
  }
  return f;
}

// ---- merge ----

const cloneMoney = (m: Money): Money => ({ usd: m.usd, requests: m.requests, tokens: { ...m.tokens } });

function addCell(m: Money, c: HourCell): void {
  m.usd += c.usd;
  m.requests += c.requests;
  m.tokens.input += c.tokens.input;
  m.tokens.output += c.tokens.output;
  m.tokens.cacheRead += c.tokens.cacheRead;
  m.tokens.cw5m += c.tokens.cw5m;
  m.tokens.cw1h += c.tokens.cw1h;
}

function slot<V>(rec: Record<string, V>, key: string, make: () => V): V {
  if (!(key in rec)) rec[key] = make();
  return rec[key];
}

function cloneRec(r: Record<string, Money>): Record<string, Money> {
  const out = dict<Money>();
  for (const k of Object.keys(r)) out[k] = cloneMoney(r[k]);
  return out;
}

/**
 * `local` plus the other machines' files, over the same window as `local`. Hours are placed by the viewer's clock:
 * a day bucket takes the cell whose UTC hour starts inside that local day. `self` names this machine's own file, which is skipped
 * (its rows are already in `local`); of several files from one machine the newest counts. Sessions started inside the window only.
 * `localOnly` names the blocks that still hold this machine alone because a file lacked the detail or dropped the section;
 * "hours" means a file dropped its oldest hours and the window reaches back past them. NEVER_SYNCED blocks are local at every level.
 * A session-span summary is live data of this machine and is returned unchanged. A summary made with a repo filter must not be merged: numbers files cannot be filtered.
 */
export function mergeMachines(local: Summary, files: MachineFile[], tzOffsetMin: number, self?: string): Summary & { localOnly: string[] } {
  const latest = new Map<string, MachineFile>();
  for (const f of files) {
    if (f.v !== 1 || f.machine === self) continue;
    const seen = latest.get(f.machine);
    if (seen === undefined || f.writtenAt > seen.writtenAt) latest.set(f.machine, f);
  }
  const remotes = [...latest.values()];
  if (local.span === "session" || remotes.length === 0) return { ...local, localOnly: [] };

  const { from, to } = local;
  const dayBuckets = local.timeline.bucketMs === DAY_MS;
  const inWindow = (ts: number): boolean => ts <= to && (dayBuckets ? localDayStart(ts, tzOffsetMin) >= from : ts >= from);
  const count = local.timeline.points.length;

  const bySubType = dict<Record<string, Money & { tools: Record<string, number> }>>();
  for (const t of Object.keys(local.bySubType)) {
    const per = dict<Money & { tools: Record<string, number> }>();
    for (const m of Object.keys(local.bySubType[t])) {
      const x = local.bySubType[t][m];
      const tools = dict<number>();
      for (const k of Object.keys(x.tools)) tools[k] = x.tools[k];
      per[m] = { ...cloneMoney(x), tools };
    }
    bySubType[t] = per;
  }
  const toolFill = dict<number>();
  for (const k of Object.keys(local.toolFill)) toolFill[k] = local.toolFill[k];
  const out: Summary = {
    ...local,
    total: cloneMoney(local.total),
    main: cloneMoney(local.main),
    sub: cloneMoney(local.sub),
    fast: cloneMoney(local.fast),
    byModel: cloneRec(local.byModel),
    byRepo: cloneRec(local.byRepo),
    bySubType,
    timeline: { bucketMs: local.timeline.bucketMs, points: local.timeline.points.map(cloneMoney) },
    topSessions: [...local.topSessions],
    toolFill,
  };

  const lacking = new Set<string>();
  const windowHour = Math.floor(from / HOUR_MS);
  const sessionIds = new Set(local.topSessions.map((s) => s.sessionId));
  const extraSessions: TopSession[] = [];
  for (const f of remotes) {
    for (const c of f.hours) {
      const ts = c.h * HOUR_MS;
      if (!inWindow(ts)) continue;
      addCell(out.total, c);
      addCell(c.sub === null ? out.main : out.sub, c);
      if (c.fast) addCell(out.fast, c);
      addCell(slot(out.byModel, c.model, zero), c);
      if (f.detail !== "numbers") addCell(slot(out.byRepo, c.repo, zero), c);
      if (c.sub !== null) addCell(slot(slot(out.bySubType, c.sub, () => dict<Money & { tools: Record<string, number> }>()), c.model, () => ({ ...zero(), tools: dict<number>() })), c);
      const i = dayBuckets ? Math.round((localDayStart(ts, tzOffsetMin) - from) / DAY_MS) : Math.floor((ts - from) / local.timeline.bucketMs);
      if (i >= 0 && i < count) addCell(out.timeline.points[i], c);
    }
    if (f.detail === "numbers") lacking.add("byRepo");
    if (f.detail === "full" && f.sessions !== undefined) {
      for (const s of f.sessions) {
        if (!sessionIds.has(s.sessionId) && inWindow(s.started)) (extraSessions.push(s), sessionIds.add(s.sessionId));
      }
    } else lacking.add("topSessions");
    if (f.detail === "full" && f.toolFill !== undefined) {
      for (const k of Object.keys(f.toolFill)) out.toolFill[k] = (out.toolFill[k] ?? 0) + f.toolFill[k];
    } else lacking.add("toolFill");
    if (f.hoursFrom !== undefined && f.hoursFrom > windowHour) lacking.add("hours");
  }
  if (extraSessions.length) {
    out.topSessions = [...out.topSessions, ...extraSessions].sort((x, y) => y.usd - x.usd || x.started - y.started || (x.sessionId < y.sessionId ? -1 : 1)).slice(0, TOP_SESSIONS);
  }
  return { ...out, localOnly: ["byRepo", "topSessions", "toolFill", "hours"].filter((k) => lacking.has(k)) };
}
