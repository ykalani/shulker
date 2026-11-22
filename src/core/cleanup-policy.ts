import { posix, win32 } from "node:path";
import type { Root } from "./categories";

interface Cache {
  path: string;
  label: string;
}

const virtualDisk = /\.(?:vhdx?|vmdk|qcow2)$/i;

// Specific cache locations from cull's Windows registry. Never match an app profile.
// https://github.com/legostin/cull/blob/main/caches_windows.go
function windowsCaches(env: NodeJS.ProcessEnv): Cache[] {
  const caches: Cache[] = [];
  const add = (base: string | undefined, label: string, ...segments: string[]) => {
    if (!base || !localWindowsPath(base)) return;
    const path = win32.join(base, ...segments);
    if (!windowsSystemPath(path, env)) caches.push({ path, label });
  };
  add(env.LOCALAPPDATA, "npm cache", "npm-cache");
  add(env.LOCALAPPDATA, "pip cache", "pip", "cache");
  add(env.LOCALAPPDATA, "Go build cache", "go-build");
  add(env.APPDATA, "VS Code cache", "Code", "Cache");
  add(env.APPDATA, "VS Code cached data", "Code", "CachedData");
  return caches;
}

function localWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) && !/[:\u0000-\u001f]/.test(path.slice(2)) &&
    !path.split(/[\\/]/).some((part) => /[ .]$/.test(part) || part === "..");
}

function key(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return win32.resolve(path).toLowerCase();
  return posix.resolve(path);
}

function contains(parent: string, child: string, separator: string): boolean {
  return parent === child || child.startsWith(parent.endsWith(separator) ? parent : parent + separator);
}

export function windowsCacheRoots(env = process.env): Root[] {
  return windowsCaches(env).map(({ path }) => ({ path, category: "caches" }));
}

/** Label for an exact cache root, or any item inside that exact boundary. */
export function windowsCache(path: string, env = process.env): Cache | undefined {
  if (!localWindowsPath(path) || virtualDisk.test(path)) return undefined;
  const item = key(path, "win32");
  return windowsCaches(env).find(({ path: root }) => contains(key(root, "win32"), item, "\\"));
}

function windowsSystemPath(path: string, env: NodeJS.ProcessEnv): boolean {
  if (!localWindowsPath(path)) return true;
  const item = key(path, "win32");
  const root = win32.parse(item).root;
  if (item === root) return true;

  // Windows protection policy is informed by cleaner's auto-clean exclusions.
  // https://github.com/vyrti/cleaner
  const names = ["Windows", "Windows.old", "Program Files", "Program Files (x86)", "ProgramData",
    "System Volume Information", "$Recycle.Bin", "Recovery", "PerfLogs"];
  const protectedRoots = [
    ...names.map((name) => win32.join(root, name)),
    env.SystemRoot, env.WINDIR, env.ProgramFiles, env["ProgramFiles(x86)"],
    env.ProgramW6432, env.ProgramData,
  ];
  if (protectedRoots.some((value) => value && localWindowsPath(value) &&
    contains(key(value, "win32"), item, "\\"))) return true;
  if (item.slice(root.length).split("\\").some((part) =>
    [".git", ".ssh", ".gnupg", ".password-store"].includes(part))) return true;
  if (env.USERPROFILE && localWindowsPath(env.USERPROFILE) &&
    contains(item, key(env.USERPROFILE, "win32"), "\\")) return true;
  return /^(?:pagefile|hiberfil|swapfile)\.sys$/i.test(win32.basename(item));
}

/** Protected paths can be measured and inspected. An allowlisted cache can be offered separately. */
export function isProtectedPath(path: string, platform = process.platform, env = process.env): boolean {
  if (virtualDisk.test(path)) return true;
  if (platform !== "win32") return false;
  if (windowsSystemPath(path, env)) return true;
  const item = key(path, platform);
  if (item.slice(win32.parse(item).root.length).split("\\").includes("appdata")) return true;
  return [env.APPDATA, env.LOCALAPPDATA].some((value) => value && localWindowsPath(value) &&
    contains(key(value, platform), item, "\\"));
}

/** Explicit cache context grants only the narrow cache exception. */
export function canRecyclePath(
  path: string,
  namedCache = false,
  platform = process.platform,
  env = process.env,
): boolean {
  if (virtualDisk.test(path)) return false;
  if (platform === "win32" && windowsSystemPath(path, env)) return false;
  return !isProtectedPath(path, platform, env) ||
    (platform === "win32" && namedCache && windowsCache(path, env) !== undefined);
}

/** Drop duplicate and nested entries so the same subtree contributes only once (as in sweeprs). */
export function deduplicateCleanup<T extends { path: string; size: number }>(
  items: readonly T[],
  platform = process.platform,
): T[] {
  const pathApi = platform === "win32" ? win32 : posix;
  const first = new Map<string, T>();
  for (const item of items) {
    const normalized = key(item.path, platform);
    if (!first.has(normalized)) first.set(normalized, item);
  }
  return Array.from(first).filter(([path]) => {
    let parent = pathApi.dirname(path);
    while (parent !== path) {
      if (first.has(parent)) return false;
      path = parent;
      parent = pathApi.dirname(path);
    }
    return true;
  }).map(([, item]) => item).sort((a, b) => b.size - a.size);
}
