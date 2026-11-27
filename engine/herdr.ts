// Installs or removes the Herdr.app sidebar mod (herdr/main.js) under Herdr's mods folder.
import { configDir, joinPath } from "../core/path.ts";
import { herdrRootDir } from "../core/herdr.ts";
import { platformOf, readEnv } from "./locate.ts";

/** Hidden file that marks `mods/tally` as ours: a folder without it is never written or deleted. */
export const MARKER = ".tally-plugin";
/** Hidden file naming the folder that holds the report snapshots; hidden files do not make Herdr reload the mod. */
export const SOURCE = ".tally-source.json";
const MOD_NAME = "tally";

/** What a disabled folder holds when it cannot be deleted: a mod that draws nothing. */
export const STUB_MAIN = `// Disabled by the tally plugin (herdrSidebar is off). Safe to delete this folder.
import * as kit from "gpui-kit";

export default class TallyOff extends kit.View {
  render() {
    return kit.div();
  }
}
`;
const STUB_MOD = '{ "title": "Tally (off)", "focusable": false }\n';

type Host = {
  env: { get(name: string): Promise<string | undefined> };
  session: { info(): Promise<{ platform?: string }> };
  plugin: { root: string };
  // CLI only: reading it in another surface throws, which the caller treats as "cannot delete".
  process: { run(argv: readonly string[]): Promise<{ exitCode: number }> };
  fs: {
    read(path: string, o?: { as?: "text" }): Promise<string>;
    write(path: string, text: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
};

export type HerdrResult = "no-herdr" | "no-template" | "foreign" | "absent" | "written" | "current" | "removed" | "disabled";

async function readOr($: Pick<Host, "fs">, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path);
  } catch {
    return undefined;
  }
}

// Writes only when the text differs, so Herdr is not told to reload a mod that has not changed.
async function put($: Pick<Host, "fs">, path: string, text: string): Promise<boolean> {
  if ((await readOr($, path)) === text) return false;
  await $.fs.write(path, text);
  return true;
}

async function fromTemplate($: Host, name: string): Promise<string | undefined> {
  return readOr($, joinPath($.plugin.root, "herdr", name));
}

/**
 * Brings Herdr's `mods/tally` in line with the `herdrSidebar` setting. Does nothing when Herdr has no
 * data folder. Never touches a `mods/tally` that lacks the marker. Rejects only on a failed write.
 */
export async function syncHerdr($: Host, settings: { herdrSidebar: boolean }): Promise<HerdrResult> {
  const env = await readEnv($);
  env.HERDR_APP_HOME = await $.env.get("HERDR_APP_HOME");
  const get = (k: string) => env[k];
  const platform = await platformOf($, env);
  const root = herdrRootDir(get, platform);
  if (root === null || !(await $.fs.exists(root))) return "no-herdr";
  const dir = joinPath(root, "mods", MOD_NAME);
  const marker = joinPath(dir, MARKER);
  const mine = await $.fs.exists(marker);
  const there = mine || (await $.fs.exists(dir));

  if (!settings.herdrSidebar) {
    if (!there) return "absent";
    if (!mine) return "foreign";
    return removeMod($, dir, platform, marker);
  }

  if (there && !mine) return "foreign";
  const main = await fromTemplate($, "main.js");
  const mod = await fromTemplate($, "mod.json");
  if (main === undefined || mod === undefined) return "no-template";
  const source = `${JSON.stringify({ reports: joinPath(configDir(get), "tally") })}\n`;
  // Marker first, main.js last: Herdr reloads on a visible file, so by then the folder is complete.
  const changed = [await put($, marker, "tally\n"), await put($, joinPath(dir, SOURCE), source), await put($, joinPath(dir, "mod.json"), mod), await put($, joinPath(dir, "main.js"), main)];
  return changed.some(Boolean) ? "written" : "current";
}

// $.fs cannot delete, so the folder goes through the CLI's process API; without it, or if that fails, the mod is blanked in place.
async function removeMod($: Host, dir: string, platform: string, marker: string): Promise<HerdrResult> {
  const argv = platform === "win32" ? ["cmd", "/c", "rmdir", "/s", "/q", dir] : ["rm", "-rf", dir];
  try {
    const r = await $.process.run(argv);
    if (r.exitCode === 0) return "removed";
  } catch {
    /* no process API here: fall through to the stub */
  }
  await put($, joinPath(dir, "main.js"), STUB_MAIN);
  await put($, joinPath(dir, "mod.json"), STUB_MOD);
  await put($, marker, "tally\n");
  return "disabled";
}
