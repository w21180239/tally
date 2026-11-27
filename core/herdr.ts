// Where Herdr.app keeps its mods. Pure: the caller checks that the folder exists.
import { homeDir, joinPath } from "./path.ts";

type Env = (k: string) => string | undefined;
type Platform = "darwin" | "win32" | "linux";

/** Herdr's data folder: `HERDR_APP_HOME`, else `%APPDATA%\herdr-app` on Windows, else `~/.config/herdr-app`. */
export function herdrRootDir(env: Env, platform: Platform): string | null {
  const override = env("HERDR_APP_HOME");
  if (override) return override;
  if (platform === "win32") {
    const base = env("APPDATA") || (homeDir(env) ? joinPath(homeDir(env), "AppData", "Roaming") : "");
    return base ? joinPath(base, "herdr-app") : null;
  }
  const home = homeDir(env);
  return home ? joinPath(home, ".config", "herdr-app") : null;
}

/** The folder Herdr loads mods from, or null when no home can be found. */
export function herdrModsDir(env: Env, platform: Platform): string | null {
  const root = herdrRootDir(env, platform);
  return root === null ? null : joinPath(root, "mods");
}
