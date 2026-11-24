import { emitKeypressEvents, type Key } from "node:readline";
import { driveArg, pathArg } from "./plain";
import { frame } from "./ui/terminal";
import { startupDuration, startupFrame } from "./ui/startup";
import { TerminalMeter } from "./ui/terminal-meter";
import { Store } from "./ui/store";

const args = process.argv.slice(2);
const store = new Store({ demo: args.includes("--demo"), dryRun: args.includes("--dry-run"),
  drive: driveArg(args), path: pathArg(args) });
const input = process.stdin;
const output = process.stdout;
let scheduled: ReturnType<typeof setImmediate> | undefined;
let unsubscribe: () => void;
const meter = new TerminalMeter();
const black = "\x1b[0;48;2;0;0;0m";
let startupStarted: number | undefined;
let animation: ReturnType<typeof setTimeout> | undefined;
let displayed: string[] = [];

function draw() {
  const elapsed = startupStarted === undefined ? startupDuration : performance.now() - startupStarted;
  const splash = elapsed < startupDuration ? startupFrame(elapsed, output.columns, output.rows) : undefined;
  if (!splash) startupStarted = undefined;
  const next = splash ?? frame(store, output.columns, output.rows, meter);
  let changes = "";
  for (let i = 0; i < Math.min(output.rows, Math.max(displayed.length, next.length)); i++) {
    const line = next[i] ?? "";
    if (line === displayed[i]) continue;
    changes += `\x1b[${i + 1};1H${black}${line}${black}\x1b[K`;
  }
  if (changes) output.write("\x1b[?2026h" + changes + "\x1b[?2026l");
  displayed = next;
  if (animation) clearTimeout(animation);
  if (splash || (output.rows >= 16 && output.columns >= 35 && meter.moving)) {
    animation = setTimeout(render, splash ? 32 : 48);
  }
}

function render() {
  if (scheduled) return;
  scheduled = setImmediate(() => {
    scheduled = undefined;
    draw();
  });
}

function quit() {
  if (animation) clearTimeout(animation);
  unsubscribe();
  if (scheduled) clearImmediate(scheduled);
  store.stop();
  input.off("keypress", onKey);
  output.off("resize", resize);
  input.setRawMode(false);
  input.pause();
  output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
}

function resize() {
  displayed = [];
  output.write(black + "\x1b[2J");
  render();
}

function onKey(_text: string, key: Key) {
  const name = key.name;
  if ((key.ctrl && name === "c") || name === "q") return quit();
  if (key.ctrl || key.meta) return;
  if (startupStarted !== undefined) {
    if (name === "escape") {
      startupStarted = undefined;
      render();
    }
    return;
  }
  const state = store.get();
  if (state.action || state.removing) return;
  const sidebar = state.pane === "sidebar";
  switch (name) {
    case "up": case "k": return sidebar ? store.moveCategory(-1) : store.moveRow(-1);
    case "down": case "j": return sidebar ? store.moveCategory(1) : store.moveRow(1);
    case "pageup": return store.moveRow(-10);
    case "pagedown": return store.moveRow(10);
    case "home": return store.moveRow(-Infinity);
    case "end": return store.moveRow(Infinity);
    case "right": case "return": case "enter": case "l":
      return sidebar ? store.setPane("list") : store.open();
    case "left": case "escape": case "h": return store.back();
    case "tab": return store.setPane(sidebar ? "list" : "sidebar");
    case "g": return store.goToCulprit();
    case "o": return void store.reveal();
    case "d": case "delete": case "backspace": if (!sidebar) store.removeItem(); return;
    case "y": return store.confirmAction();
    case "f": return store.toggleJunkOnly();
    case "p": return store.toggleProjects();
    case "c": return store.pressCategory();
    case "r": return store.rescan();
    case "v": return store.nextDrive(key.shift ? -1 : 1);
    default:
      if (name && /^[1-9]$/.test(name) && +name <= state.drives.length) store.setDrive(+name - 1);
  }
}

emitKeypressEvents(input);
input.setRawMode(true);
input.on("keypress", onKey);
input.resume();
output.on("resize", resize);
output.write("\x1b[?1049h\x1b[?25l" + black + "\x1b[2J");
unsubscribe = store.subscribe(render);
startupStarted = performance.now();
draw();
store.rescan();
