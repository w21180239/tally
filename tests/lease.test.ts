import { describe, expect, test } from "claude-code/testing";
import { acquireLease, heartbeat, releaseLease } from "../engine/lease.ts";
import { worldOf } from "./world.ts";

const CFG = "/cfg";
const LEASE = "/cfg/tally/lease.json";

// Let pending acquires reach their 300 ms sleep, then move the clock past it.
async function settle(w: ReturnType<typeof worldOf>, ms = 300) {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await w.advance(ms);
}

describe("scan lease", () => {
  test("acquire on a missing file writes and wins", async () => {
    const w = worldOf();
    const p = acquireLease(w.$, CFG, "a", w.time());
    await settle(w);
    expect(await p).toBe(true);
    expect(JSON.parse(w.text(LEASE)!)).toEqual({ sessionId: "a", beatMs: w.time() - 300 });
  });

  test("two sessions at the same moment: exactly one wins", async () => {
    const w = worldOf();
    const now = w.time();
    const pa = acquireLease(w.$, CFG, "a", now);
    const pb = acquireLease(w.$, CFG, "b", now);
    await settle(w);
    const r = [await pa, await pb];
    expect(r.filter(Boolean).length).toBe(1);
    expect(r).toEqual([false, true]);
  });

  test("live holder blocks another session without writing", async () => {
    const w = worldOf();
    w.put(LEASE, JSON.stringify({ sessionId: "a", beatMs: w.time() - 10_000 }));
    const before = w.writeCount;
    expect(await acquireLease(w.$, CFG, "b", w.time())).toBe(false);
    expect(w.writeCount).toBe(before);
  });

  test("holder silent for 91 s loses the lease", async () => {
    const w = worldOf();
    w.put(LEASE, JSON.stringify({ sessionId: "a", beatMs: w.time() }));
    await w.advance(91_000);
    const p = acquireLease(w.$, CFG, "b", w.time());
    await settle(w);
    expect(await p).toBe(true);
  });

  test("holder at 89 s keeps the lease", async () => {
    const w = worldOf();
    w.put(LEASE, JSON.stringify({ sessionId: "a", beatMs: w.time() }));
    await w.advance(89_000);
    expect(await acquireLease(w.$, CFG, "b", w.time())).toBe(false);
  });

  test("garbage lease file counts as free", async () => {
    const w = worldOf();
    w.put(LEASE, "{not json");
    const p = acquireLease(w.$, CFG, "a", w.time());
    await settle(w);
    expect(await p).toBe(true);
  });

  test("re-acquire by the holder succeeds", async () => {
    const w = worldOf();
    w.put(LEASE, JSON.stringify({ sessionId: "a", beatMs: w.time() }));
    const p = acquireLease(w.$, CFG, "a", w.time());
    await settle(w);
    expect(await p).toBe(true);
  });

  test("release frees the lease at once", async () => {
    const w = worldOf();
    const pa = acquireLease(w.$, CFG, "a", w.time());
    await settle(w);
    expect(await pa).toBe(true);
    await releaseLease(w.$, CFG, "a");
    const pb = acquireLease(w.$, CFG, "b", w.time());
    await settle(w);
    expect(await pb).toBe(true);
  });

  test("release by a non-holder does not write", async () => {
    const w = worldOf();
    w.put(LEASE, JSON.stringify({ sessionId: "a", beatMs: w.time() }));
    const before = w.writeCount;
    await releaseLease(w.$, CFG, "b");
    expect(w.writeCount).toBe(before);
  });

  test("heartbeat refreshes beatMs only for the holder", async () => {
    const w = worldOf();
    w.put(LEASE, JSON.stringify({ sessionId: "a", beatMs: w.time() }));
    await w.advance(30_000);
    expect(await heartbeat(w.$, CFG, "b")).toBe(false);
    expect(await heartbeat(w.$, CFG, "a")).toBe(true);
    expect(JSON.parse(w.text(LEASE)!).beatMs).toBe(w.time());
  });

  test("heartbeat on a missing file is false", async () => {
    const w = worldOf();
    expect(await heartbeat(w.$, CFG, "a")).toBe(false);
  });
});
