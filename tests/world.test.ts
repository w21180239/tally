import { describe, test, expect } from "claude-code/testing";
import { worldOf } from "./world.ts";

describe("fake world", () => {
  test("reads slice UTF-8 bytes and decode cut characters to U+FFFD", async () => {
    const w = worldOf();
    w.put("/d/f.txt", "aéb"); // a, 2-byte e-acute, b = 4 bytes
    expect(await w.$.fs.read("/d/f.txt", { offset: 1, length: 2 })).toBe("é");
    expect(await w.$.fs.read("/d/f.txt", { offset: 0, length: 2 })).toBe("a�");
    expect(w.reads.length).toBe(2);
  });

  test("list, exists, stat follow the files", async () => {
    const w = worldOf();
    w.put("/d/a.jsonl", "xx");
    w.put("/d/sub/b.jsonl", "y");
    const names = (await w.$.fs.list("/d")).map((e) => `${e.name}:${e.kind}`).sort();
    expect(names).toEqual(["a.jsonl:file", "sub:dir"]);
    expect(await w.$.fs.exists("/d/sub")).toBe(true);
    expect(await w.$.fs.exists("/d/none")).toBe(false);
    expect((await w.$.fs.stat("/d/a.jsonl")).size).toBe(2);
  });

  test("the Nth write fails, the rest succeed", async () => {
    const w = worldOf();
    w.failWriteAt = 2;
    await w.$.fs.write("/o/1", "a");
    let failed = false;
    await w.$.fs.write("/o/2", "b").catch(() => (failed = true));
    await w.$.fs.write("/o/3", "c");
    expect(failed).toBe(true);
    expect(w.writes.map((x) => x.path)).toEqual(["/o/1", "/o/3"]);
    expect(w.text("/o/2")).toBeUndefined();
  });

  test("manual clock fires sleep, after and every in order", async () => {
    const w = worldOf();
    const log: string[] = [];
    const t = w.$.clock.every(10, () => log.push("e"));
    w.$.clock.after(15, () => log.push("a"));
    void w.$.clock.sleep(25).then(() => log.push("s"));
    await w.advance(30);
    t.cancel();
    await w.advance(100);
    expect(log.slice(0, 3)).toEqual(["e", "a", "e"]);
    expect(log).toContain("s");
    expect(log.filter((x) => x === "e").length).toBe(3);
  });

  test("a view records its own reads and writes over the shared fs", async () => {
    const w = worldOf();
    const v1 = w.view();
    const v2 = w.view();
    await v1.$.fs.write("/v/a", "x");
    await v2.$.fs.read("/v/a");
    expect(v1.writes.length).toBe(1);
    expect(v2.writes.length).toBe(0);
    expect(v1.reads.length).toBe(0);
    expect(v2.reads.length).toBe(1);
    w.setMtime("/v/a", 5);
    expect((await w.$.fs.stat("/v/a")).mtimeMs).toBe(5);
  });

  test("store get/set/delete", async () => {
    const w = worldOf({ k: 1 });
    expect(await w.$.store.get("k")).toBe(1);
    await w.$.store.set("k", 2);
    await w.$.store.delete("k");
    expect(await w.$.store.get("k")).toBeUndefined();
  });
});
