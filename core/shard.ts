import { utf8Length } from "./lines.ts";
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
};

export const PART_MAX = 3.5 * 1024 * 1024;
const USAGE_CHUNK = 500;
const ROW_CHUNK = 200;

// UsageRow as parallel columns: field names are written once per chunk, not once per row.
// flags: bit0 fast, bit1 sidechain, bit2 synthetic. Optional strings use null for "absent".
function usageCols(rows: UsageRow[]): unknown[] {
  const c = (f: (r: UsageRow) => unknown) => rows.map(f);
  const opt = (f: (r: UsageRow) => string | undefined) => rows.map((r) => f(r) ?? null);
  return [
    c((r) => r.requestId),
    c((r) => r.sessionId),
    c((r) => r.ts),
    c((r) => r.model),
    c((r) => r.tokens.input),
    c((r) => r.tokens.output),
    c((r) => r.tokens.cacheRead),
    c((r) => r.tokens.cw5m),
    c((r) => r.tokens.cw1h),
    c((r) => (r.fast ? 1 : 0) | (r.sidechain ? 2 : 0) | (r.synthetic ? 4 : 0)),
    opt((r) => r.cwd),
    c((r) => r.thinkingChars),
    c((r) => r.replyChars),
    c((r) => r.tools),
    opt((r) => r.skill),
    opt((r) => r.plugin),
    opt((r) => r.effort),
  ];
}

function usageRows(cols: unknown[][]): UsageRow[] {
  const n = cols[0].length;
  const out: UsageRow[] = [];
  for (let i = 0; i < n; i++) {
    const fl = cols[9][i] as number;
    const row: UsageRow = {
      requestId: cols[0][i] as string,
      sessionId: cols[1][i] as string,
      ts: cols[2][i] as number,
      model: cols[3][i] as string,
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
    if (cols[10][i] !== null) row.cwd = cols[10][i] as string;
    if (cols[14][i] !== null) row.skill = cols[14][i] as string;
    if (cols[15][i] !== null) row.plugin = cols[15][i] as string;
    if (cols[16][i] !== null) row.effort = cols[16][i] as string;
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

// Packs items into parts of at most PART_MAX UTF-8 bytes. Oversize chunks are halved; a single
// row that still does not fit is dropped and counted. Every part carries {seq, nonce, i, n, project}
// so a reader can tell parts of one save from parts of another.
export function encodeShardEx(s: Shard, h: { seq: number; nonce: string } = { seq: 0, nonce: "" }): { parts: string[]; dropped: number } {
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
  const emit = <T,>(kind: string, list: T[], enc: (l: T[]) => unknown) => {
    const it = JSON.stringify([kind, enc(list)]);
    const n = utf8Length(it) + 1;
    if (n <= budget) return add(it, n);
    if (list.length === 1) {
      dropped++;
      return;
    }
    const mid = list.length >> 1;
    emit(kind, list.slice(0, mid), enc);
    emit(kind, list.slice(mid), enc);
  };
  const chunked = <T,>(kind: string, list: T[], step: number, enc: (l: T[]) => unknown) => {
    for (let i = 0; i < list.length; i += step) emit(kind, list.slice(i, i + step), enc);
  };
  chunked("files", Object.entries(s.files), ROW_CHUNK, (l) => Object.fromEntries(l));
  chunked("usage", s.usage, USAGE_CHUNK, usageCols);
  chunked("users", s.users, ROW_CHUNK, (l) => l);
  chunked("metas", s.metas, ROW_CHUNK, (l) => l);
  chunked("compacts", s.compacts, ROW_CHUNK, (l) => l);
  chunked("snapshots", s.snapshots, ROW_CHUNK, (l) => l);
  if (cur.length || groups.length === 0) groups.push(cur);
  const n = groups.length;
  const parts = groups.map(
    (g, i) => `{"v":1,"project":${project},"seq":${h.seq},"nonce":${JSON.stringify(h.nonce)},"i":${i},"n":${n},"items":[${g.join(",")}]}`,
  );
  return { parts, dropped };
}

export function encodeShard(s: Shard, h?: { seq: number; nonce: string }): string[] {
  return encodeShardEx(s, h).parts;
}

// Throws unless the parts are one complete save: same seq/nonce/project, i in order, n matching.
export function decodeShard(parts: string[]): Shard {
  const out: Shard = { v: 1, project: "", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
  let first: PartHeader | null = null;
  parts.forEach((p, i) => {
    const hd = readHeader(p);
    if (!hd) throw new Error("bad shard part");
    first ??= hd;
    if (hd.i !== i || hd.n !== parts.length || hd.seq !== first.seq || hd.nonce !== first.nonce || hd.project !== first.project) throw new Error("inconsistent shard parts");
    const o = JSON.parse(p) as { items: Item[] };
    if (!Array.isArray(o.items)) throw new Error("bad shard part");
    if (i === 0) out.project = hd.project;
    for (const [kind, val] of o.items) {
      if (kind === "files") Object.assign(out.files, val);
      else if (kind === "usage") out.usage.push(...usageRows(val as unknown[][]));
      else if (kind === "users") out.users.push(...(val as UserRow[]));
      else if (kind === "metas") out.metas.push(...(val as MetaRow[]));
      else if (kind === "compacts") out.compacts.push(...(val as CompactRow[]));
      else if (kind === "snapshots") out.snapshots.push(...(val as unknown[]));
      else throw new Error(`unknown shard item: ${kind}`);
    }
  });
  return out;
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
