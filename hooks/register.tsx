import type { Register } from "claude-code";

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "tally",
      description: "Show tally's version",
      argumentHint: "",
    });
    return started;
  });

  on("command.run", { command: "tally" }, async ($) => {
    let version = "";
    try {
      const m = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
      version = typeof m?.version === "string" ? m.version : "";
    } catch {
      version = "";
    }
    return { text: `tally ${version}` };
  });
};
