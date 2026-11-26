// In-memory fake `$` for engine tests. The kit's `Engine` speaks hook events, not the plugin-side
// `$.fs.read(path, opts)` shape, so engine code is tested against this plain object instead.
type Entry = { bytes: Uint8Array; mtimeMs: number };
type Kind = "file" | "dir";
export type FsEntry = { name: string; kind: Kind; size: number; mtimeMs: number; isLink: boolean };
export type ReadCall = { path: string; offset: number; length: number | undefined };
export type WriteCall = { path: string; text: string };
type Waiter = { due: number; fn: () => void };

export const START_MS = 1_000_000;
const LIMIT = 4_194_304;

export type FakeEnv = {
  fs: {
    read(path: string, o?: { as?: "text"; offset?: number; length?: number }): Promise<string>;
    write(path: string, text: string): Promise<void>;
    list(path: string): Promise<FsEntry[]>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ kind: Kind; size: number; mtimeMs: number; isLink: boolean }>;
  };
  store: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void> };
  clock: {
    now(): Promise<number>;
    sleep(ms: number): Promise<void>;
    after(ms: number, fn: () => void): { cancel(): void };
    every(ms: number, fn: () => void): { cancel(): void };
  };
};

export type World = {
  $: FakeEnv;
  /** Every `$.fs.read`, in call order. */
  reads: ReadCall[];
  /** Successful `$.fs.write`s, in call order. */
  writes: WriteCall[];
  /** Total `$.fs.write` attempts so far, failed ones included. */
  writeCount: number;
  /** 1-based index of the write attempt that rejects; later writes succeed. */
  failWriteAt: number | undefined;
  /** Raw store contents. */
  stored: Map<string, unknown>;
  /** Create or replace a file; mtime bumps. */
  put(path: string, text: string): void;
  append(path: string, text: string): void;
  /** Cut a file to its first `bytes` bytes. */
  truncate(path: string, bytes: number): void;
  text(path: string): string | undefined;
  size(path: string): number | undefined;
  mtime(path: string): number | undefined;
  /** Manual clock: moves time and fires due sleeps, after and every callbacks in order. */
  advance(ms: number): Promise<void>;
  time(): number;
};

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

export function worldOf(storeEntries: Record<string, unknown> = {}): World {
  const files = new Map<string, Entry>();
  const stored = new Map<string, unknown>(Object.entries(storeEntries));
  let tick = 0;
  let clock = START_MS;
  let waiters: Waiter[] = [];
  const stamp = () => START_MS + ++tick;
  const isDir = (p: string) => {
    const prefix = norm(p) + "/";
    for (const k of files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  };
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });

  const world: World = {
    $: undefined as unknown as FakeEnv,
    reads: [],
    writes: [],
    writeCount: 0,
    failWriteAt: undefined,
    stored,
    put(path, text) {
      files.set(norm(path), { bytes: enc.encode(text), mtimeMs: stamp() });
    },
    append(path, text) {
      const cur = files.get(norm(path))?.bytes ?? new Uint8Array(0);
      const add = enc.encode(text);
      const bytes = new Uint8Array(cur.length + add.length);
      bytes.set(cur, 0);
      bytes.set(add, cur.length);
      files.set(norm(path), { bytes, mtimeMs: stamp() });
    },
    truncate(path, n) {
      const cur = files.get(norm(path));
      if (cur) files.set(norm(path), { bytes: cur.bytes.slice(0, n), mtimeMs: stamp() });
    },
    text: (path) => {
      const f = files.get(norm(path));
      return f ? dec.decode(f.bytes) : undefined;
    },
    size: (path) => files.get(norm(path))?.bytes.length,
    mtime: (path) => files.get(norm(path))?.mtimeMs,
    time: () => clock,
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const next = waiters.filter((w) => w.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        waiters = waiters.filter((w) => w !== next);
        clock = Math.max(clock, next.due);
        next.fn();
        await Promise.resolve();
      }
      clock = target;
    },
  };

  const timer = (ms: number, fn: () => void, repeat: boolean) => {
    let live = true;
    const arm = () => {
      const w: Waiter = {
        due: clock + ms,
        fn: () => {
          if (!live) return;
          if (repeat) arm();
          fn();
        },
      };
      waiters.push(w);
    };
    arm();
    return {
      cancel() {
        live = false;
      },
    };
  };

  world.$ = {
    fs: {
      async read(path, o = {}) {
        world.reads.push({ path, offset: o.offset ?? 0, length: o.length });
        const f = files.get(norm(path));
        if (!f) throw enoent(path);
        if (o.length !== undefined && o.length > LIMIT) throw new Error(`read length over 4 MiB: ${o.length}`);
        const from = o.offset ?? 0;
        const to = o.length === undefined ? f.bytes.length : Math.min(f.bytes.length, from + o.length);
        // A cut character decodes to U+FFFD, as in the engine.
        return dec.decode(f.bytes.subarray(from, to));
      },
      async write(path, text) {
        world.writeCount++;
        if (world.failWriteAt === world.writeCount) throw new Error(`EIO: write failed: ${path}`);
        const bytes = enc.encode(text);
        if (bytes.length > LIMIT) throw new Error(`write over 4 MiB: ${path}`);
        files.set(norm(path), { bytes, mtimeMs: stamp() });
        world.writes.push({ path, text });
      },
      async exists(path) {
        return files.has(norm(path)) || isDir(path);
      },
      async stat(path) {
        const f = files.get(norm(path));
        if (f) return { kind: "file", size: f.bytes.length, mtimeMs: f.mtimeMs, isLink: false };
        if (isDir(path)) return { kind: "dir", size: 0, mtimeMs: START_MS, isLink: false };
        throw enoent(path);
      },
      async list(path) {
        const base = norm(path);
        const prefix = base + "/";
        const out = new Map<string, FsEntry>();
        for (const [k, f] of files) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash < 0) out.set(rest, { name: rest, kind: "file", size: f.bytes.length, mtimeMs: f.mtimeMs, isLink: false });
          else {
            const name = rest.slice(0, slash);
            out.set(name, { name, kind: "dir", size: 0, mtimeMs: START_MS, isLink: false });
          }
        }
        if (out.size === 0 && !files.has(base)) throw enoent(path);
        return [...out.values()];
      },
    },
    store: {
      async get(k) {
        return stored.get(k);
      },
      async set(k, v) {
        stored.set(k, v);
      },
      async delete(k) {
        stored.delete(k);
      },
    },
    clock: {
      async now() {
        return clock;
      },
      sleep: (ms) => new Promise<void>((res) => void waiters.push({ due: clock + ms, fn: res })),
      after: (ms, fn) => timer(ms, fn, false),
      every: (ms, fn) => timer(ms, fn, true),
    },
  };
  return world;
}
