import type { Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export const IS_MAC = process.platform === "darwin";
export const IS_WINDOWS = process.platform === "win32";

/** The operating system's name, for messages. */
export const OS_NAME = IS_MAC ? "macOS" : IS_WINDOWS ? "Windows" : "Linux";

/** What revealing an item opens, for messages: "Showing x in Finder." */
export const FILE_MANAGER = IS_MAC ? "Finder" : IS_WINDOWS ? "Explorer" : "your file manager";

/** Lowercase label for the reveal action. */
export const REVEAL_LABEL = IS_MAC ? "reveal in finder" : IS_WINDOWS ? "show in explorer" : "show in file manager";

/** Strict descendant, with the platform's path and casing rules. */
export function insidePath(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return !!child && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

export function fileBytes(stat: Stats): number {
  return IS_WINDOWS ? stat.size : stat.blocks * 512;
}
