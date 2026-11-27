// Written by tally while its herdrSidebar setting is on; tally removes the folder when the setting goes off.
//
// A sidebar view of tally's spend report: totals, costliest models and repos, and the hints. Nothing is
// scanned here. The figures are those of the last scan a Claude Code window finished, read from the two
// snapshot files in the folder that .tally-source.json names.
import * as kit from "gpui-kit";
import * as base from "gpui-base";
import * as herdr from "herdr";

const { div } = kit;
const column = base.v_flex;
const row = base.h_flex;

const SPANS = ["24h", "30d"];
const READ_MS = 20000;
const NOTE_MS = 2500;
const TOP_N = 5;

const modRoot = () => `${herdr.appHome()}/mods/tally`;

// null when the file is missing, undefined when its text does not parse.
async function readJson(path) {
  const text = await herdr.readTextFile(path);
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data;
  } catch {
    return undefined;
  }
}

// One span's snapshot as { report } or { error }.
async function loadSpan(span) {
  const source = await readJson(`${modRoot()}/.tally-source.json`);
  if (!source || !source.reports) return { error: "This sidebar does not know where tally keeps its reports yet. Open a Claude Code window with tally and herdrSidebar on, and it will." };
  const raw = await readJson(`${source.reports}/report-${span}.json`);
  if (raw === null) return { error: `No ${span} report yet: tally writes one once a Claude Code window has finished a scan.` };
  if (raw === undefined || typeof raw !== "object") return { error: `The ${span} report is unreadable.` };
  return { report: raw };
}

const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asText = (v) => (typeof v === "string" && v !== "" ? v : null);

// Costliest first, a few entries; malformed entries are dropped.
function topOf(map) {
  if (!map || typeof map !== "object") return [];
  const rows = [];
  for (const name of Object.keys(map)) {
    const usd = asNumber(map[name] && map[name].usd);
    if (usd !== null) rows.push({ name, usd });
  }
  return rows.sort((a, b) => b.usd - a.usd).slice(0, TOP_N);
}

// What the sidebar shows of a report. Any block that is missing or malformed comes out empty.
function viewOf(raw) {
  const sum = (raw && raw.summary) || {};
  const list = raw && Array.isArray(raw.hints) ? raw.hints : [];
  const hints = [];
  for (const h of list) {
    if (h && asText(h.title)) hints.push({ title: h.title, usd: asNumber(h.usd), why: asText(h.summary), todo: asText(h.action) });
  }
  return {
    at: asNumber(raw && raw.generatedAt),
    total: asNumber(sum.total && sum.total.usd),
    requests: asNumber(sum.total && sum.total.requests),
    main: asNumber(sum.main && sum.main.usd),
    sub: asNumber(sum.sub && sum.sub.usd),
    models: topOf(sum.byModel),
    repos: topOf(sum.byRepo),
    hints,
  };
}

const money = (n) => `$${n.toFixed(2)}`;

function agoText(at, now) {
  if (at === null) return "";
  const mins = Math.max(0, Math.floor((now - at) / 60000));
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 48 ? `Updated ${hrs} h ago` : `Updated ${Math.floor(hrs / 24)} days ago`;
}

// The prompt behind the copy button, for pasting into Claude Code.
function promptText(span, view) {
  const n = view.hints.length;
  const out = [`Tally flagged ${n} thing${n === 1 ? "" : "s"} that cost me the most in Claude Code over the last ${span}. Take them in order: say what you would change, and wait for my go before touching anything.`, ""];
  view.hints.forEach((h, i) => {
    out.push(`${i + 1}. ${h.title}${h.usd === null ? "" : ` (about ${money(h.usd)})`}`);
    if (h.why) out.push(`   Why: ${h.why}`);
    if (h.todo) out.push(`   Do: ${h.todo}`);
  });
  return out.join("\n");
}

// exec has no stdin, so the text rides in as $0 and a one-line shell pipes it to each candidate in turn.
const CLIPBOARDS = [["wl-copy"], ["xclip", "-selection", "clipboard"], ["pbcopy"]];

async function putOnClipboard(text) {
  for (const argv of CLIPBOARDS) {
    const r = await herdr.exec("sh", ["-c", 'export LC_CTYPE=en_US.UTF-8; printf "%s" "$0" | "$@"', text, ...argv]).catch(() => null);
    if (r && r.code === 0) return;
  }
  // Windows: the text goes in base64 so quotes and newlines never reach the command line.
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const w = await herdr.exec("powershell", ["-NoProfile", "-Command", `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | Set-Clipboard`]).catch(() => null);
  if (!w || w.code !== 0) throw Error("nothing to copy with was found");
}

// The theme colours under the names used below.
const palette = (t) => ({ page: t.background, ink: t.foreground, muted: t.dim, line: t.border, card: t.raised, over: t.hover, ring: t.accent });

// Drawing helpers; each takes the palette `p`.
function chip(id, label, on, p, onPress) {
  const bg = on ? p.card : p.page;
  const el = div();
  return el.id(id).bg(bg).rounded(4).py(2).px(7).text_size(10.5).text_color(on ? p.ink : p.muted).cursor_pointer()
    .on_click((_ev, ctx) => onPress(ctx))
    .hover((s) => s.bg(p.over))
    .child(label);
}

function heading(text, p) {
  return div().text_size(10.5).text_color(p.muted).child(text);
}

function ranking(title, rows, p) {
  let box = column().gap(2).child(heading(title, p));
  for (const r of rows) box = box.child(row().gap(6).child(div().flex_1().child(r.name)).child(div().text_color(p.muted).child(money(r.usd))));
  return box;
}

function hintCard(h, p) {
  let box = column().gap(3).p(8).rounded(6).bg(p.card)
    .child(row().gap(6).child(div().flex_1().font_semibold().child(h.title)).child(div().text_color(p.muted).child(h.usd === null ? "" : money(h.usd))));
  if (h.why) box = box.child(div().text_size(11).child(h.why));
  if (h.todo) box = box.child(div().text_size(11).text_color(p.muted).child(`Do: ${h.todo}`));
  return box;
}

function bodyOf(snap, view, p) {
  let box = column().id("tally-body").gap(12).p(10).flex_1().overflow_y_scrollbar().min_h(0);
  if (!snap) return box.child(div().text_color(p.muted).child("Reading the report..."));
  if (!view) return box.child(div().text_color(p.muted).child(snap.error));
  if (view.total !== null) {
    const bits = [view.requests === null ? null : `${view.requests} requests`, view.main === null ? null : `main ${money(view.main)}`, view.sub === null ? null : `sub-agents ${money(view.sub)}`];
    box = box.child(column().gap(2)
      .child(div().text_size(20).font_semibold().child(money(view.total)))
      .child(div().text_size(10.5).text_color(p.muted).child(bits.filter((b) => b !== null).join(", "))));
  }
  if (view.models.length > 0) box = box.child(ranking("Top models", view.models, p));
  if (view.repos.length > 0) box = box.child(ranking("Top repos", view.repos, p));
  if (view.hints.length === 0) return box.child(div().text_color(p.muted).child("No hints for this span."));
  let cards = column().gap(6).child(heading(`Hints (${view.hints.length})`, p));
  for (const h of view.hints) cards = cards.child(hintCard(h, p));
  return box.child(cards);
}

export default class Tally extends kit.View {
  init(_props, ctx) {
    this.span = localStorage.getItem("span") === "30d" ? "30d" : "24h";
    // span -> what loadSpan returned; empty until the first read lands.
    this.snaps = {};
    this.note = null;
    this.anchor = ctx.focus_handle();
    ctx.spawn(async (c) => {
      while (true) {
        if ((await herdr.nextCommand()) !== "focus") continue;
        this.anchor.focus();
        c.notify();
      }
    });
    ctx.timer.every(READ_MS, (c) => this.reload(c));
    this.reload(ctx);
  }

  reload(ctx) {
    ctx.spawn(async (c) => {
      for (const span of SPANS) this.snaps[span] = await loadSpan(span);
      c.notify();
    });
  }

  pick(span, ctx) {
    if (span === this.span) return;
    this.span = span;
    localStorage.setItem("span", span);
    ctx.notify();
  }

  view() {
    const snap = this.snaps[this.span];
    return snap && snap.report ? viewOf(snap.report) : null;
  }

  sendToClipboard(ctx) {
    const view = this.view();
    if (!view || view.hints.length === 0) return;
    ctx.spawn(async (c) => {
      let text = "Copied";
      try {
        await putOnClipboard(promptText(this.span, view));
      } catch (err) {
        text = String((err && err.message) || err);
      }
      const note = { text, until: Date.now() + NOTE_MS };
      this.note = note;
      c.notify();
      c.timer.after(NOTE_MS + 50, (c2) => c2.notify());
    });
  }

  handleKey(ev, ctx) {
    if (["platform", "control", "alt"].some((m) => ev.modifiers && ev.modifiers[m])) return;
    const key = ev.key_char || ev.key;
    const actions = {
      s: () => this.pick(this.span === "24h" ? "30d" : "24h", ctx),
      r: () => this.reload(ctx),
      c: () => this.sendToClipboard(ctx),
    };
    let act = actions[key];
    if (["left", "right", "up", "down"].includes(ev.key)) act = () => herdr.run("pane.go", { direction: ev.key });
    if (!act) return;
    ctx.stop_propagation();
    act();
  }

  render(ctx) {
    const p = palette(herdr.theme());
    const focused = this.anchor.is_focused();
    const view = this.view();
    const canCopy = view !== null && view.hints.length > 0;
    const live = this.note && Date.now() < this.note.until ? this.note.text : null;
    const withKey = (label, k) => (focused ? `${label} [${k}]` : label);

    let top = row().items_center().gap(4).border_b(1).border_color(p.line).px(10).h(34).flex_none()
      .child(div().px(4).font_semibold().child("Tally"));
    for (const span of SPANS) top = top.child(chip(`span-${span}`, span, span === this.span, p, (c) => this.pick(span, c)));
    top = top.child(div().flex_1());
    top = top.child(chip("reload", withKey("Refresh", "r"), false, p, (c) => this.reload(c)));

    let shell = column().id("tally").track_focus(this.anchor).on_key_down((ev, c) => this.handleKey(ev, c))
      .bg(p.page).text_color(p.ink).text_size(12).size_full().overflow_hidden().min_h(0)
      .border_1().border_color(focused ? p.ring : p.page)
      .child(top);

    const ago = view ? agoText(view.at, Date.now()) : "";
    if (canCopy || ago) {
      let strip = row().items_center().gap(8).py(6).px(10).border_b(1).border_color(p.line).flex_none();
      if (canCopy) strip = strip.child(chip("copy", withKey("Copy as prompt", "c"), false, p, (c) => this.sendToClipboard(c)));
      strip = strip.child(div().text_size(10.5).text_color(p.muted).child(live || ago));
      shell = shell.child(strip);
    }
    return shell.child(bodyOf(this.snaps[this.span], view, p));
  }
}
