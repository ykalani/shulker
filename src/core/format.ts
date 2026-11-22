import { realpathSync } from "node:fs";
import { homedir } from "node:os";

const GB = 1e9;
const MB = 1e6;

/** Decimal gigabytes with one decimal, the way macOS reports storage. */
export function gb(bytes: number): string {
  return `${(Math.max(0, bytes) / GB).toFixed(1)} GB`;
}

/** Whole gigabytes for the disk's capacity ("512 GB"). */
export function capacity(bytes: number): string {
  return `${Math.round(bytes / GB)} GB`;
}

/** Picks GB or MB, for lists where small items matter. */
export function size(bytes: number): string {
  if (bytes >= GB) return gb(bytes);
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  if (bytes < 1000) return `${Math.max(0, bytes)} B`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

const HOME = homedir();
/** Where the home folder really is, when it is reached through a symlink (/home -> /var/home). */
const REAL_HOME = (() => {
  try {
    return realpathSync(HOME);
  } catch {
    return HOME;
  }
})();

/** Replaces the home directory with ~ so paths stay short. */
export function tilde(path: string, home: string = HOME): string {
  for (const h of home === HOME ? [HOME, REAL_HOME] : [home]) {
    if (path === h || path.startsWith(h + "/") || path.startsWith(h + "\\")) return "~" + path.slice(h.length);
  }
  return path;
}
