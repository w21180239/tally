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
const CLIPBOARDS = [["pbcopy"], ["xclip", "-selection", "clipboard"], ["wl-copy"]];

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

// Theme slots under the names used below.
const palette = (t) => ({ page: t.background, ink: t.foreground, muted: t.dim, line: t.border, card: t.raised, over: t.hover, ring: t.accent });

// Key bindings: each row is the keys that trigger it and the method of Tally it calls.
const BINDINGS = [
  { keys: ["1"], run: (v, c) => v.pick("24h", c) },
  { keys: ["2"], run: (v, c) => v.pick("30d", c) },
  { keys: ["u"], run: (v, c) => v.reload(c) },
  { keys: ["y"], run: (v, c) => v.sendToClipboard(c) },
];
const ARROWS = ["left", "right", "up", "down"];

// A pressed key as one token: the typed character when there is one, else the key name.
const tokenOf = (ev) => ev.key_char || ev.key;

// Herdr sends "focus" when pane.go lands on a focusable mod; each one grabs the keyboard for `handle`.
function followFocusRequests(handle, ctx) {
  ctx.spawn(async (c) => {
    for (let cmd = await herdr.nextCommand(); ; cmd = await herdr.nextCommand()) {
      if (cmd !== "focus") continue;
      handle.focus();
      c.notify();
    }
  });
}

// A clickable label; `hint` is the key, drawn only while the sidebar owns the keyboard.
function control(p, { id, label, hint, solid, onPress }) {
  const face = div().id(id).rounded(4).py(2).px(7).text_size(10.5).cursor_pointer();
  return face.bg(solid ? p.card : p.page).text_color(solid ? p.ink : p.muted)
    .hover((st) => st.bg(p.over))
    .on_click((_ev, c) => onPress(c))
    .child(label)
    .child(hint ? div().text_color(p.muted).child(` ${hint}`) : div());
}

// Only `.child` is relied on from the builder, so lists are folded in with it.
const fill = (box, items) => items.reduce((acc, item) => acc.child(item), box);

const spacer = () => div().flex_1();
const strong = (text) => div().font_semibold().child(text);

const caption = (p, text) => div().text_color(p.muted).text_size(10.5).child(text);

function rankBlock(p, title, rows) {
  const lines = rows.map((r) => row().gap(6).child(div().child(r.name).flex_1()).child(div().text_color(p.muted).child(money(r.usd))));
  return fill(column().gap(2).child(caption(p, title)), lines);
}

function hintBlock(p, h) {
  const parts = [row().gap(6).child(strong(h.title).flex_1()).child(div().text_color(p.muted).child(h.usd === null ? "" : money(h.usd)))];
  if (h.why) parts.push(div().text_size(11).child(h.why));
  if (h.todo) parts.push(div().text_size(11).text_color(p.muted).child(`Do: ${h.todo}`));
  return fill(column().gap(3).p(8).rounded(6).bg(p.card), parts);
}

function totalsBlock(p, view) {
  const facts = [];
  if (view.requests !== null) facts.push(`${view.requests} requests`);
  if (view.main !== null) facts.push(`main ${money(view.main)}`);
  if (view.sub !== null) facts.push(`sub-agents ${money(view.sub)}`);
  return column().gap(2).child(div().text_size(20).font_semibold().child(money(view.total))).child(caption(p, facts.join(", ")));
}

// Scrolling content: a status line, or the sections of the report that exist.
function bodyPanel(p, snap, view) {
  const panel = column().id("tally-body").gap(12).p(10).overflow_y_scrollbar().flex_1().min_h(0);
  if (!snap) return panel.child(caption(p, "Reading the report..."));
  if (!view) return panel.child(caption(p, snap.error));
  const sections = [];
  if (view.total !== null) sections.push(totalsBlock(p, view));
  if (view.models.length > 0) sections.push(rankBlock(p, "Top models", view.models));
  if (view.repos.length > 0) sections.push(rankBlock(p, "Top repos", view.repos));
  if (view.hints.length === 0) sections.push(caption(p, "No hints for this span."));
  else sections.push(fill(column().gap(6).child(caption(p, `Hints (${view.hints.length})`)), view.hints.map((h) => hintBlock(p, h))));
  return fill(panel, sections);
}

export default class Tally extends kit.View {
  init(_props, ctx) {
    this.span = localStorage.getItem("tally.span") === "30d" ? "30d" : "24h";
    this.snaps = {}; // span -> loadSpan result; empty until the first read lands
    this.note = null; // { text, until } shown in place of the age line
    this.keys = ctx.focus_handle();
    followFocusRequests(this.keys, ctx);
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
    localStorage.setItem("tally.span", span);
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
      this.note = { text, until: Date.now() + NOTE_MS };
      c.notify();
      c.timer.after(NOTE_MS + 50, (c2) => c2.notify());
    });
  }

  handleKey(ev, ctx) {
    const m = ev.modifiers;
    if (m && (m.control || m.alt || m.platform)) return;
    const token = tokenOf(ev);
    if (ARROWS.includes(ev.key)) {
      ctx.stop_propagation();
      herdr.run("pane.go", { direction: ev.key });
      return;
    }
    const bound = BINDINGS.find((b) => b.keys.includes(token));
    if (!bound) return;
    ctx.stop_propagation();
    bound.run(this, ctx);
  }

  render(_ctx) {
    const p = palette(herdr.theme());
    const owned = this.keys.is_focused();
    const view = this.view();
    const canCopy = view !== null && view.hints.length > 0;
    const age = view ? agoText(view.at, Date.now()) : "";
    const flash = this.note && Date.now() < this.note.until ? this.note.text : null;
    const hintOf = (k) => (owned ? `[${k}]` : "");

    const title = row().h(34).px(10).gap(8).border_b(1).border_color(p.line).items_center().flex_none()
      .child(strong("Tally"))
      .child(spacer())
      .child(caption(p, flash || age));

    const tabs = fill(row().gap(4).items_center().py(6).px(10).flex_none(),
      SPANS.map((span, i) => control(p, { id: `span-${span}`, label: span, hint: hintOf(i + 1), solid: span === this.span, onPress: (c) => this.pick(span, c) })));

    const actions = row().gap(6).items_center().py(6).px(10).border_t(1).flex_none().border_color(p.line)
      .child(control(p, { id: "reload", label: "Refresh", hint: hintOf("u"), solid: false, onPress: (c) => this.reload(c) }));
    const withCopy = canCopy
      ? actions.child(control(p, { id: "copy", label: "Copy as prompt", hint: hintOf("y"), solid: true, onPress: (c) => this.sendToClipboard(c) }))
      : actions;

    const shell = column().id("tally").track_focus(this.keys).on_key_down((ev, c) => this.handleKey(ev, c))
      .bg(p.page).text_color(p.ink).text_size(12).overflow_hidden().size_full().min_h(0)
      .border_1().border_color(owned ? p.ring : p.page);
    return fill(shell, [title, tabs, bodyPanel(p, this.snaps[this.span], view), withCopy]);
  }
}
