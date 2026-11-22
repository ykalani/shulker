import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { CATEGORIES, type CategoryId, type Root } from "./categories";
import type { Drive } from "./drives";
import type { Layout } from "./layout";
import { fileBytes, insidePath, IS_MAC, IS_WINDOWS } from "./platform";
import { windowsUsage } from "./windows";
import { windowsCache } from "./cleanup-policy";

export interface Item {
  path: string;
  size: number;
  /** True for folders, which can be opened for a closer look. */
  dir?: boolean;
}

export interface ScanSnapshot extends Space {
  phase: "scanning" | "done";
  /** Sum of the file and folder estimates, before accounting for unmeasured space. */
  measured: number;
  sizes: Record<CategoryId, number>;
  /** Measured folders per category, largest first. */
  items: Record<CategoryId, Item[]>;
  /** Path being measured right now. */
  current: string;
  /** Folders this process may not read. */
  blocked: string[];
}

export interface ScanHandle {
  cancel(): void;
  done: Promise<ScanSnapshot>;
}

export function unmeasuredBytes({ used, measured }: ScanSnapshot): number {
  return Math.max(0, used - measured);
}

export function emptyRecord<T>(make: () => T): Record<CategoryId, T> {
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, make()])) as Record<CategoryId, T>;
}

export function emptySnapshot(): ScanSnapshot {
  return {
    phase: "scanning",
    total: 0,
    available: 0,
    used: 0,
    measured: 0,
    sizes: emptyRecord(() => 0),
    items: emptyRecord<Item[]>(() => []),
    current: "",
    blocked: [],
  };
}

export interface Space {
  /** Filesystem capacity in bytes. */
  total: number;
  /** Free bytes this account can use. */
  available: number;
  /** Bytes in use. On Linux this leaves out the blocks reserved for root, the way df counts. */
  used: number;
}

export async function diskSpace(drive?: Drive): Promise<Space> {
  const paths = IS_WINDOWS ? [drive?.mount ?? (process.env.SystemDrive ?? "C:") + "\\"] :
    IS_MAC || !drive ? ["/System/Volumes/Data", "/"] : [drive.mount];
  for (const path of paths) {
    try {
      const s = await fsp.statfs(path);
      const total = s.blocks * s.bsize;
      const available = s.bavail * s.bsize;
      return { total, available, used: IS_MAC ? total - available : (s.blocks - s.bfree) * s.bsize };
    } catch {
      // try the next one
    }
  }
  return { total: 0, available: 0, used: 0 };
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

const STALL_CHECK_MS = 5000;

interface DuResult {
  bytes: number;
  denied: boolean;
}

/** Disk usage of one folder via du, which is far faster than walking it in JS. */
export function du(path: string, children: Set<ChildProcess>, cancelled?: () => boolean): Promise<DuResult> {
  if (IS_WINDOWS) return windowsUsage(path, cancelled);
  return new Promise((resolve) => {
    const child = spawn("du", ["-skx", path], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => {
      if (err.length < 4096) err += chunk;
    });
    // A folder guarded by a macOS privacy prompt (Music, TV, Photos) makes du
    // wait for an answer that may never come. A du that has used no CPU time
    // between two checks is waiting like that: give up on it and report the
    // folder as unreadable. Linux has no such prompts, and its ps counts CPU
    // time in whole seconds, so a du busy reading a slow disk would look stuck.
    let stalled = false;
    let lastCpu = "";
    const check = () => {
      if (child.pid === undefined) return;
      execFile("ps", ["-o", "cputime=", "-p", String(child.pid)], (error, stdout) => {
        const cpu = stdout.trim();
        if (error || cpu === "") return;
        if (cpu === lastCpu) {
          stalled = true;
          child.kill();
        }
        lastCpu = cpu;
      });
    };
    const watchdog = IS_MAC ? setInterval(check, STALL_CHECK_MS) : undefined;

    const finish = () => {
      clearInterval(watchdog);
      children.delete(child);
      const kb = Number.parseInt(out, 10);
      resolve({
        bytes: Number.isFinite(kb) ? kb * 1024 : 0,
        denied: stalled || /not permitted|Permission denied/.test(err),
      });
    };
    child.on("error", finish);
    child.on("close", finish);
  });
}

interface Unit {
  path: string;
  category: CategoryId;
}

export interface ScanOptions {
  /** How many folders to measure at once. */
  concurrency?: number;
  /** Minimum milliseconds between onUpdate calls. */
  throttleMs?: number;
}

export function startScan(layout: Layout, onUpdate: (snapshot: ScanSnapshot) => void, options: ScanOptions = {}): ScanHandle {
  const concurrency = options.concurrency ?? 6;
  const throttleMs = options.throttleMs ?? 40;

  const snap = emptySnapshot();
  const children = new Set<ChildProcess>();
  let cancelled = false;
  let lastEmit = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < throttleMs) return;
    lastEmit = now;
    onUpdate({ ...snap, sizes: { ...snap.sizes } });
  };

  const add = (category: CategoryId, bytes: number) => {
    snap.sizes[category] += bytes;
    snap.measured += bytes;
  };

  const run = async (): Promise<ScanSnapshot> => {
    Object.assign(snap, await diskSpace(layout.drive));
    emit(true);

    const all = layout.roots;
    const key = (path: string) => IS_WINDOWS ? path.toLowerCase() : path;
    const rootPaths = new Set(all.map((r) => key(r.path)));
    const holdsRoot = (path: string) => all.some((r) => insidePath(r.path, path));

    const units: Unit[] = [];

    // Lists a folder, queueing each subfolder for du and adding loose files
    // straight away. Subfolders that hold another root are opened instead of
    // measured whole, so the inner root is not counted twice.
    const addFile = async (path: string, category: CategoryId) => {
      try {
        const stat = await fsp.lstat(path);
        if (IS_WINDOWS && !stat.isFile()) return;
        const bytes = fileBytes(stat);
        add(category, bytes);
        if (bytes > 0) snap.items[category].push({ path, size: bytes, dir: false });
      } catch {
        // vanished or unreadable; nothing to count
      }
    };

    // Unreadable system folders are expected; they count as System data anyway.
    const report = (path: string, category: CategoryId) => {
      if (category !== "system" && basename(path) !== "lost+found") snap.blocked.push(path);
    };

    const expand = async (path: string, category: CategoryId, hidden?: CategoryId): Promise<void> => {
      if (cancelled) return;
      let entries;
      try {
        if (IS_WINDOWS && (await fsp.lstat(path)).isSymbolicLink()) return;
        entries = await fsp.readdir(path, { withFileTypes: true });
      } catch (error) {
        // A root can be a single file, like a swap file.
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") await addFile(path, category);
        else if (denied(error)) report(path, category);
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (rootPaths.has(key(child)) || layout.skip(child) || (IS_WINDOWS && entry.isSymbolicLink())) continue;
        const kind = hidden !== undefined && entry.name.startsWith(".") ? hidden : category;
        if (entry.isDirectory()) {
          if (holdsRoot(child)) await expand(child, kind);
          else units.push({ path: child, category: kind });
        } else {
          await addFile(child, kind);
        }
      }
    };

    const order = CATEGORIES.map((c) => c.id);
    const sorted: Root[] = [...all].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    for (const root of sorted) {
      snap.current = root.path;
      if (IS_WINDOWS && root.category === "caches" && root.path !== layout.scope && windowsCache(root.path)) {
        units.push({ path: root.path, category: root.category });
      } else {
        await expand(root.path, root.category, root.hidden);
      }
      emit();
    }

    let next = 0;
    const worker = async () => {
      while (!cancelled && next < units.length) {
        const unit = units[next++];
        snap.current = unit.path;
        emit();
        const result = await du(unit.path, children, () => cancelled);
        if (cancelled) return;
        add(unit.category, result.bytes);
        if (result.bytes > 0) snap.items[unit.category].push({ path: unit.path, size: result.bytes, dir: true });
        if (result.denied && result.bytes < 1024 * 1024) report(unit.path, unit.category);
        emit();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    for (const list of Object.values(snap.items)) list.sort((a, b) => b.size - a.size);

    // Whatever the disk reports as used beyond what was measured is the
    // system's: the OS itself, snapshots, swap, and folders this process may
    // not read.
    const after = await diskSpace(layout.drive);
    if (after.total > 0) Object.assign(snap, after);
    if (!layout.scope) snap.sizes.system += unmeasuredBytes(snap);
    snap.current = "";
    snap.phase = "done";
    emit(true);
    return snap;
  };

  return {
    cancel() {
      cancelled = true;
      for (const child of children) child.kill();
    },
    done: run(),
  };
}

/** Re-measures one category after something was deleted from it. */
export async function measure(category: CategoryId, layout: Layout): Promise<number> {
  const children = new Set<ChildProcess>();
  let total = 0;
  for (const root of layout.roots) {
    if (root.category !== category) continue;
    total += (await du(root.path, children)).bytes;
  }
  return total;
}
