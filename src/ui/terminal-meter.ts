import { BAR_ROWS, HEADROOM_ROWS, BarCanvas, diskSegments } from "./bar";
import type { AppState } from "./store";

const cell = 8;
const height = (BAR_ROWS + HEADROOM_ROWS) * cell;
const dots = [[1, 8], [2, 16], [4, 32], [64, 128]];
const black = "\x1b[48;2;0;0;0m";

/** Presents fix-storage's original pixel buffer on terminals using Braille cells. */
export class TerminalMeter {
  private frame?: { bgra: Buffer; width: number; height: number };
  private canvas = new BarCanvas({ present: (frame) => { this.frame = frame; } }, [0, 0, 0]);
  private last = 0;
  moving = false;

  draw(state: AppState, columns: number, rows: number): string[] {
    this.canvas.resize(columns * cell, height, cell);
    this.canvas.setModel({
      segments: diskSegments(state.scan),
      hover: state.scan.phase === "done" && !state.action && !state.projectView ? state.selected : null,
      scanning: state.scan.phase === "scanning",
      clearing: state.action?.id ?? null,
    });
    const now = performance.now();
    this.moving = this.canvas.step(this.last ? (now - this.last) / 1000 : 0.1);
    this.last = now;
    const frame = this.frame;
    if (!frame) return [];
    const result: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      const band = frame.height / rows;
      const top = Math.floor(row * band);
      for (let col = 0; col < columns; col++) {
        const start = col * cell;
        const at = (x: number, y: number) => (y * frame.width + x) * 4;
        const bg = at(start, top);
        const [bb, gg, rr] = [frame.bgra[bg], frame.bgra[bg + 1], frame.bgra[bg + 2]];
        let mask = 0, red = 0, green = 0, blue = 0, count = 0;
        for (let y = 0; y < 4; y++) {
          const py = Math.floor((row + (y + 0.5) / 4) * band);
          for (let x = 0; x < 2; x++) {
            const data = at(start + 3 + x * 2, py);
            const [b, g, r] = [frame.bgra[data], frame.bgra[data + 1], frame.bgra[data + 2]];
            if (Math.max(b - bb, g - gg, r - rr) < 4) continue;
            mask |= dots[y][x];
            red += r; green += g; blue += b; count++;
          }
        }
        line += rr || gg || bb ? `\x1b[48;2;${rr};${gg};${bb}m` : black;
        if (!count) line += " ";
        else line += `\x1b[38;2;${Math.round(red / count)};${Math.round(green / count)};${Math.round(blue / count)}m`
          + String.fromCharCode(0x2800 + mask);
      }
      result.push(line + black);
    }
    return result;
  }
}
