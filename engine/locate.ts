import { configDir, scanRoots } from "../core/path.ts";

type Platform = "darwin" | "win32" | "linux";
type EnvMap = Record<string, string | undefined>;
type Host = {
  env: { get(name: string): Promise<string | undefined> };
  session: { info(): Promise<{ platform?: string }> };
};

// Each name is its own literal call: the engine rejects a non-literal `$.env.get` argument.
export async function readEnv($: Pick<Host, "env">): Promise<EnvMap> {
  return {
    CLAUDE_CONFIG_DIR: await $.env.get("CLAUDE_CONFIG_DIR"),
    HOME: await $.env.get("HOME"),
    USERPROFILE: await $.env.get("USERPROFILE"),
    APPDATA: await $.env.get("APPDATA"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
  };
}

export async function platformOf($: Pick<Host, "session">, env: EnvMap): Promise<Platform> {
  try {
    const p = (await $.session.info()).platform;
    if (p === "macos") return "darwin";
    if (p === "windows") return "win32";
    if (p === "linux" || p === "wsl") return "linux";
  } catch {
    /* fall through to the env guess */
  }
  return !env.HOME && (env.USERPROFILE || env.APPDATA) ? "win32" : "linux";
}

/** The Claude config dir and the transcript roots of this machine. */
export async function locate($: Host): Promise<{ cfg: string; roots: string[] }> {
  const env = await readEnv($);
  const get = (k: string) => env[k];
  return { cfg: configDir(get), roots: scanRoots(get, await platformOf($, env)) };
}
