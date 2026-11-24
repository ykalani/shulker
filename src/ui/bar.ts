import { CATEGORIES, type Rgb } from "../core/categories";
import type { ScanSnapshot } from "../core/scan";

const UNMEASURED = "unmeasured";

export interface Segment {
  id: string;
  color: Rgb;
  /** Share of the whole disk, 0..1. */
  fraction: number;
}

export function diskSegments({ sizes, total, used }: ScanSnapshot): Segment[] {
  const measured = CATEGORIES.reduce((sum, c) => sum + sizes[c.id], 0);
  const occupied = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  // Fit estimates into the occupied space, keeping their relative proportions.
  const fraction = measured > 0 ? Math.min(1 / Math.max(total, 1), occupied / measured) : 0;
  const segments = CATEGORIES.map<Segment>((c) => ({ id: c.id, color: c.color, fraction: sizes[c.id] * fraction }));
  segments.push({ id: UNMEASURED, color: [90, 90, 90], fraction: Math.max(0, occupied - measured * fraction) });
  return segments;
}

export interface BarModel {
  segments: Segment[];
  /** Segment to light up; the others dim. */
  hover: string | null;
  /** Shows the bright leading edge while sizes are still coming in. */
  scanning: boolean;
  /** Segment being deleted; it sheds particles as it shrinks. */
  clearing: string | null;
}

export interface Presenter {
  present(frame: { bgra: Buffer; width: number; height: number }): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  span: number;
  color: Rgb;
}

interface Placed {
  id: string;
  x0: number;
  x1: number;
  color: Rgb;
  level: number;
}

const WHITE: Rgb = [255, 255, 255];
export const BAR_ROWS = 7;
/** Empty rows above the bar where particles fly. */
export const HEADROOM_ROWS = 3;

/** Stable pseudo-random number in [0, 1) for a grid position. */
function hash(a: number, b: number): number {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Draws the storage bar into a pixel buffer: one bordered block of dots per
 * category, sized by its share of the disk. Shares ease toward their targets,
 * so the bar grows during a scan and shrinks while something is cleared.
 */
export class BarCanvas {
  private width = 0;
  private height = 0;
  private cell = 8;
  private buffer: Buffer = Buffer.alloc(0);
  private shown = new Map<string, number>();
  private level = new Map<string, number>();
  private particles: Particle[] = [];
  private placed: Placed[] = [];
  private time = 0;
  private edge = 0;
  private model: BarModel = { segments: [], hover: null, scanning: false, clearing: null };

  constructor(
    private readonly presenter: Presenter,
    private readonly background: Rgb,
  ) {}

  resize(width: number, height: number, cell: number) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && cell === this.cell) return;
    this.width = width;
    this.height = height;
    this.cell = Math.max(3, cell);
    this.buffer = Buffer.alloc(width * height * 4);
  }

  setModel(model: BarModel) {
    this.model = model;
  }

  /** Id of the segment at a horizontal pixel offset, if any. */
  hit(x: number, y: number): string | null {
    if (y < this.top) return null;
    return this.placed.find((p) => p.id !== UNMEASURED && x >= p.x0 && x < p.x1)?.id ?? null;
  }

  private get top(): number {
    return this.height - BAR_ROWS * this.cell;
  }

  /** Advances by dt seconds and presents a frame. Returns true while anything is still moving. */
  step(dt: number): boolean {
    if (this.width === 0) return false;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const { segments, hover, clearing, scanning } = this.model;
    let moving = scanning || clearing !== null;

    const ease = Math.min(1, dt * 9);
    const fade = Math.min(1, dt * 12);
    const barWidth = this.width;
    let cursor = 0;

    for (const segment of segments) {
      const from = this.shown.get(segment.id) ?? 0;
      let to = from + (segment.fraction - from) * ease;
      if (Math.abs(segment.fraction - to) < 0.00005) to = segment.fraction;
      else moving = true;
      this.shown.set(segment.id, to);

      const wanted = hover === null ? 1 : hover === segment.id ? 1.15 : 0.4;
      const current = this.level.get(segment.id) ?? 1;
      let next = current + (wanted - current) * fade;
      if (Math.abs(wanted - next) < 0.01) next = wanted;
      else moving = true;
      this.level.set(segment.id, next);

      if (clearing === segment.id && to < from) {
        this.shed((cursor + from) * barWidth, (from - to) * barWidth, segment.color);
      }
      cursor += to;
    }

    const edgeWanted = scanning ? 1 : 0;
    this.edge += (edgeWanted - this.edge) * Math.min(1, dt * 6);
    if (Math.abs(edgeWanted - this.edge) > 0.01) moving = true;

    this.advance(dt);
    if (this.particles.length > 0) moving = true;

    this.draw();
    this.presenter.present({ bgra: this.buffer, width: this.width, height: this.height });
    return moving;
  }

  /** Emits particles for a strip of width `lost` pixels that just vanished at x. */
  private shed(x: number, lost: number, color: Rgb) {
    const scale = this.cell / 8;
    const count = Math.min(48, Math.ceil((lost / this.cell) * BAR_ROWS * 0.9));
    const barHeight = BAR_ROWS * this.cell;
    for (let i = 0; i < count; i++) {
      const span = 0.45 + Math.random() * 0.75;
      this.particles.push({
        x: x - Math.random() * Math.max(lost, this.cell),
        y: this.top + Math.random() * barHeight,
        vx: (10 + Math.random() * 70) * scale,
        vy: -(30 + Math.random() * 130) * scale,
        life: span,
        span,
        color: Math.random() < 0.35 ? WHITE : color,
      });
    }
    if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);
  }

  private advance(dt: number) {
    const lift = 60 * (this.cell / 8);
    let kept = 0;
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= lift * dt;
      p.vx *= 1 - Math.min(1, dt * 1.5);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      this.particles[kept++] = p;
    }
    this.particles.length = kept;
  }

  // ---- drawing -----------------------------------------------------------

  private blend(x: number, y: number, color: Rgb, alpha: number) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (alpha > 1) alpha = 1;
    const i = (y * this.width + x) * 4;
    const b = this.buffer;
    b[i] += (color[2] - b[i]) * alpha;
    b[i + 1] += (color[1] - b[i + 1]) * alpha;
    b[i + 2] += (color[0] - b[i + 2]) * alpha;
  }

  /** Rounded rectangle with a translucent fill and a brighter border. */
  private block(x0: number, y0: number, x1: number, y1: number, color: Rgb, fill: number, border: number) {
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) return;
    const radius = Math.min(this.cell * 0.45, w / 2, h / 2);
    const thick = Math.max(1, Math.round(this.cell / 7));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hx = w / 2 - radius;
    const hy = h / 2 - radius;
    const xa = Math.max(0, Math.floor(x0));
    const xb = Math.min(this.width, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(this.height, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      const qy = Math.abs(y + 0.5 - cy) - hy;
      for (let x = xa; x < xb; x++) {
        const qx = Math.abs(x + 0.5 - cx) - hx;
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const distance = outside + Math.min(Math.max(qx, qy), 0) - radius;
        if (distance > 0.5) continue;
        const coverage = Math.min(1, 0.5 - distance);
        const edge = Math.min(1, Math.max(0, distance + thick + 0.5));
        this.blend(x, y, color, coverage * (fill + (border - fill) * edge));
      }
    }
  }

  private dot(cx: number, cy: number, radius: number, color: Rgb, alpha: number, glow: number) {
    const reach = glow > 0 ? radius * 3.2 : radius + 1;
    const xa = Math.floor(cx - reach);
    const xb = Math.ceil(cx + reach);
    const ya = Math.floor(cy - reach);
    const yb = Math.ceil(cy + reach);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        let a = Math.min(1, Math.max(0, radius + 0.5 - d)) * alpha;
        if (glow > 0) {
          const g = d / (radius * 1.6);
          a += glow * Math.exp(-g * g) * (1 - a);
        }
        if (a > 0.004) this.blend(x, y, color, a);
      }
    }
  }

  private draw() {
    const { width, height, cell, buffer, background } = this;
    const { clearing } = this.model;
    const top = this.top;

    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = background[2];
      buffer[i + 1] = background[1];
      buffer[i + 2] = background[0];
      buffer[i + 3] = 255;
    }


    // Where each segment sits this frame.
    this.placed.length = 0;
    let x = 0;
    for (const segment of this.model.segments) {
      const w = (this.shown.get(segment.id) ?? 0) * width;
      if (w >= 0.5) {
        this.placed.push({ id: segment.id, x0: x, x1: x + w, color: segment.color, level: this.level.get(segment.id) ?? 1 });
      }
      x += w;
    }
    const filled = x - (this.shown.get(UNMEASURED) ?? 0) * width;

    for (const p of this.placed) {
      // A faint wash behind each segment's dots; no outline.
      this.block(p.x0, top, p.x1, height, p.color, 0.07 * p.level, 0.07 * p.level);
    }

    const columns = Math.floor(width / cell);
    const offset = (width - columns * cell) / 2;
    const radius = Math.max(1, cell * 0.24);
    const inset = cell * 0.3;
    let index = 0;
    for (let column = 0; column < columns; column++) {
      const cx = offset + column * cell + cell / 2;
      while (index < this.placed.length && cx >= this.placed[index].x1) index++;
      const segment = this.placed[index];
      const within = segment !== undefined && cx >= segment.x0 + inset && cx <= segment.x1 - inset;
      // Columns near the growing edge of a scan, or the shrinking edge of a clear, burn white.
      const lead = this.edge > 0 && cx <= filled ? Math.max(0, 1 - (filled - cx) / (cell * 3)) * this.edge : 0;
      const burn =
        within && clearing === segment.id ? Math.max(0, 1 - (segment.x1 - cx) / (cell * 2.5)) : 0;
      const hot = Math.max(lead, burn);

      for (let row = 0; row < BAR_ROWS; row++) {
        const cy = top + row * cell + cell / 2;
        if (!within) {
          if (segment === undefined || cx > segment.x1 || cx < segment.x0) this.dot(cx, cy, radius * 0.8, WHITE, 0.05, 0);
          continue;
        }
        const kind = hash(column, row);
        const phase = hash(row + 101, column + 17);
        const twinkle = 0.72 + 0.28 * Math.sin(this.time * (0.8 + phase * 2.6) + phase * 40);
        const level = segment.level;
        if (hot > 0 && kind < 0.35 + hot * 0.65) {
          this.dot(cx, cy, radius, WHITE, Math.min(1, 0.6 + hot * 0.4), 0.3 * hot);
        } else if (kind < 0.5) {
          this.dot(cx, cy, radius, segment.color, 0.45 * twinkle * level, 0);
        } else if (kind < 0.86) {
          this.dot(cx, cy, radius, segment.color, 0.95 * twinkle * level, 0);
        } else {
          this.dot(cx, cy, radius, WHITE, Math.min(1, 0.95 * twinkle * level), 0.22 * twinkle * Math.min(1, level));
        }
      }
    }

    const size = Math.max(1, Math.round(cell / 4));
    for (const p of this.particles) {
      const alpha = Math.min(1, (p.life / p.span) * 1.4);
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) this.blend(px + dx, py + dy, p.color, alpha);
      }
    }
  }
}
