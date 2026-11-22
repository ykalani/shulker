import { basename, relative } from "node:path";
import { deletesForGood } from "../core/browse";
import { CATEGORIES, CATEGORY, type Rgb } from "../core/categories";
import { size, tilde } from "../core/format";
import { IS_WINDOWS } from "../core/platform";
import { diskSegments } from "./bar";
import type { Store } from "./store";

const violet = "\x1b[38;2;202;164;255m";
const muted = "\x1b[38;2;151;145;166m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const amber = "\x1b[38;2;255;199;120m";
const green = "\x1b[38;2;118;223;178m";

const color = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
const sanitize = (value: string) => value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "?");

function fit(value: string, width: number, pad = false): string {
  if (width <= 0) return "";
  let result = "";
  let used = 0;
  for (const char of sanitize(value)) {
    const cells = /[\p{Mark}\u200d]/u.test(char) ? 0 :
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\u{1f300}-\u{1faff}\u{20000}-\u{3ffff}]/u.test(char) ? 2 : 1;
    if (used + cells > width) break;
    result += char;
    used += cells;
  }
  return result + (pad ? " ".repeat(width - used) : "");
}

/** Layout is pure so render and navigation can be checked against demo data. */
export function frame(store: Store, columns = 80, rows = 24): string[] {
  const width = Math.max(1, columns - 1);
  if (width < 34 || rows < 16) return [fit("Shulker · enlarge the terminal · Q quit", width)];
  const state = store.get();
  const { scan } = state;
  const drive = state.drives[state.drive];
  const tabs = state.drives.map((item, index) => index === state.drive ?
    `[${index + 1} ${item.name}]` : `${index + 1} ${item.name}`).join("  ");
  const mode = store.options.demo ? "DEMO" : store.options.dryRun ? "DRY RUN" : state.layout?.lookOnly ? "LOOK ONLY" : "";
  const lines = [
    violet + bold + "SHULKER" + reset + muted + fit(`  ${tabs}  ${mode}`, width - 7) + reset,
    fit(drive ? `${size(scan.used)} used of ${size(scan.total)}  ·  ${size(scan.available)} free` : "Finding volumes…", width),
  ];
  const meters = diskSegments(scan);
  const meterWidth = Math.min(width, 96);
  let edge = 0;
  let fraction = 0;
  let meter = "";
  for (const segment of meters) {
    fraction += segment.fraction;
    const next = Math.min(meterWidth, Math.round(fraction * meterWidth));
    meter += color(segment.color) + "●".repeat(Math.max(0, next - edge));
    edge = next;
  }
  meter += muted + "·".repeat(meterWidth - edge) + reset;
  lines.push(meter, meter, "");
  const left = width >= 66 ? Math.min(26, Math.floor(width / 3)) : 0;
  const right = width - (left ? left + 3 : 0);
  const join = (l: string, r: string) => left ? l + muted + " │ " + reset + r : r;
  const scope = state.stack[state.stack.length - 1]?.path ?? state.layout?.scope;
  const group = state.projectView ? "Cleanup candidates" : CATEGORY[state.selected].name;
  const title = scope ? `${group} / ${basename(scope) || scope}` : group;
  const heading = state.junkOnly && !state.projectView ? title + " · cleanup filter" : title;
  lines.push(join(violet + bold + fit("STORAGE", left, true) + reset,
    violet + bold + fit(heading, right) + reset));
  const entries = store.entries();
  const selected = entries[state.row];
  const categoryIndex = state.projectView ? CATEGORIES.length : CATEGORIES.findIndex((category) => category.id === state.selected);
  const visible = rows - 14;
  const offset = Math.max(0, Math.min(state.row - Math.floor(visible / 2), entries.length - visible));
  const categoryOffset = Math.max(0, Math.min(categoryIndex - visible + 2, CATEGORIES.length + 1 - visible));
  const largest = Math.max(1, entries[0]?.size ?? 0);
  for (let row = 0; row < visible; row++) {
    const category = CATEGORIES[row + categoryOffset];
    const cleanup = row + categoryOffset === CATEGORIES.length;
    const active = cleanup ? state.projectView : !state.projectView && category?.id === state.selected;
    const leftLine = category || cleanup ?
      `${active ? "›" : " "} ${cleanup ? "Cleanup" : category.name}` : "";
    const leftBytes = category ? size(scan.sizes[category.id]) : cleanup ? size(state.projectBytes) : "";
    const sidebar = (active ? violet + bold : category ? color(category.color) : muted)
      + fit(leftLine, Math.max(0, left - 9), true)
      + fit(leftBytes.padStart(9), Math.min(9, left), true) + reset;
    const item = entries[row + offset];
    let detail = "";
    if (item) {
      const current = row + offset === state.row;
      const label = store.label(item);
      const status = right >= 42 ? (label.cleanup === "rebuildable" ? "  rebuild" :
        label.verdict === "junk" ? "  cache" : label.verdict === "unused" ? "  review" : "         ") : "";
      const mini = right >= 54 ? Math.round(6 * item.size / largest) : 0;
      const miniWidth = right >= 54 ? 8 : 0;
      const from = state.layout?.scope ?? drive?.mount;
      const name = (state.projectView && !state.stack.length && from && !store.options.demo ?
        relative(from, item.path) : basename(item.path)) + (item.dir ? "/" : "");
      const nameWidth = right - 13 - status.length - miniWidth;
      detail = (current ? violet + bold : "") + (current ? "› " : "  ") + fit(name, nameWidth, true)
        + reset + muted + fit(size(item.size).padStart(11), 11)
        + (miniWidth ? "  " + violet + "•".repeat(Math.min(6, mini)) + muted + "·".repeat(6 - Math.min(6, mini)) : "")
        + (label.verdict === "unused" ? amber : green) + status + reset;
    } else if (row === 0) {
      detail = muted + fit(state.projectScanning && state.projectView ? "Finding cleanup candidates…"
        : scan.phase === "scanning" || state.listing ? "Measuring…" : "No items to display.", right) + reset;
    }
    lines.push(join(sidebar, detail));
  }
  const label = selected ? store.label(selected) : undefined;
  const culprit = selected ? state.culprits[selected.path] : undefined;
  const largestChild = culprit && culprit !== "pending" ? culprit.chain.at(-1) : undefined;
  const permanent = !state.projectView && !label?.cleanup && deletesForGood(state.selected);
  const destination = IS_WINDOWS ? "the Recycle Bin" : "Trash";
  const note = state.removing ? "Moving item…" : state.confirm?.kind === "item"
    ? permanent ? "Press Y to confirm removal permanently." : `Press Y to confirm removal to ${destination}.`
    : state.confirm?.kind === "category" ? "Press Y to confirm permanent category cleanup." : state.note;
  lines.push("",
    violet + fit(selected ? (state.layout?.scope ? relative(state.layout.scope, selected.path) : tilde(selected.path)) : state.projectView
      ? "Project artifacts & named caches" : CATEGORY[state.selected].blurb, width) + reset,
    muted + fit(label?.reason || (scan.blocked.length ? `${scan.blocked.length} paths skipped` : ""), width) + reset,
    muted + fit(largestChild ? `g  Jump to ${basename(largestChild.path)} · ${size(largestChild.size)}` :
      state.projectView ? `${size(state.projectBytes)} in unique candidates · estimated size` : "", width) + reset,
    amber + fit(note ?? "", width) + reset,
    muted + fit("↑↓ Move   → Open   ← Back   Tab Focus   P Cleanup   G Culprit", width) + reset,
    muted + fit("F Filter   O Reveal   D Remove   C Clear   V Volume   R Scan   Q Quit", width) + reset);
  return lines.slice(0, rows - 1);
}
