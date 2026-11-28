import { describe, test, expect } from "claude-code/testing";
import { agentIdOfPath, baseName, configDir, homeDir, isSubagentPath, joinPath, repoOf, scanRoots, sepOf, splitPath } from "../core/path.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];

describe("path", () => {
  test("sepOf and joinPath keep the base separator", () => {
    expect(sepOf("C:\\Users\\a")).toBe("\\");
    expect(sepOf("/Users/a")).toBe("/");
    expect(joinPath("C:\\Users\\a", ".claude", "projects")).toBe("C:\\Users\\a\\.claude\\projects");
    expect(joinPath("/Users/a", ".claude")).toBe("/Users/a/.claude");
    expect(joinPath("/Users/a/", "x")).toBe("/Users/a/x");
  });
  test("splitPath and baseName handle both separators", () => {
    expect(splitPath("C:\\a\\b/c")).toEqual(["C:", "a", "b", "c"]);
    expect(baseName("C:\\a\\b.jsonl")).toBe("b.jsonl");
    expect(baseName("/a/b/")).toBe("b");
  });
  test("homeDir prefers HOME, falls back to USERPROFILE", () => {
    expect(homeDir((k) => ({ USERPROFILE: "C:\\Users\\a" } as Record<string, string>)[k])).toBe("C:\\Users\\a");
    expect(homeDir(env({ HOME: "/h", USERPROFILE: "C:\\u" }))).toBe("/h");
  });
  test("configDir", () => {
    expect(configDir(env({ HOME: "/h" }))).toBe("/h/.claude");
    expect(configDir(env({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }))).toBe("/c");
    expect(configDir(env({ USERPROFILE: "C:\\u" }))).toBe("C:\\u\\.claude");
  });
  test("scanRoots per platform", () => {
    const mac = scanRoots(env({ HOME: "/Users/a" }), "darwin");
    expect(mac).toContain("/Users/a/.claude/projects");
    expect(mac).toContain("/Users/a/Library/Application Support/Claude/local-agent-mode-sessions");
    const win = scanRoots(env({ USERPROFILE: "C:\\Users\\a", APPDATA: "C:\\Users\\a\\AppData\\Roaming" }), "win32");
    expect(win).toContain("C:\\Users\\a\\.claude\\projects");
    expect(win).toContain("C:\\Users\\a\\AppData\\Roaming\\Claude\\local-agent-mode-sessions");
    const store = scanRoots(env({ USERPROFILE: "C:\\Users\\a", LOCALAPPDATA: "D:\\Local" }), "win32");
    expect(store).toContain("D:\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\local-agent-mode-sessions");
    expect(win).toContain("C:\\Users\\a\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\local-agent-mode-sessions");
    const lin = scanRoots(env({ HOME: "/home/a" }), "linux");
    expect(lin).toContain("/home/a/.config/Claude/local-agent-mode-sessions");
  });
  test("isSubagentPath", () => {
    expect(isSubagentPath("C:\\x\\proj\\s1\\subagents\\agent-1.jsonl")).toBe(true);
    expect(isSubagentPath("/x/proj/s1/subagents/agent-1.jsonl")).toBe(true);
    expect(isSubagentPath("/x/proj/s1.jsonl")).toBe(false);
  });
  test("agentIdOfPath names a sub-agent transcript and is undefined for a main one", () => {
    expect(agentIdOfPath("/x/proj/s1/subagents/agent-a1.jsonl")).toBe("agent-a1");
    expect(agentIdOfPath("C:\\x\\proj\\s1\\subagents\\agent-b2.jsonl")).toBe("agent-b2");
    expect(agentIdOfPath("/x/proj/s1.jsonl")).toBeUndefined();
  });
  test("repoOf folds worktrees into the host repo", () => {
    expect(repoOf("C:\\code\\shop\\.claude\\worktrees\\fix-1")).toBe("shop");
    expect(repoOf("/code/shop/.git/worktrees/x")).toBe("shop");
    expect(repoOf("/code/shop-worktrees/feat")).toBe("shop");
    expect(repoOf("/code/shop")).toBe("shop");
    expect(repoOf("/code/shop/")).toBe("shop");
  });
});
