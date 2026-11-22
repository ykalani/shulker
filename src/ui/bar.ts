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
