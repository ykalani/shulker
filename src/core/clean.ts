import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CategoryId } from "./categories";
import type { Layout } from "./layout";
import { IS_MAC, IS_WINDOWS } from "./platform";
import type { Item } from "./scan";
import { forgetTrashInfo } from "./trash";
import { cleanupExclusion } from "./project-rules";
import { canRecyclePath } from "./cleanup-policy";

export type Clearable = Extract<CategoryId, "caches" | "trash">;

export interface CleanProgress {
  /** Path that was just handled. */
  path: string;
  /** Bytes it freed; 0 when it could not be removed. */
  freed: number;
}

export interface CleanOptions {
  /** Go through the motions without deleting anything. */
  dryRun?: boolean;
  onProgress?: (progress: CleanProgress) => void;
}

export interface CleanResult {
  freed: number;
  removed: number;
  /** Paths that could not be removed (in use, or protected by the system). */
  skipped: string[];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Everything directly inside the category's folders: the things that would be
 * removed. Sizes come from the scan where it measured them.
 */
export async function plan(category: Clearable, known: Item[], layout: Layout): Promise<Item[]> {
  const sizes = new Map(known.map((item) => [item.path, item.size]));
  const all = layout.roots;
  const rootPaths = new Set(all.map((r) => r.path));
  const items: Item[] = [];
  for (const root of all) {
    if (root.category !== category) continue;
    let names: string[];
    try {
      names = await fsp.readdir(root.path);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root.path, name);
      if (rootPaths.has(path) || layout.skip(path)) continue;
      let bytes = sizes.get(path);
      if (bytes === undefined) {
        try {
          bytes = (await fsp.lstat(path)).blocks * 512;
        } catch {
          continue;
        }
      }
      items.push({ path, size: bytes });
    }
  }
  return items.sort((a, b) => b.size - a.size);
}

/** True only for a path strictly inside one of the category's own folders. */
function inside(category: Clearable, path: string, layout: Layout): boolean {
  const target = resolve(path);
  return layout.roots.some((root) => root.category === category && target.startsWith(resolve(root.path) + sep));
}

export async function clean(category: Clearable, items: Item[], layout: Layout, options: CleanOptions = {}): Promise<CleanResult> {
  const result: CleanResult = { freed: 0, removed: 0, skipped: [] };
  if (IS_WINDOWS) {
    result.skipped = items.map((item) => item.path);
    return result;
  }

  for (const item of items) {
    let freed = 0;
    if (layout.lookOnly || !inside(category, item.path, layout) || layout.foreign(item.path) ||
        cleanupExclusion(item.path) || !canRecyclePath(item.path)) {
      result.skipped.push(item.path);
    } else if (options.dryRun) {
      await sleep(25 + Math.min(120, item.size / 2e7));
      freed = item.size;
    } else {
      try {
        await fsp.rm(item.path, { recursive: true, force: true });
        if (!IS_MAC && category === "trash") await forgetTrashInfo(item.path);
        freed = item.size;
      } catch {
        // In use or protected. Whatever was removed before the failure is
        // picked up when the category is measured again afterwards.
        result.skipped.push(item.path);
      }
    }
    if (freed > 0) {
      result.freed += freed;
      result.removed += 1;
    }
    options.onProgress?.({ path: item.path, freed });
  }
  return result;
}
