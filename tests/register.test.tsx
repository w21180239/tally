import { describe, expect, mock, test } from "claude-code/testing";
import { register } from "../hooks/register.tsx";
import { clockOf } from "./world.ts";

const run = (args: string) => ({ command: "tally", args, origin: { kind: "composer" as const }, presentation: { isFullscreen: true, columns: 200 } });

describe("/tally command routing", () => {
  test("debug --json answers the 30-day Summary JSON with the scan progress; debug stays text", async ($, on) => {
    register(on, {});
    clockOf(on, { now: Date.UTC(2026, 10, 27, 12) });
    mock.env(on, { HOME: "/home/u" });
    on("session.info", () => ({ value: { platform: "linux" } }));
    on("fs.list", () => ({ value: [] }));
    const json = JSON.parse((await $.command.run(run("debug --json"))).text);
    expect(json.total.usd).toBe(0);
    expect(json.byDay.length).toBe(30);
    expect(json.scan.phase).toBe("idle");
    const text = (await $.command.run(run("debug"))).text;
    expect(text).toContain("tally debug");
    expect(text).toContain("projects: 0");
    expect(text.startsWith("{")).toBe(false);
  });
});
