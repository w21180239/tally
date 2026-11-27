import { utf8Length } from "./lines.ts";
import { sessionOfPath } from "./path.ts";
import type { CompactRow, FileState, MetaRow, ToolUse, UsageRow, UserRow } from "./types.ts";

export type BreakdownSnapshot = unknown;
export type ShardFile = FileState & { isSub: boolean; agentType?: string; sessionId: string };
export type Shard = {
  v: 1;
  project: string;
  files: Record<string, ShardFile>;
  usage: UsageRow[];
  users: UserRow[];
  metas: MetaRow[];
  compacts: CompactRow[];
  snapshots: BreakdownSnapshot[];
  /** Manifest only: save counter of every bucket this snapshot expects, keyed by bucket name. */
  days?: Record<string, number>;
  /** Manifest only: the INDEX_FORMAT the buckets were written with; absent on manifests from before stamping. */
  fmt?: number;
};

/**
 * Version of what a bucket's rows hold. Raise it whenever the parser starts recording a row field that
 * unchanged transcripts would lack: an index stamped with another value is dropped and read again.
 * 2: agentType, tool ids and whole reads, user-row sidechain, agentId.
 */
export const INDEX_FORMAT = 2;

export const PART_MAX = 3.5 * 1024 * 1024;
const USAGE_CHUNK = 500;
const ROW_CHUNK = 200;

// Per-chunk string table: `at` returns the index of a value, adding it on first sight.
function table(): { at(v: string): number; list: string[] } {
  const list: string[] = [];
  const idx = new Map<string, number>();
  return {
    list,
    at(v) {
      let i = idx.get(v);
      if (i === undefined) {
        i = list.length;
        idx.set(v, i);
        list.push(v);
      }
      return i;
    },
  };
}

// UsageRow as parallel columns: field names are written once per chunk, not once per row.
// flags: bit0 fast, bit1 sidechain, bit2 synthetic. Optional strings use null for "absent".
// sessionId, model and cwd are column indexes into tables appended after the 17 columns; agentType
// (column 20, table 21) and agentId (22, table 23) follow them so shards written before them still decode.
function usageCols(rows: UsageRow[]): unknown[] {
  const c = (f: (r: UsageRow) => unknown) => rows.map(f);
  const opt = (f: (r: UsageRow) => string | undefined) => rows.map((r) => f(r) ?? null);
  const sess = table();
  const model = table();
  const cwd = table();
  const agent = table();
  const id = table();
  return [
    c((r) => r.requestId),
    c((r) => sess.at(r.sessionId)),
    c((r) => r.ts),
    c((r) => model.at(r.model)),
    c((r) => r.tokens.input),
    c((r) => r.tokens.output),
    c((r) => r.tokens.cacheRead),
    c((r) => r.tokens.cw5m),
    c((r) => r.tokens.cw1h),
    c((r) => (r.fast ? 1 : 0) | (r.sidechain ? 2 : 0) | (r.synthetic ? 4 : 0)),
    c((r) => (r.cwd === undefined ? null : cwd.at(r.cwd))),
    c((r) => r.thinkingChars),
    c((r) => r.replyChars),
    c((r) => r.tools),
    opt((r) => r.skill),
    opt((r) => r.plugin),
    opt((r) => r.effort),
    sess.list,
    model.list,
    cwd.list,
    c((r) => (r.agentType === undefined ? null : agent.at(r.agentType))),
    agent.list,
    c((r) => (r.agentId === undefined ? null : id.at(r.agentId))),
    id.list,
  ];
}

function usageRows(cols: unknown[][]): UsageRow[] {
  const n = cols[0].length;
  const out: UsageRow[] = [];
  for (let i = 0; i < n; i++) {
    const fl = cols[9][i] as number;
    const row: UsageRow = {
      requestId: cols[0][i] as string,
      sessionId: (cols[17] as unknown as string[])[cols[1][i] as number],
      ts: cols[2][i] as number,
      model: (cols[18] as unknown as string[])[cols[3][i] as number],
      tokens: {
        input: cols[4][i] as number,
        output: cols[5][i] as number,
        cacheRead: cols[6][i] as number,
        cw5m: cols[7][i] as number,
        cw1h: cols[8][i] as number,
      },
      fast: (fl & 1) !== 0,
      sidechain: (fl & 2) !== 0,
      synthetic: (fl & 4) !== 0,
      thinkingChars: cols[11][i] as number,
      replyChars: cols[12][i] as number,
      tools: cols[13][i] as ToolUse[],
    };
    if (cols[10][i] !== null) row.cwd = (cols[19] as unknown as string[])[cols[10][i] as number];
    if (cols[14][i] !== null) row.skill = cols[14][i] as string;
    if (cols[15][i] !== null) row.plugin = cols[15][i] as string;
    if (cols[16][i] !== null) row.effort = cols[16][i] as string;
    // Columns 20-23 were added later: shards written without them decode with both absent.
    if (cols[20] && cols[20][i] != null) row.agentType = (cols[21] as unknown as string[])[cols[20][i] as number];
    if (cols[22] && cols[22][i] != null) row.agentId = (cols[23] as unknown as string[])[cols[22][i] as number];
    out.push(row);
  }
  return out;
}

type Item = [kind: string, value: unknown];
export type PartHeader = { seq: number; nonce: string; i: number; n: number; project: string };

export function readHeader(part: string): PartHeader | null {
  try {
    const o = JSON.parse(part) as Partial<PartHeader> & { v?: number };
    if (o.v !== 1 || typeof o.seq !== "number" || typeof o.nonce !== "string") return null;
    if (!Number.isInteger(o.i) || !Number.isInteger(o.n) || typeof o.project !== "string") return null;
    return { seq: o.seq, nonce: o.nonce, i: o.i as number, n: o.n as number, project: o.project };
  } catch {
    return null;
  }
}

const USER_KINDS: UserRow["kind"][] = ["prompt", "notice", "compaction", "toolResult"];
const META_KEYS: MetaRow["key"][] = ["custom-title", "ai-title", "agent-name", "last-prompt", "pr-link", "cost-state"];

// Rows as short arrays with trailing nulls dropped; session ids go through a per-chunk table.
// A prompt's pointer is [dirIndex, base, offset]; base 0 means "<sessionId>.jsonl".
function userCols(rows: UserRow[]): unknown {
  const sessions = table();
  const dirs = table();
  const c = rows.map((r) => {
    const si = sessions.at(r.sessionId);
    // A single result block that names the row's toolUseId and holds all its chars is stored as 1.
    const only = r.results?.length === 1 && r.results[0].toolUseId === r.toolUseId && r.results[0].chars === r.chars;
    const res = r.results === undefined ? null : only ? 1 : r.results.map((x) => [x.toolUseId, x.chars]);
    let di: number | null = null;
    let base: string | number | null = null;
    if (r.fileKey !== undefined) {
      const cut = Math.max(r.fileKey.lastIndexOf("/"), r.fileKey.lastIndexOf("\\")) + 1;
      di = dirs.at(r.fileKey.slice(0, cut));
      const b = r.fileKey.slice(cut);
      base = b === `${r.sessionId}.jsonl` ? 0 : b;
    }
    const row: unknown[] = [si, r.ts, USER_KINDS.indexOf(r.kind), r.chars, r.toolUseId ?? null, res, r.text ?? null, di, base, r.offset ?? null, r.sidechain ? 1 : null, r.agentId ?? null];
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  return { s: sessions.list, d: dirs.list, c };
}

function userRows(o: { s: string[]; d: string[]; c: unknown[][] }): UserRow[] {
  return o.c.map((a) => {
    const r: UserRow = { sessionId: o.s[a[0] as number], ts: a[1] as number, kind: USER_KINDS[a[2] as number], chars: a[3] as number };
    if (a[4] != null) r.toolUseId = a[4] as string;
    if (a[5] === 1) r.results = [{ toolUseId: r.toolUseId as string, chars: r.chars }];
    else if (a[5] != null) r.results = (a[5] as [string, number][]).map(([toolUseId, chars]) => ({ toolUseId, chars }));
    if (a[6] != null) r.text = a[6] as string;
    if (a[7] != null) r.fileKey = o.d[a[7] as number] + (a[8] === 0 ? `${r.sessionId}.jsonl` : (a[8] as string));
    if (a[9] != null) r.offset = a[9] as number;
    if (a[10] === 1) r.sidechain = true;
    if (a[11] != null) r.agentId = a[11] as string;
    return r;
  });
}

// Object keys inside meta values (cost-state's modelUsage repeats the same ones per model) go through
// a per-chunk table: an object becomes {"<keyIndex>": value, ...} with the table in `k`.
function packKeys(v: unknown, keys: { at(v: string): number }): unknown {
  if (Array.isArray(v)) return v.map((x) => packKeys(x, keys));
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[keys.at(k)] = packKeys(x, keys);
  return out;
}

function unpackKeys(v: unknown, keys: string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => unpackKeys(x, keys));
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[keys[Number(k)]] = unpackKeys(x, keys);
  return out;
}

function metaCols(rows: MetaRow[]): unknown {
  const sessions = table();
  const keys = table();
  const c = rows.map((r) => {
    const k = META_KEYS.indexOf(r.key);
    return [sessions.at(r.sessionId), k >= 0 ? k : r.key, packKeys(r.value, keys)];
  });
  return { s: sessions.list, k: keys.list, c };
}

function metaRows(o: { s: string[]; k: string[]; c: [number, number | string, unknown][] }): MetaRow[] {
  return o.c.map(([si, k, value]) => ({ sessionId: o.s[si], key: typeof k === "number" ? META_KEYS[k] : (k as MetaRow["key"]), value: unpackKeys(value, o.k) }));
}

// File states with the directory part of each path stored once per chunk. isSub is bit 0 of flags;
// sessionId is kept only when it differs from the one the path implies.
function fileCols(entries: [string, ShardFile][]): unknown {
  const dirs: string[] = [];
  const at = new Map<string, number>();
  const r = entries.map(([path, f]) => {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
    const dir = path.slice(0, cut);
    let di = at.get(dir);
    if (di === undefined) {
      di = dirs.length;
      at.set(dir, di);
      dirs.push(dir);
    }
    const row: unknown[] = [di, path.slice(cut), f.size, f.mtimeMs, f.offset, f.isSub ? 1 : 0, f.agentType ?? null, f.sessionId === sessionOfPath(path) ? null : f.sessionId];
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  return { d: dirs, r };
}

function fileRows(o: { d: string[]; r: unknown[][] }): Record<string, ShardFile> {
  const out: Record<string, ShardFile> = {};
  for (const a of o.r) {
    const path = o.d[a[0] as number] + (a[1] as string);
    const f: ShardFile = { size: a[2] as number, mtimeMs: a[3] as number, offset: a[4] as number, isSub: a[5] === 1, sessionId: a[7] != null ? (a[7] as string) : sessionOfPath(path) };
    if (a[6] != null) f.agentType = a[6] as string;
    out[path] = f;
  }
  return out;
}

// Packs items into parts of at most PART_MAX UTF-8 bytes. Oversize chunks are halved; a single
// row that still does not fit is dropped and counted. Every part carries {seq, nonce, i, n, project}
// so a reader can tell parts of one save from parts of another. A generator: it yields after every
// chunk and part so a caller can hand control back between them.
function* encodeGen(s: Shard, h: { seq: number; nonce: string }): Generator<void, { parts: string[]; dropped: number }, void> {
  const project = JSON.stringify(s.project);
  const reserve = 120 + utf8Length(project) + utf8Length(h.nonce);
  const budget = PART_MAX - reserve;
  const groups: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  let dropped = 0;
  const add = (it: string, n: number) => {
    if (size + n > budget && cur.length) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  };
  function* emit<T>(kind: string, list: T[], enc: (l: T[]) => unknown): Generator<void, void, void> {
    const it = JSON.stringify([kind, enc(list)]);
    const n = utf8Length(it) + 1;
    if (n <= budget) {
      add(it, n);
      yield;
      return;
    }
    if (list.length === 1) {
      dropped++;
      return;
    }
    const mid = list.length >> 1;
    yield* emit(kind, list.slice(0, mid), enc);
    yield* emit(kind, list.slice(mid), enc);
  }
  function* chunked<T>(kind: string, list: T[], step: number, enc: (l: T[]) => unknown): Generator<void, void, void> {
    for (let i = 0; i < list.length; i += step) yield* emit(kind, list.slice(i, i + step), enc);
  }
  yield* chunked("files", Object.entries(s.files), ROW_CHUNK, fileCols);
  yield* chunked("usage", s.usage, USAGE_CHUNK, usageCols);
  yield* chunked("users", s.users, ROW_CHUNK, userCols);
  yield* chunked("metas", s.metas, ROW_CHUNK, metaCols);
  yield* chunked("compacts", s.compacts, ROW_CHUNK, (l) => l);
  yield* chunked("snapshots", s.snapshots, ROW_CHUNK, (l) => l);
  if (s.days) yield* emit("days", [s.days], (l) => l[0]);
  if (s.fmt !== undefined) yield* emit("fmt", [s.fmt], (l) => l[0]);
  if (cur.length || groups.length === 0) groups.push(cur);
  const n = groups.length;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`{"v":1,"project":${project},"seq":${h.seq},"nonce":${JSON.stringify(h.nonce)},"i":${i},"n":${n},"items":[${groups[i].join(",")}]}`);
    yield;
  }
  return { parts, dropped };
}

type Tick = () => Promise<void>;

export function encodeShardEx(s: Shard, h: { seq: number; nonce: string } = { seq: 0, nonce: "" }): { parts: string[]; dropped: number } {
  const g = encodeGen(s, h);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Same bytes as encodeShardEx; awaits `tick` after every chunk and part. */
export async function encodeShardAsync(s: Shard, h: { seq: number; nonce: string }, tick: Tick): Promise<{ parts: string[]; dropped: number }> {
  const g = encodeGen(s, h);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await tick();
  }
}

export function encodeShard(s: Shard, h?: { seq: number; nonce: string }): string[] {
  return encodeShardEx(s, h).parts;
}

function* decodeGen(parts: string[]): Generator<void, Shard, void> {
  const out: Shard = { v: 1, project: "", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
  let first: PartHeader | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const hd = readHeader(p);
    if (!hd) throw new Error("bad shard part");
    first ??= hd;
    if (hd.i !== i || hd.n !== parts.length || hd.seq !== first.seq || hd.nonce !== first.nonce || hd.project !== first.project) throw new Error("inconsistent shard parts");
    const o = JSON.parse(p) as { items: Item[] };
    if (!Array.isArray(o.items)) throw new Error("bad shard part");
    if (i === 0) out.project = hd.project;
    for (const [kind, val] of o.items) {
      if (kind === "files") Object.assign(out.files, fileRows(val as Parameters<typeof fileRows>[0]));
      else if (kind === "usage") out.usage.push(...usageRows(val as unknown[][]));
      else if (kind === "users") out.users.push(...userRows(val as Parameters<typeof userRows>[0]));
      else if (kind === "metas") out.metas.push(...metaRows(val as Parameters<typeof metaRows>[0]));
      else if (kind === "compacts") out.compacts.push(...(val as CompactRow[]));
      else if (kind === "snapshots") out.snapshots.push(...(val as unknown[]));
      else if (kind === "days") out.days = val as Record<string, number>;
      else if (kind === "fmt") out.fmt = val as number;
      else throw new Error(`unknown shard item: ${kind}`);
    }
    yield;
  }
  return out;
}

// Throws unless the parts are one complete save: same seq/nonce/project, i in order, n matching.
export function decodeShard(parts: string[]): Shard {
  const g = decodeGen(parts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Same result as decodeShard; awaits `tick` after every part. */
export async function decodeShardAsync(parts: string[], tick: Tick): Promise<Shard> {
  const g = decodeGen(parts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await tick();
  }
}

// Drops rows older than cutoffMs and files last modified before it. Metas follow their sessions.
export function trimShard(s: Shard, cutoffMs: number): Shard {
  const files: Record<string, ShardFile> = {};
  for (const [k, f] of Object.entries(s.files)) if (f.mtimeMs >= cutoffMs) files[k] = f;
  const usage = s.usage.filter((r) => r.ts >= cutoffMs);
  const users = s.users.filter((r) => r.ts >= cutoffMs);
  const compacts = s.compacts.filter((r) => r.ts >= cutoffMs);
  const live = new Set<string>();
  for (const f of Object.values(files)) live.add(f.sessionId);
  for (const r of usage) live.add(r.sessionId);
  for (const r of users) live.add(r.sessionId);
  for (const r of compacts) live.add(r.sessionId);
  const metas = s.metas.filter((m) => live.has(m.sessionId));
  const snapshots = s.snapshots.filter((x) => {
    const ts = (x as { ts?: unknown } | null)?.ts;
    return typeof ts !== "number" || ts >= cutoffMs;
  });
  return { ...s, files, usage, users, metas, compacts, snapshots };
}
