import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CategoryId } from "./categories";
import { isWhole, type Usage } from "./classify";
import { homeTrash, type Layout } from "./layout";
import { fileBytes, insidePath, IS_MAC, IS_WINDOWS, OS_NAME } from "./platform";
import { du, type Item } from "./scan";
import { forgetTrashInfo, trashLinux } from "./trash";
import { canRecyclePath, windowsCache } from "./cleanup-policy";
import { recycleWindows, windowsUsage } from "./windows";
import { cleanupExclusion, recheckProjectCandidate } from "./project-rules";

export interface ListHandle {
  cancel(): void;
}

/**
 * Folder sizes measured on the way to a culprit. Opening one of those folders
 * later reuses them instead of measuring again, so diving in is instant.
 */
const known = new Map<string, number>();

/** Drops remembered sizes for a path, everything inside it, and every folder above it. */
export function forgetSizes(path: string) {
  for (const key of known.keys()) {
    if (key === path || insidePath(key, path) || insidePath(path, key)) known.delete(key);
  }
}

export function forgetAllSizes() {
  known.clear();
}

/**
 * Measures everything directly inside a folder: loose files straight away,
 * subfolders with du, a few at a time. Calls back with the list so far,
 * largest first, and once more with done = true. Folders where another drive
 * is mounted are left out: they are not on this drive.
 */
export function listFolder(
  path: string,
  onUpdate: (items: Item[], done: boolean, current: string) => void,
  foreign: (path: string) => boolean = () => false,
): ListHandle {
  const children = new Set<ChildProcess>();
  let cancelled = false;
  const items: Item[] = [];
  const sorted = () => [...items].sort((a, b) => b.size - a.size);

  const run = async () => {
    let entries;
    try {
      if (IS_WINDOWS && (await fsp.lstat(path)).isSymbolicLink()) throw new Error("Link skipped");
      entries = await fsp.readdir(path, { withFileTypes: true });
    } catch {
      if (!cancelled) onUpdate([], true, "");
      return;
    }
    const folders: string[] = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!foreign(child)) folders.push(child);
        continue;
      }
      try {
        const stat = await fsp.lstat(child);
        if (IS_WINDOWS && !stat.isFile()) continue;
        items.push({ path: child, size: fileBytes(stat), dir: false });
      } catch {
        // vanished
      }
    }
    if (cancelled) return;
    onUpdate(sorted(), folders.length === 0, folders[0] ?? "");

    let next = 0;
    const worker = async () => {
      while (!cancelled && next < folders.length) {
        const folder = folders[next++];
        const cached = known.get(folder);
        const bytes = cached ?? (await du(folder, children, () => cancelled)).bytes;
        if (cancelled) return;
        items.push({ path: folder, size: bytes, dir: true });
        onUpdate(sorted(), false, folder);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (!cancelled) onUpdate(sorted(), true, "");
  };
  void run();

  return {
    cancel() {
      cancelled = true;
      for (const child of children) child.kill();
    },
  };
}

// ---- culprits -------------------------------------------------------------

export interface Culprit {
  /** Folders, then maybe one file, each holding most of the one before it. Empty when the space is spread out. */
  chain: Item[];
  /** The biggest things directly inside, for when no single one dominates. */
  top: Item[];
}

/** A child holding at least this share of its parent counts as "where the space is". */
const DOMINANT = 0.5;
const DEPTH = 12;

/**
 * Finds where the space inside a folder actually is: measures every subfolder
 * in one du walk, then follows the biggest child down for as long as it holds
 * most of its parent.
 */
export function findCulprit(path: string, onDone: (culprit: Culprit) => void): ListHandle {
  let cancelled = false;
  const sizes = new Map<string, number>();
  const kids = new Map<string, Item[]>();
  const remember = (dir: string, bytes: number) => {
    sizes.set(dir, bytes);
    if (dir === path) return;
    const parent = dirname(dir);
    const list = kids.get(parent) ?? [];
    list.push({ path: dir, size: bytes, dir: true });
    kids.set(parent, list);
  };
  let buffer = "";
  const take = (line: string) => {
    const tab = line.indexOf("\t");
    if (tab < 0) return;
    const kb = Number.parseInt(line.slice(0, tab), 10);
    const dir = line.slice(tab + 1);
    if (!Number.isFinite(kb)) return;
    const bytes = kb * 1024;
    remember(dir, bytes);
  };

  const finish = async () => {
    if (cancelled) return;
    if (buffer) take(buffer);
    for (const [dir, bytes] of sizes) known.set(dir, bytes);

    const chain: Item[] = [];
    let current = path;
    let currentSize = sizes.get(path) ?? 0;
    for (let depth = 0; depth < DEPTH; depth++) {
      const best = (kids.get(current) ?? []).reduce<Item | null>((a, b) => (!a || b.size > a.size ? b : a), null);
      if (!best || best.size <= 0 || best.size < currentSize * DOMINANT) break;
      chain.push(best);
      current = best.path;
      currentSize = best.size;
      if (isWhole(best.path)) break;
    }
    // A single huge file at the bottom (a video, a disk image) is the real answer.
    const last = chain[chain.length - 1];
    if (!last || !isWhole(last.path)) {
      const biggestFile = (await looseFiles(current))[0];
      if (biggestFile && biggestFile.size >= currentSize * DOMINANT) chain.push(biggestFile);
    }

    const top = [...(kids.get(path) ?? []), ...(await looseFiles(path))].sort((a, b) => b.size - a.size).slice(0, 3);
    if (!cancelled) onDone({ chain, top });
  };
  if (IS_WINDOWS) {
    const rootDepth = path.split(sep).length;
    void windowsUsage(path, () => cancelled, (dir, bytes) => {
      if (dir.split(sep).length - rootDepth <= DEPTH) remember(dir, bytes);
    }).then(finish);
    return { cancel: () => { cancelled = true; } };
  }

  const child = spawn("du", ["-kx", "-d", String(DEPTH), path], { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) take(line);
  });
  child.on("close", () => void finish());

  return {
    cancel() {
      cancelled = true;
      child.kill();
    },
  };
}

async function looseFiles(path: string): Promise<Item[]> {
  let entries;
  try {
    entries = await fsp.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Item[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    try {
      const stat = await fsp.lstat(join(path, entry.name));
      if (IS_WINDOWS && !stat.isFile()) continue;
      files.push({ path: join(path, entry.name), size: fileBytes(stat), dir: false });
    } catch {
      // vanished
    }
  }
  return files.sort((a, b) => b.size - a.size);
}

// ---- when things were last used --------------------------------------------

/**
 * Last-opened dates from Spotlight where it has one (apps, documents, media),
 * otherwise the modification time. Linux has no Spotlight: see statUsage.
 */
export async function usage(paths: string[]): Promise<Map<string, Usage>> {
  if (!IS_MAC) return statUsage(paths);
  const result = new Map<string, Usage>();
  for (let i = 0; i < paths.length; i += 40) {
    const batch = paths.slice(i, i + 40);
    const opened = await new Promise<string[]>((done) => {
      execFile("mdls", ["-raw", "-name", "kMDItemLastUsedDate", ...batch], { maxBuffer: 1 << 20 }, (error, stdout) => {
        const values = stdout ? stdout.split("\0") : [];
        done(values.length === batch.length ? values : []);
      });
    });
    for (let j = 0; j < batch.length; j++) {
      const value = opened[j];
      const at = value && value !== "(null)" ? Date.parse(value.replace(" +0000", "Z").replace(" ", "T")) : NaN;
      if (Number.isFinite(at)) {
        result.set(batch[j], { at, kind: "opened" });
        continue;
      }
      try {
        const stat = await fsp.stat(batch[j]);
        result.set(batch[j], { at: stat.mtimeMs, kind: "changed" });
      } catch {
        // vanished
      }
    }
  }
  return result;
}

/**
 * Linux: a file's access time when it is newer than its modification time,
 * which means it was opened since it last changed (with the default relatime
 * mount option, to within a day). Folders use their modification time: every
 * du pass reads them, so their access times say nothing.
 */
async function statUsage(paths: string[]): Promise<Map<string, Usage>> {
  const result = new Map<string, Usage>();
  for (const path of paths) {
    try {
      const stat = await fsp.stat(path);
      const opened = !stat.isDirectory() && stat.atimeMs > stat.mtimeMs + 60_000;
      result.set(path, opened ? { at: stat.atimeMs, kind: "opened" } : { at: stat.mtimeMs, kind: "changed" });
    } catch {
      // vanished
    }
  }
  return result;
}

// ---- demo --------------------------------------------------------------

const DEMO_NAMES: Partial<Record<CategoryId, string[]>> = {
  apps: ["Contents", "Frameworks", "Resources", "PlugIns", "Helpers", "SharedSupport", "Library", "Info.plist"],
  developer: ["Devices", "node_modules", "Runtimes", "iOS DeviceSupport", "toolchains", ".venv", "target", "logs.txt"],
  photos: ["originals", "resources", "derivatives", "database", "scopes", "private", "Thumbnails"],
  movies: ["Render Files", "Original Media", "Transcoded Media", "Proxy Media", "Final.mov", "Draft 2.mov"],
  documents: ["node_modules", "renders", ".next", "Screen Recording 2025-03-02 at 1.37.29 PM.mov", "Figma-124.1.dmg", "2024", "Archive.zip", "notes.md"],
  music: ["Media.localized", "Apple Loops", "Projects", "Samples", "Bounces", "Library.musicdb"],
  caches: ["v3", "metadata", "content-v2", "index-v5", "blobs", "tmp", "fsCachedData", "Cache.db"],
  trash: ["exports", "renders", "build", "old", "backup.zip", "recording.mov", "data.sqlite"],
  system: ["logs", "snapshots", "swapfile0", "swapfile1", "diagnostics"],
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Made-up contents for a demo folder, so the drill-down has something to show. */
export function demoChildren(category: CategoryId, path: string, size: number, depth: number): Item[] {
  const pool = DEMO_NAMES[category] ?? DEMO_NAMES.documents!;
  const count = 4 + Math.floor(hash(path) * (pool.length - 3));
  const start = Math.floor(hash(path + "#") * pool.length);
  const names = Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length]);
  // About half the folders have one child holding most of the space, so the demo has culprits to find.
  const lopsided = hash(path + "!") < 0.55;
  const weights = names.map((name, i) => (1 / (i + 1.2)) * (0.6 + hash(path + name)) * (lopsided && i === 0 ? 5 : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  return names
    .map((name, i) => ({
      path: `${path}/${name}`,
      size: (size * weights[i]) / sum,
      dir: depth < 7 && !/\.[a-z0-9]+$/i.test(name),
    }))
    .sort((a, b) => b.size - a.size);
}

/** Demo stand-in for findCulprit: follows the made-up tree down. */
export function demoCulprit(category: CategoryId, path: string, size: number, depth: number): Culprit {
  const chain: Item[] = [];
  let current = { path, size, dir: true } as Item;
  for (let d = depth; d < depth + 6 && current.dir; d++) {
    const kids = demoChildren(category, current.path, current.size, d);
    const best = kids[0];
    if (!best || best.size < current.size * 0.5) break;
    chain.push(best);
    current = best;
    if (isWhole(best.path)) break;
  }
  return { chain, top: demoChildren(category, path, size, depth).slice(0, 3) };
}

/** Demo stand-in for usage: stable made-up dates between today and three years ago. */
export function demoUsage(path: string, now: number = Date.now()): Usage {
  const days = Math.floor(hash(path + "@") ** 2 * 1100);
  return { at: now - days * 24 * 3600 * 1000, kind: /\.(app|mov|mp4|key|dmg)$/i.test(path) ? "opened" : "changed" };
}

// ---- acting on one item -------------------------------------------------

/** Folders whose removal would break the system or the user's account, whatever is inside. */
function protectedPaths(layout: Layout): Set<string> {
  const { home } = layout;
  const shared = [...layout.roots.map((r) => r.path), ...layout.drive.mounts.map((m) => m.point), "/", home];
  if (!IS_MAC) {
    const h = (...parts: string[]) => join(home, ...parts);
    return new Set(
      [
        ...shared,
        "/home",
        h(".local"),
        h(".local", "share"),
        h(".config"),
        dirname(homeTrash(home)),
        homeTrash(home),
        h(".local", "share", "keyrings"),
        h(".local", "share", "kwalletd"),
        h(".gnupg"),
        h(".ssh"),
        h(".pki"),
        h(".password-store"),
        h(".mozilla"),
        h(".thunderbird"),
        h(".config", "google-chrome"),
        h(".config", "chromium"),
        h(".config", "BraveSoftware"),
      ].map((p) => resolve(p)),
    );
  }
  const lib = (name: string) => join(home, "Library", name);
  return new Set(
    [
      ...shared,
      "/",
      "/System",
      "/Library",
      "/usr",
      "/usr/local/bin",
      "/usr/local/lib",
      "/opt/homebrew/bin",
      "/opt/homebrew/lib",
      join(home, "Library"),
      lib("Keychains"),
      lib("Preferences"),
      lib("Mail"),
      lib("Messages"),
      lib("Accounts"),
      lib("Cookies"),
      lib("Calendars"),
      lib("Safari"),
      lib("Photos"),
      lib("Biome"),
    ].map((p) => resolve(p)),
  );
}

/**
 * Linux folders a package manager or the system owns. Anything inside them is
 * removed with that tool, never by hand.
 */
const LINUX_MANAGED = [
  "/usr", "/etc", "/boot", "/efi", "/var", "/opt", "/root", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32",
  "/proc", "/sys", "/dev", "/snap", "/nix", "/.snapshots", "/timeshift", "/swapfile", "/swap", "/home/linuxbrew",
];

/** Why an item cannot be removed, or null when it can. */
export function cannotRemove(path: string, layout: Layout, allowArtifact = false): string | null {
  if (!isAbsolute(path)) return "Not a real path.";
  if (layout.lookOnly) return capitalize(layout.lookOnly) + ".";
  // Judge a second view of a folder (a bind mount) by the folder it shows.
  const target = layout.canonical(resolve(path));
  const excluded = cleanupExclusion(target);
  if (excluded) return excluded;
  if (IS_WINDOWS) {
    const cache = windowsCache(target);
    if (!canRecyclePath(target, !!cache)) return "Protected by Windows or the application that owns this data.";
    if (layout.foreign(target) || layout.scope?.toLowerCase() === target.toLowerCase() ||
        !layout.roots.some((root) => insidePath(target, root.path) ||
          (!!cache && root.category === "caches" && root.path.toLowerCase() === target.toLowerCase()))) {
      return "Outside the folders this tool looks at.";
    }
    return cache || allowArtifact ? null : "Windows cleanup requires a verified project artifact or named cache.";
  }
  if (protectedPaths(layout).has(target)) return `${OS_NAME} or your account needs this folder.`;
  if (IS_MAC) {
    if (target.startsWith("/System/") || target.startsWith("/private/")) return "macOS manages this.";
  } else {
    if (LINUX_MANAGED.some((dir) => target.startsWith(dir + "/"))) return "Linux or a package manager manages this.";
    const flatpak = join(dirname(homeTrash(layout.home)), "flatpak");
    if (target.startsWith(flatpak + "/")) return "Flatpak manages this · use flatpak uninstall.";
    if (layout.foreign(target)) return "Another drive is mounted here.";
  }
  const known = layout.roots.some((root) => insidePath(target, root.path));
  if (!known) return "Outside the folders this tool looks at.";
  return null;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** True when the item lives where permanent deletion is fine: caches and the Trash. */
export function deletesForGood(category: CategoryId): boolean {
  return !IS_WINDOWS && (category === "caches" || category === "trash");
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    execFile(file, args, (error, _stdout, stderr) => {
      if (error) fail(new Error(stderr.trim() || error.message));
      else done();
    });
  });
}

/**
 * Moves a file or folder to the Trash, where it can be put back from Finder or
 * the file manager, and returns roughly where it went.
 */
export async function moveToTrash(path: string, layout: Layout, allowArtifact = false): Promise<string> {
  if (IS_WINDOWS) {
    const blocked = cannotRemove(path, layout, allowArtifact);
    if (blocked) throw new Error(blocked);
    if (!windowsCache(path)) {
      const info = await fsp.lstat(path);
      const label = await recheckProjectCandidate({ path, size: fileBytes(info), dir: info.isDirectory() }, layout.foreign);
      if (!label || label.cleanup === "blocked") throw new Error("Cleanup evidence changed. Rescan and review this item.");
    }
    await recycleWindows(path);
    return "Recycle Bin";
  }
  if (!IS_MAC) return trashLinux(path, layout.home);
  try {
    await fsp.access("/usr/bin/trash");
    await run("/usr/bin/trash", [path]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await run("osascript", [
      "-e",
      "on run argv",
      "-e",
      'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      "-e",
      "end run",
      path,
    ]);
  }
  return trashPathFor(path, layout);
}

/** Where moving an item to the Trash puts it, near enough to list it there (and for dry runs). */
export function trashPathFor(path: string, layout: Layout): string {
  if (IS_WINDOWS) return "Recycle Bin";
  if (IS_MAC) return join(layout.home, ".Trash", basename(path));
  if (layout.drive.home) return join(homeTrash(layout.home), "files", basename(path));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(layout.drive.mount, `.Trash-${uid}`, "files", basename(path));
}

/** Deletes for good. Only used for caches and things already in the Trash. */
export async function deleteForGood(path: string, category: CategoryId): Promise<void> {
  if (IS_WINDOWS) throw new Error("Use Explorer to empty the Recycle Bin.");
  const excluded = cleanupExclusion(path);
  if (excluded) throw new Error(excluded);
  await fsp.rm(path, { recursive: true, force: true });
  if (!IS_MAC && category === "trash") await forgetTrashInfo(path);
}

/**
 * Shows the item in Finder, or in the Linux file manager with the item
 * selected (Nautilus, Dolphin, Nemo, Thunar), else just opens its folder.
 */
export async function reveal(path: string): Promise<void> {
  if (IS_WINDOWS) {
    await new Promise<void>((done, fail) => {
      const child = spawn("explorer.exe", ["/select,", path], { detached: true, stdio: "ignore" });
      child.on("error", fail);
      child.on("spawn", () => {
        child.unref();
        done();
      });
    });
    return;
  }
  if (IS_MAC) return run("open", ["-R", path]);
  const uri = pathToFileURL(path).href.replace(/,/g, "%2C");
  try {
    await run("dbus-send", [
      "--session",
      "--print-reply",
      "--reply-timeout=3000",
      "--dest=org.freedesktop.FileManager1",
      "--type=method_call",
      "/org/freedesktop/FileManager1",
      "org.freedesktop.FileManager1.ShowItems",
      `array:string:${uri}`,
      "string:",
    ]);
  } catch {
    await new Promise<void>((done, fail) => {
      const child = spawn("xdg-open", [dirname(path)], { detached: true, stdio: "ignore" });
      child.on("error", fail);
      child.on("spawn", () => {
        child.unref();
        done();
      });
    });
  }
}
