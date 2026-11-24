import { basename, dirname, relative } from "node:path";
import { deletesForGood } from "../core/browse";
import { CATEGORIES, CATEGORY, TIER_LABEL, type Rgb } from "../core/categories";
import { shortAge } from "../core/classify";
import { capacity, gb, size, tilde } from "../core/format";
import { IS_WINDOWS, REVEAL_LABEL } from "../core/platform";
import type { Item } from "../core/scan";
import type { AppState, Store } from "./store";
import { TerminalMeter } from "./terminal-meter";

const ink = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
const reset = "\x1b[0;48;2;0;0;0m";
const bold = "\x1b[1m";
const white = ink([230, 230, 230]);
const gray = ink([181, 181, 181]);
const muted = ink([140, 140, 140]);
const faint = ink([79, 79, 79]);
const green = ink([74, 222, 128]);
const amber = ink([251, 191, 36]);
const cleanupColor: Rgb = [74, 222, 128];
const verdicts = {
  junk: { tag: "junk", color: cleanupColor },
  unused: { tag: "unused", color: [251, 191, 36] as Rgb },
  yours: { tag: "", color: [120, 120, 120] as Rgb },
  system: { tag: "system", color: [124, 138, 160] as Rgb },
};
const percent = (part: number, total: number) => total > 0 ? `${Math.round(100 * part / total)}%` : "0%";
const plain = (value: string) => value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "?");

function fit(value: string, width: number, pad = false): string {
  if (width <= 0) return "";
  let result = "";
  let used = 0;
  for (const char of plain(value)) {
    const cells = /[\p{Mark}\u200d]/u.test(char) ? 0 :
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\u{1f300}-\u{1faff}\u{20000}-\u{3ffff}]/u.test(char) ? 2 : 1;
    if (used + cells > width) break;
    result += char;
    used += cells;
  }
  return result + (pad ? " ".repeat(width - used) : "");
}

function dotBar(part: number, max: number, count: number, color: Rgb, seed: number): string {
  const lit = part > 0 ? Math.min(count, Math.max(1, Math.round(count * part / max))) : 0;
  let result = "";
  for (let i = 0; i < lit; i++) {
    const gleam = (i * 53 + seed * 29) % 101;
    const shade = 0.48 + gleam / 205;
    result += (gleam > 92 ? white : ink(color.map((channel) => Math.round(channel * shade)) as Rgb)) + "•";
  }
  return result + ink([42, 42, 42]) + "·".repeat(count - lit) + reset;
}

function categoryPane(store: Store, width: number, height: number): string[] {
  if (!width) return [];
  const state = store.get();
  const entries = [...CATEGORIES.map((c) => ({ ...c, bytes: state.scan.sizes[c.id] })),
    { id: "cleanup", name: "Cleanup", color: cleanupColor, bytes: state.projectBytes }];
  const current = state.projectView ? "cleanup" : state.selected;
  const largest = Math.max(1, ...entries.map((entry) => entry.bytes));
  const count = Math.max(1, Math.min(entries.length, height - 2));
  const first = Math.max(0, Math.min(entries.findIndex((entry) => entry.id === current) - count + 1, entries.length - count));
  const columns = width >= 38 ? 13 : width >= 29 ? 6 : 0;
  const nameWidth = width - columns - (columns ? 15 : 13);
  const result = [fit("  categories", width, true), " ".repeat(width)].map((text) => muted + text + reset);
  for (const entry of entries.slice(first, first + count)) {
    const active = entry.id === current;
    const marker = active ? (state.pane === "sidebar" ? "›" : "·") : " ";
    const value = fit(size(entry.bytes).padStart(9), 9, true);
    result.push(ink(entry.color) + marker + " ■ " + (active ? white + bold : gray) +
      fit(entry.name, nameWidth, true) + reset + (active ? white : muted) + value + reset +
      (columns ? "  " + dotBar(entry.bytes, largest, columns, entry.color, entry.name.length) : ""));
  }
  if (height > result.length + 1) {
    const safe = CATEGORIES.filter((c) => store.canClear(c.id))
      .reduce((bytes, item) => bytes + state.scan.sizes[item.id], 0);
    const action = state.layout?.lookOnly ?? (safe > 0 ? `${size(safe)} safe to clear`
      : state.projectBytes ? `${size(state.projectBytes)} to review · p` : "p review cleanup candidates");
    while (result.length < height - 1) result.push(" ".repeat(width));
    result.push((safe ? green : faint) + fit("  " + action, width, true) + reset);
  }
  return result;
}

function rowDetails(store: Store, item: Item, width: number): string[] {
  const state = store.get();
  const label = store.label(item);
  const color = ink(verdicts[label.verdict].color);
  const culprit = state.culprits[item.path];
  const last = culprit && culprit !== "pending" ? culprit.chain.at(-1) : undefined;
  const tag = label.cleanup === "rebuildable" ? "rebuildable" :
    label.verdict === "unused" ? "probably unused" : verdicts[label.verdict].tag;
  const forGood = !state.projectView && !label.cleanup && deletesForGood(state.selected);
  const reason = label.reason ? `${tag ? tag + " · " : ""}${label.reason}` : tag;
  const summary = last ? `└ mostly in ${relative(item.path, last.path)}${last.dir ? "/" : ""}  ${size(last.size)} · ${percent(last.size, item.size)}`
    : culprit === "pending" ? "└ finding what is taking the space…"
    : culprit && culprit.top.length > 1 ? "└ spread out: " + culprit.top.map((child) => basename(child.path) + " " + size(child.size)).join("  · ") : "";
  const blocked = state.pane === "list" ? store.blocked(item) : null;
  const action = state.removing === item.path ? "moving item…"
    : state.confirm?.kind === "item" && state.confirm.path === item.path
      ? `y confirm ${forGood ? "permanent deletion" : IS_WINDOWS ? "move to Recycle Bin" : "move to Trash"}`
      : [item.dir ? "→ open" : "", last ? "g go to culprit" : "", `o ${REVEAL_LABEL}`,
        state.pane === "list" ? blocked ? `cannot remove · ${blocked}` :
          `⌫ ${forGood ? "delete" : "move to trash"}` : ""].filter(Boolean).join("  ");
  return [
    reason ? color + fit("    " + reason, width) + reset : "",
    summary ? muted + fit("    " + summary, width) + reset : "",
    (state.confirm ? amber : faint) + fit("    " + action, width) + reset,
  ].filter(Boolean);
}

function itemPane(store: Store, width: number, height: number, now: number): string[] {
  const state = store.get();
  const entries = store.entries();
  const selected = entries[state.row];
  const category = CATEGORY[state.selected];
  const accent = state.projectView ? cleanupColor : category.color;
  const scope = state.projectView && !state.stack.length ? state.projectBytes : store.scopeSize();
  const group = state.projectView ? "Cleanup candidates" : category.name;
  const path = [group, ...state.stack.map((folder) => basename(folder.path))].join(" / ");
  const tier = state.projectView ? "review first" : TIER_LABEL[category.tier].toLowerCase();
  const metadata = width >= 54 ? `${size(scope)}  ·  ${percent(scope, state.scan.total)} of capacity  ·  ${tier}` : size(scope);
  const result = [
    ink(accent) + bold + fit(path, Math.max(1, width - metadata.length - 2), true) + reset + muted + "  " + fit(metadata, width - 3) + reset,
    faint + fit(state.stack.length ? tilde(state.stack[state.stack.length - 1].path) :
      state.projectView ? "Project artifacts and named app caches." : state.layout?.scope ? tilde(state.layout.scope) : category.blurb, width) + reset,
  ];
  const ageColumn = width >= 52 ? 7 : 0;
  const count = store.allEntries().length;
  const header = `${count} ${count === 1 ? "item" : "items"}${state.junkOnly ? " · junk & unused" : ""}`;
  if (height >= 4) {
    result.push(faint + fit(header, width - ageColumn, true) + (ageColumn ? "   used" : "") + reset);
  }
  if (!entries.length) {
    if (result.length < height) result.push(faint + fit(state.projectView && state.projectScanning ? "finding cleanup candidates…"
      : state.listing || state.scan.phase === "scanning" ? "measuring…" : "nothing here", width) + reset);
    return result.slice(0, height);
  }

  const details = selected && height > result.length + 1 ? rowDetails(store, selected, width) : [];
  const visible = Math.max(1, height - result.length - Math.min(details.length, Math.max(0, height - result.length - 1)));
  const start = Math.max(0, Math.min(state.row - Math.floor(visible / 2), entries.length - visible));
  const plot = width >= 75 ? 16 : width >= 55 ? 10 : width >= 41 ? 5 : 0;
  const max = Math.max(1, entries[0].size);
  for (const [offset, item] of entries.slice(start, start + visible).entries()) {
    const index = start + offset;
    const active = index === state.row;
    const label = store.label(item);
    const verdict = verdicts[label.verdict];
    const tagWidth = width >= 43 ? 9 : 0;
    const percentWidth = width >= 52 ? 5 : 0;
    const sizeWidth = 9;
    const nameWidth = width - 4 - sizeWidth - tagWidth - (plot ? plot + 2 : 0) - percentWidth - ageColumn;
    const name = (basename(item.path) || item.path) + (item.dir ? "/" : "");
    const location = state.stack.length === 0 && nameWidth >= 30 ? tilde(dirname(item.path)) : "";
    const locationWidth = location ? Math.min(22, Math.floor(nameWidth / 2)) : 0;
    const age = state.usage[item.path];
    const marker = active ? (state.pane === "list" ? "›" : "·") : " ";
    result.push(ink(accent) + marker + " " + (item.dir ? "▸ " : "  ") +
      (active ? white + bold : gray) + fit(name, nameWidth - locationWidth, true) + reset +
      (locationWidth ? faint + fit("  " + location, locationWidth, true) + reset : "") +
      (tagWidth ? ink(verdict.color) + fit(label.cleanup === "rebuildable" ? "rebuild" : verdict.tag, tagWidth, true) + reset : "") +
      (active ? white : muted) + fit(size(item.size).padStart(sizeWidth), sizeWidth) + reset +
      (plot ? "  " + dotBar(item.size, max, plot, label.verdict === "yours" ? accent : verdict.color, index) : "") +
      (percentWidth ? faint + fit(percent(item.size, scope).padStart(percentWidth), percentWidth) + reset : "") +
      (ageColumn ? (age && now - age.at > 180 * 86_400_000 ? amber : faint) +
        fit((age ? shortAge(now - age.at) : "").padStart(ageColumn), ageColumn) + reset : ""));
    if (active) result.push(...details);
  }
  return result.slice(0, height);
}

/** Borderless fix-storage layout with the shared Shulker store. */
export function frame(store: Store, columns = 80, rows = 24, meter = new TerminalMeter()): string[] {
  const width = Math.max(1, columns - 1);
  if (width < 34 || rows < 16) return [fit("Shulker · enlarge the terminal · q quit", width)];
  const state: AppState = store.get();
  const { scan } = state;
  const volumes = state.drives.map((drive, index) => state.drives.length > 1 ?
    `${index + 1} ${drive.name}` : drive.name).join("  ");
  const mode = store.options.demo ? "demo disk" : store.options.dryRun ? "dry run" : state.layout?.lookOnly ? "look only" : "";
  const header = ["shulker", volumes, mode].filter(Boolean).join("  ");
  const status = state.action ? `clearing  ${tilde(state.action.current)}` : scan.phase === "scanning" ?
    `measuring  ${tilde(scan.current)}` : scan.blocked.length ? `${scan.blocked.length} folders unreadable` : "scan complete";
  const left = width >= 73 ? Math.min(44, Math.floor(width * 0.47)) : 0;
  const gap = left ? 3 : 0;
  const right = width - left - gap;
  const layoutTop = width >= 60 ? Math.min(45, Math.max(header.length + 3, Math.floor(width * 0.45))) : width;
  const totals = scan.total ? `${gb(scan.used)} used of ${capacity(scan.total)}   ·   ${gb(scan.available)} free   ·   ${percent(scan.used, scan.total)} full` : "measuring disk capacity…";
  const lines = [
    white + bold + "shulker" + reset + (mode ? amber : muted) + fit(header.slice(7), layoutTop - 7, true) + reset +
      (width > layoutTop ? faint + fit(status, width - layoutTop) + reset : ""),
    "",
    white + bold + fit(totals, width) + reset,
    ...meter.draw(state, width, rows >= 24 ? 5 : 3),
    "",
  ];
  const height = rows - 1 - lines.length - 3;
  const categories = categoryPane(store, left, height);
  const items = itemPane(store, right, height, Date.now());
  for (let index = 0; index < height; index++) {
    lines.push((categories[index] ?? " ".repeat(left)) + " ".repeat(gap) + (items[index] ?? ""));
  }
  const notice = state.confirm?.kind === "category" ? "y confirm permanent category cleanup" : state.note;
  lines.push(notice ? amber + fit(notice, width) + reset : "",
    muted + fit(state.pane === "list" ? "↑↓ move   → open   ← back   g culprit   f junk only   o reveal   ⌫ remove" :
      "↑↓ category   → look inside   f junk only   c clear   tab focus", width) + reset,
    faint + fit("p cleanup   v drive   r rescan   q quit", width) + reset);
  return lines;
}
