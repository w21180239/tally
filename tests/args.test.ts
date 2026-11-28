import { describe, expect, test } from "claude-code/testing";
import { parseArgs, unknownText } from "../core/args.ts";
import { readSettings } from "../core/settings.ts";

describe("parseArgs", () => {
  test("empty input", () => {
    expect(parseArgs("")).toEqual({ set: {}, unknown: [] });
    expect(parseArgs("   ")).toEqual({ set: {}, unknown: [] });
  });

  test("order is free", () => {
    const a = parseArgs("history money cents");
    const b = parseArgs("money cents history");
    expect(a).toEqual(b);
    expect(a).toEqual({ set: { money: "cents" }, tab: "history", unknown: [] });
    expect(parseArgs("30d usage decimals 2")).toEqual(parseArgs("decimals 2 usage 30d"));
  });

  test("tabs and spans", () => {
    for (const t of ["session", "usage", "context", "history", "hints", "help"] as const) expect(parseArgs(t).tab).toBe(t);
    expect(parseArgs("history 30d").span).toBe("30d");
    expect(parseArgs("24h usage")).toEqual({ set: {}, tab: "usage", span: "24h", unknown: [] });
  });

  test("words are case-insensitive", () => {
    expect(parseArgs("HISTORY Money CENTS 30D")).toEqual({ set: { money: "cents" }, tab: "history", span: "30d", unknown: [] });
  });

  test("subcommands", () => {
    expect(parseArgs("report 7d").sub).toBe("report");
    expect(parseArgs("debug").sub).toBe("debug");
    expect(parseArgs("sync").sub).toBe("sync");
    expect(parseArgs("debug --json")).toEqual({ set: {}, sub: "debug", json: true, unknown: [] });
  });

  test("report days and repo", () => {
    expect(parseArgs("report 7d")).toEqual({ set: {}, sub: "report", days: 7, unknown: [] });
    expect(parseArgs("report 7")).toEqual({ set: {}, sub: "report", days: 7, unknown: [] });
    expect(parseArgs("report 30d MyRepo")).toEqual({ set: {}, sub: "report", days: 30, repo: "MyRepo", unknown: [] });
    expect(parseArgs("MyRepo report 14")).toEqual({ set: {}, sub: "report", days: 14, repo: "MyRepo", unknown: [] });
    expect(parseArgs("report").days).toBeUndefined();
    expect(parseArgs("report 0d").unknown).toEqual(["0d"]);
  });

  test("setting pairs", () => {
    expect(parseArgs("money dollars").set).toEqual({ money: "dollars" });
    expect(parseArgs("decimals auto").set).toEqual({ decimals: "auto" });
    expect(parseArgs("decimals 4").set).toEqual({ decimals: "4" });
    expect(parseArgs("open never").set).toEqual({ open: "never" });
    expect(parseArgs("row off").set).toEqual({ desktopRow: false });
    expect(parseArgs("row on").set).toEqual({ desktopRow: true });
    expect(parseArgs("desktopRow off").set).toEqual({ desktopRow: false });
    expect(parseArgs("herdrSidebar true").set).toEqual({ herdrSidebar: true });
    expect(parseArgs("recheckDays 30").set).toEqual({ recheckDays: 30 });
    expect(parseArgs("shareDetail repos").set).toEqual({ shareDetail: "repos" });
    expect(parseArgs("priceUpdate off redactEvidence on").set).toEqual({ priceUpdate: false, redactEvidence: true });
  });

  test("string settings keep case", () => {
    expect(parseArgs("machineName Laptop-1").set).toEqual({ machineName: "Laptop-1" });
    expect(parseArgs("syncDir /Data/Sync").set).toEqual({ syncDir: "/Data/Sync" });
  });

  test("prototype-property names are plain unknown words", () => {
    for (const w of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(parseArgs(`${w} x`)).toEqual({ set: {}, unknown: [w, "x"] });
      expect(parseArgs(`${w} report`)).toEqual({ set: {}, sub: "report", repo: w, unknown: [] });
    }
  });

  test("quoted values keep spaces and backslashes", () => {
    expect(parseArgs('syncDir "C:\\My Docs\\Sync"')).toEqual({ set: { syncDir: "C:\\My Docs\\Sync" }, unknown: [] });
    expect(parseArgs("syncDir 'C:\\My Docs' history").set).toEqual({ syncDir: "C:\\My Docs" });
    expect(parseArgs("syncDir 'C:\\My Docs' history").tab).toBe("history");
    expect(parseArgs('machineName "Work Laptop" money cents').set).toEqual({ machineName: "Work Laptop", money: "cents" });
    expect(parseArgs('syncDir ""').set).toEqual({ syncDir: "" });
  });

  test("quoted words are data, never keywords", () => {
    expect(parseArgs('"history"')).toEqual({ set: {}, unknown: ["history"] });
    expect(parseArgs('report "my repo" 7d')).toEqual({ set: {}, sub: "report", days: 7, repo: "my repo", unknown: [] });
  });

  test("an unterminated quote is plain text", () => {
    expect(parseArgs('syncDir "C:\\My Docs').set).toEqual({ syncDir: '"C:\\My' });
    expect(parseArgs('syncDir "C:\\My Docs').unknown).toEqual(["Docs"]);
  });

  test("several settings in one line", () => {
    expect(parseArgs("money cents decimals 1 row off").set).toEqual({ money: "cents", decimals: "1", desktopRow: false });
  });

  test("invalid values and unknown words go to unknown", () => {
    expect(parseArgs("money bogus")).toEqual({ set: {}, unknown: ["money", "bogus"] });
    expect(parseArgs("decimals 5").set).toEqual({});
    expect(parseArgs("decimals 5").unknown).toEqual(["decimals", "5"]);
    expect(parseArgs("recheckDays 0").unknown).toEqual(["recheckDays", "0"]);
    expect(parseArgs("row maybe").set).toEqual({});
    expect(parseArgs("foo history bar")).toEqual({ set: {}, tab: "history", unknown: ["foo", "bar"] });
    expect(parseArgs("money")).toEqual({ set: {}, unknown: ["money"] });
    expect(parseArgs("--nope").unknown).toEqual(["--nope"]);
  });

  test("a bad setting value does not swallow a following tab word", () => {
    expect(parseArgs("money history")).toEqual({ set: {}, tab: "history", unknown: ["money"] });
  });

  test("bare numbers are unknown outside report", () => {
    expect(parseArgs("history 7d").unknown).toEqual(["7d"]);
  });

  test("the old word tokens means the Usage tab", () => {
    expect(parseArgs("tokens")).toEqual({ set: {}, tab: "usage", unknown: [] });
    expect(parseArgs("tokens 24h")).toEqual({ set: {}, tab: "usage", span: "24h", unknown: [] });
  });

  test("money accepts both|mixed|auto, dollar(s), cent(s) and an `only` after them", () => {
    for (const w of ["both", "mixed", "auto"]) expect(parseArgs(`money ${w}`).set).toEqual({ money: "cents-and-dollars" });
    for (const w of ["dollar", "dollars"]) expect(parseArgs(`money ${w}`).set).toEqual({ money: "dollars" });
    for (const w of ["cent", "cents"]) expect(parseArgs(`money ${w}`).set).toEqual({ money: "cents" });
    expect(parseArgs("money dollars only")).toEqual({ set: { money: "dollars" }, unknown: [] });
    expect(parseArgs("money cents only history")).toEqual({ set: { money: "cents" }, tab: "history", unknown: [] });
    expect(parseArgs("money Both").set).toEqual({ money: "cents-and-dollars" });
  });

  test("row accepts show and hide", () => {
    expect(parseArgs("row show").set).toEqual({ desktopRow: true });
    expect(parseArgs("row hide").set).toEqual({ desktopRow: false });
    expect(parseArgs("desktopRow hide").set).toEqual({ desktopRow: false });
    // show/hide are not boolean words for the other settings.
    expect(parseArgs("priceUpdate hide").unknown).toEqual(["priceUpdate", "hide"]);
  });

  test("a leading settings word is noise; alone it opens Help", () => {
    expect(parseArgs("settings money cents")).toEqual({ set: { money: "cents" }, unknown: [] });
    expect(parseArgs("settings")).toEqual({ set: {}, tab: "help", unknown: [] });
  });
});

describe("unknownText", () => {
  const say = (input: string): string => unknownText(input, parseArgs(input));
  test("a setting with no value names the allowed values and an example", () => {
    expect(say("money")).toBe('"money" needs a value: cents-and-dollars, cents or dollars (for example /tally money cents).');
    expect(say("decimals")).toContain("auto or 0 to 4");
    expect(say("row")).toContain("on or off");
    expect(say("money history")).toContain('"money" needs a value');
  });
  test("a setting with a wrong value says which value and what is allowed", () => {
    expect(say("money bogus")).toBe('"bogus" is not a value for money: use cents-and-dollars, cents or dollars.');
    expect(say("decimals 9")).toBe('"9" is not a value for decimals: use auto or 0 to 4.');
    expect(say("open sometimes")).toContain("before-first-message, always or never");
  });
  test("a bad report day count is explained", () => {
    expect(say("report 0")).toContain("report 7");
    expect(say("report 0d")).toContain('"0d"');
  });
  test("any other word gets the list of what the command takes", () => {
    const t = say("foo history");
    expect(t.startsWith('"foo" is not a tab')).toBe(true);
    expect(t).toContain("report");
  });
});

describe("readSettings", () => {
  test("defaults", () => {
    expect(readSettings({})).toEqual({
      priceUpdate: true,
      syncDir: "",
      machineName: "",
      shareDetail: "numbers",
      redactEvidence: false,
      recheckDays: 14,
      open: "before-first-message",
      money: "cents-and-dollars",
      decimals: "auto",
      desktopRow: true,
      herdrSidebar: false,
    });
  });

  test("valid values pass through", () => {
    const s = readSettings({ priceUpdate: false, syncDir: "/x", machineName: "m", shareDetail: "full", redactEvidence: true, recheckDays: 30, open: "never", money: "dollars", decimals: "3", desktopRow: false, herdrSidebar: true });
    expect(s.priceUpdate).toBe(false);
    expect(s.syncDir).toBe("/x");
    expect(s.machineName).toBe("m");
    expect(s.shareDetail).toBe("full");
    expect(s.redactEvidence).toBe(true);
    expect(s.recheckDays).toBe(30);
    expect(s.open).toBe("never");
    expect(s.money).toBe("dollars");
    expect(s.decimals).toBe("3");
    expect(s.desktopRow).toBe(false);
    expect(s.herdrSidebar).toBe(true);
  });

  test("host-style string values are coerced", () => {
    const s = readSettings({ decimals: 2, recheckDays: "7", desktopRow: "false", herdrSidebar: "true", priceUpdate: "off" });
    expect(s.decimals).toBe("2");
    expect(s.recheckDays).toBe(7);
    expect(s.desktopRow).toBe(false);
    expect(s.herdrSidebar).toBe(true);
    expect(s.priceUpdate).toBe(false);
  });

  test("invalid values fall back to defaults", () => {
    const s = readSettings({ open: "sometimes", money: 5, decimals: "9", recheckDays: -3, shareDetail: "all", desktopRow: "maybe", syncDir: 4, machineName: null });
    expect(s.open).toBe("before-first-message");
    expect(s.money).toBe("cents-and-dollars");
    expect(s.decimals).toBe("auto");
    expect(s.recheckDays).toBe(14);
    expect(s.shareDetail).toBe("numbers");
    expect(s.desktopRow).toBe(true);
    expect(s.syncDir).toBe("");
    expect(s.machineName).toBe("");
  });
});
