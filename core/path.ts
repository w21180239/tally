// Path helpers. Accept "/" and "\" separators; no host API.
type Env = (k: string) => string | undefined;

export function sepOf(p: string): "/" | "\\" {
  const b = p.indexOf("\\");
  const f = p.indexOf("/");
  if (b >= 0 && (f < 0 || b < f)) return "\\";
  return "/";
}

export function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== "");
}

export function baseName(p: string): string {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : "";
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = sepOf(base);
  let out = base.replace(/[\\/]+$/, "");
  for (const part of parts) {
    const seg = part.replace(/^[\\/]+|[\\/]+$/g, "");
    if (seg !== "") out += sep + seg.replace(/[\\/]/g, sep);
  }
  return out;
}

export function homeDir(env: Env): string {
  return env("HOME") || env("USERPROFILE") || "";
}

export function configDir(env: Env): string {
  return env("CLAUDE_CONFIG_DIR") || joinPath(homeDir(env), ".claude");
}

export function scanRoots(env: Env, platform: "darwin" | "win32" | "linux"): string[] {
  const home = homeDir(env);
  const roots = [joinPath(configDir(env), "projects")];
  const sessions = ["Claude", "local-agent-mode-sessions"];
  if (platform === "darwin") {
    roots.push(joinPath(home, "Library", "Application Support", ...sessions));
  } else if (platform === "win32") {
    roots.push(joinPath(env("APPDATA") || joinPath(home, "AppData", "Roaming"), ...sessions));
  } else {
    roots.push(joinPath(env("XDG_CONFIG_HOME") || joinPath(home, ".config"), ...sessions));
  }
  return roots;
}

export function isSubagentPath(p: string): boolean {
  return splitPath(p).includes("subagents");
}

// Worktrees fold into the host repo: <repo>/.claude/worktrees/x, <repo>/.git/worktrees/x,
// and <repo>-worktrees/x.
export function repoOf(cwd: string): string {
  const parts = splitPath(cwd);
  for (let i = 1; i + 1 < parts.length; i++) {
    if (parts[i + 1] === "worktrees" && (parts[i] === ".claude" || parts[i] === ".git")) {
      return parts[i - 1];
    }
  }
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (parent.length > "-worktrees".length && parent.endsWith("-worktrees")) {
      return parent.slice(0, -"-worktrees".length);
    }
  }
  return parts.length ? parts[parts.length - 1] : "";
}
