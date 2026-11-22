import { emitKeypressEvents, type Key } from "node:readline";
import { driveArg, pathArg } from "./plain";
import { frame } from "./ui/terminal";
import { Store } from "./ui/store";

const args = process.argv.slice(2);
const store = new Store({ demo: args.includes("--demo"), dryRun: args.includes("--dry-run"),
  drive: driveArg(args), path: pathArg(args) });
const input = process.stdin;
const output = process.stdout;
let scheduled: ReturnType<typeof setImmediate> | undefined;
let unsubscribe: () => void;

function render() {
  if (scheduled) return;
  scheduled = setImmediate(() => {
    scheduled = undefined;
    output.write("\x1b[H" + frame(store, output.columns, output.rows)
      .map((line) => line + "\x1b[0m\x1b[K").join("\r\n") + "\x1b[J");
  });
}

function quit() {
  unsubscribe();
  if (scheduled) clearImmediate(scheduled);
  store.stop();
  input.off("keypress", onKey);
  output.off("resize", render);
  input.setRawMode(false);
  input.pause();
  output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
}

function onKey(_text: string, key: Key) {
  const name = key.name;
  if ((key.ctrl && name === "c") || name === "q") return quit();
  if (key.ctrl || key.meta) return;
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
output.on("resize", render);
output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
unsubscribe = store.subscribe(render);
render();
store.rescan();
