import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { insidePath, IS_MAC, IS_WINDOWS } from "./platform";
import { windowsDrives } from "./windows";

/** One line of /proc/self/mountinfo: a filesystem, or part of one, mounted somewhere. */
export interface Mount {
  /** major:minor of the filesystem. Every mount of one filesystem shares it. */
  id: string;
  /** Folder inside the filesystem that is mounted here: "/" for all of it, "/@home" for a btrfs subvolume, "/home" for a bind mount. */
  root: string;
  /** Where it is mounted. */
  point: string;
  fstype: string;
  source: string;
  readOnly: boolean;
}

/**
 * kind:
 *   main     this system's own root, or the drive that holds your home folder
 *   data     any other drive with files on it
 *   windows  a Windows system partition (dual boot); look only
 *   linux    another Linux install's root; look only
 *   boot     an EFI or /boot partition; look only
 */
export type DriveKind = "main" | "data" | "windows" | "linux" | "boot";

export interface Drive {
  /** Stable identity: the filesystem's major:minor. */
  id: string;
  /** Short name for the drive switcher: "/", "/home", "games", "windows". */
  name: string;
  /** Mount point that is shown and measured for free space. */
  mount: string;
  /** Every place this filesystem is mounted, shortest first. */
  mounts: Mount[];
  device: string;
  fstype: string;
  label: string;
  readOnly: boolean;
  kind: DriveKind;
  /** Holds the user's home folder. */
  home: boolean;
  /** Is the running system's root filesystem. */
  system: boolean;
}

/** A partition with a filesystem on it that is not mounted, e.g. the Windows side of a dual boot. */
export interface Partition {
  device: string;
  fstype: string;
  label: string;
  size: number;
  /** Partition type from the partition table, e.g. "Microsoft basic data". */
  type: string;
}

/** The one drive on a Mac. */
export const MAC_DRIVE: Drive = {
  id: "mac",
  name: "Macintosh HD",
  mount: "/",
  mounts: [],
  device: "",
  fstype: "apfs",
  label: "Macintosh HD",
  readOnly: false,
  kind: "main",
  home: true,
  system: true,
};

const unescape = (text: string) => text.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

/** Every mount in this process's view, in mount order (a later mount on the same point hides an earlier one). */
export function readMounts(): Mount[] {
  let text: string;
  try {
    text = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return [];
  }
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const dash = fields.indexOf("-", 6);
    if (dash < 0 || fields.length < dash + 3) continue;
    const options = fields[5].split(",");
    const superOptions = (fields[dash + 3] ?? "").split(",");
    mounts.push({
      id: fields[2],
      root: unescape(fields[3]),
      point: unescape(fields[4]),
      fstype: fields[dash + 1],
      source: unescape(fields[dash + 2]),
      readOnly: options.includes("ro") || superOptions.includes("ro"),
    });
  }
  return mounts;
}

const within = (path: string, folder: string) => folder === "/" || path === folder || path.startsWith(folder + "/");

/** The mount a path lives on: the deepest mount point above it, the latest one if several share a point. */
export function mountOf(path: string, mounts: Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const mount of mounts) {
    if (within(path, mount.point) && (!best || mount.point.length >= best.point.length)) best = mount;
  }
  return best;
}

/**
 * Where a path is best measured from when its filesystem is mounted more than
 * once (a bind mount of /home, btrfs subvolumes): the mount that exposes the
 * deepest part of the filesystem holding it. A path that is not its own
 * canonical path is a second view of something measured elsewhere.
 */
export function canonical(path: string, mounts: Mount[]): string {
  const here = mountOf(path, mounts);
  if (!here) return path;
  const inside = path === here.point ? "" : path.slice(here.point === "/" ? 1 : here.point.length + 1);
  const real = inside ? join(here.root, inside) : here.root;
  let best: Mount | null = null;
  for (const mount of mounts) {
    if (mount.id !== here.id || !within(real, mount.root)) continue;
    if (
      !best ||
      mount.root.length > best.root.length ||
      (mount.root.length === best.root.length && mount.point.length < best.point.length)
    ) {
      best = mount;
    }
  }
  if (!best) return path;
  const rest = real === best.root ? "" : real.slice(best.root === "/" ? 1 : best.root.length + 1);
  return rest ? join(best.point, rest) : best.point;
}

/** Filesystems that hold files on a disk. Network, memory and image filesystems are left out. */
const DISK_FS = new Set([
  "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "jfs", "reiserfs", "zfs", "bcachefs", "nilfs2",
  "ntfs", "ntfs3", "fuseblk", "exfat", "vfat", "msdos", "hfsplus", "hfs", "apfs",
]);

/** Mount points that belong to container runtimes or the system, not to the user. */
const NOT_A_DRIVE = /^\/(proc|sys|dev|snap|var\/lib\/(docker|containers|kubelet)\/|run\/(containerd|docker|user\/\d+\/(doc|gvfs)))(\/|$)/;

interface BlockDevice {
  path?: string;
  "maj:min"?: string;
  size?: number | string;
  fstype?: string | null;
  label?: string | null;
  parttypename?: string | null;
  mountpoint?: string | null;
  type?: string;
}

/** Labels, sizes and partition types from lsblk; empty when lsblk is missing. */
function blockDevices(): Promise<BlockDevice[]> {
  const run = (columns: string) =>
    new Promise<BlockDevice[] | null>((done) => {
      execFile("lsblk", ["-J", "-b", "-l", "-o", columns], { maxBuffer: 1 << 22 }, (error, stdout) => {
        if (error) return done(null);
        try {
          done((JSON.parse(stdout) as { blockdevices?: BlockDevice[] }).blockdevices ?? []);
        } catch {
          done(null);
        }
      });
    });
  // PARTTYPENAME is missing from older lsblk; ask again without it.
  return run("PATH,MAJ:MIN,SIZE,FSTYPE,LABEL,PARTTYPENAME,MOUNTPOINT,TYPE").then(
    (found) => found ?? run("PATH,MAJ:MIN,SIZE,FSTYPE,LABEL,MOUNTPOINT,TYPE").then((again) => again ?? []),
  );
}

/** Filesystems worth pointing out when they are not mounted. */
const MOUNTABLE = new Set(["ntfs", "exfat", "ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "hfsplus", "apfs", "vfat", "BitLocker"]);
/** Partitions nobody needs to look inside. */
const UNINTERESTING = /^(EFI System|Microsoft reserved|Windows recovery environment|BIOS boot|Linux swap)$/i;

const exists = (path: string) => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

/** What a drive is, from where it is mounted and what is on it. */
function kindOf(drive: Omit<Drive, "kind" | "name">, top: string): DriveKind {
  if (drive.home || drive.system) return "main";
  if (exists(join(top, "Windows", "System32"))) return "windows";
  const boot = drive.mounts.some((m) => /^\/(boot|boot\/efi|efi)$/.test(m.point));
  if (boot || ((drive.fstype === "vfat" || drive.fstype === "msdos") && exists(join(top, "EFI")))) return "boot";
  if (exists(join(top, "etc", "os-release")) && exists(join(top, "usr"))) return "linux";
  return "data";
}

function nameOf(drive: Omit<Drive, "name">): string {
  if (drive.kind === "windows") return drive.label || "windows";
  if (drive.kind === "main" || drive.kind === "boot") return drive.mount;
  // Removable drives are mounted at /run/media/<you>/<label>: the label is the name.
  const removable = /^\/(run\/media|media)\/[^/]+\/([^/]+)$/.exec(drive.mount) ?? /^\/media\/([^/]+)$/.exec(drive.mount);
  if (removable) return removable[removable.length - 1];
  if (drive.kind === "linux" && drive.label) return drive.label;
  return drive.mount;
}

const ORDER: Record<DriveKind, number> = { main: 0, data: 1, windows: 2, linux: 3, boot: 4 };

/**
 * Mounted drives, the one holding your home folder first, plus partitions that
 * are not mounted. On a Mac this is just the startup disk.
 */
export async function listDrives(home: string = homedir()): Promise<{ drives: Drive[]; unmounted: Partition[] }> {
  if (IS_MAC) return { drives: [MAC_DRIVE], unmounted: [] };
  if (IS_WINDOWS) {
    const system = (process.env.SystemDrive ?? "C:").toLowerCase();
    const drives: Drive[] = (await windowsDrives()).map((volume) => {
      const device = volume.Name.slice(0, 2);
      const isSystem = device.toLowerCase() === system;
      const isHome = insidePath(home, volume.Name);
      return {
        id: device.toLowerCase(), name: device, mount: volume.Name, mounts: [], device,
        fstype: volume.DriveFormat, label: volume.VolumeLabel,
        readOnly: volume.Kind !== "Fixed" || volume.DriveFormat !== "NTFS",
        home: isHome, system: isSystem, kind: isSystem || isHome ? "main" : "data",
      };
    });
    drives.sort((a, b) => Number(b.home) - Number(a.home) || Number(b.system) - Number(a.system) ||
      a.name.localeCompare(b.name));
    return { drives, unmounted: [] };
  }

  const all = readMounts();
  const devices = await blockDevices();
  const byPath = new Map(devices.filter((d) => d.path).map((d) => [d.path as string, d]));
  const homeMount = mountOf(home, all);

  // A later mount on the same point hides the earlier one.
  const visible = new Map<string, Mount>();
  for (const mount of all) visible.set(mount.point, mount);

  const groups = new Map<string, Mount[]>();
  for (const mount of visible.values()) {
    if (!DISK_FS.has(mount.fstype) || NOT_A_DRIVE.test(mount.point)) continue;
    const list = groups.get(mount.id) ?? [];
    list.push(mount);
    groups.set(mount.id, list);
  }

  const drives: Drive[] = [];
  for (const [id, mounts] of groups) {
    mounts.sort((a, b) => a.point.length - b.point.length || a.point.localeCompare(b.point));
    const isHome = homeMount?.id === id;
    const isSystem = mounts.some((m) => m.point === "/");
    // Show the mount people know: the one holding home, else "/", else the whole filesystem's.
    const shown =
      (isHome ? mounts.find((m) => m.point === homeMount?.point) : undefined) ??
      mounts.find((m) => m.point === "/") ??
      mounts.find((m) => m.root === "/") ??
      mounts[0];
    const top = (mounts.find((m) => m.root === "/") ?? shown).point;
    const block = byPath.get(shown.source);
    const fstype = shown.fstype === "fuseblk" && block?.fstype ? block.fstype : shown.fstype;
    const partial = {
      id,
      mount: shown.point,
      mounts,
      device: shown.source,
      fstype,
      label: block?.label ?? "",
      readOnly: shown.readOnly,
      home: isHome,
      system: isSystem,
    };
    const kind = kindOf(partial, top);
    const drive = { ...partial, kind };
    drives.push({ ...drive, name: nameOf(drive) });
  }
  drives.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || Number(b.home) - Number(a.home) || a.mount.localeCompare(b.mount));

  const sources = new Set(all.map((m) => m.source));
  const ids = new Set(all.map((m) => m.id));
  const unmounted: Partition[] = [];
  for (const device of devices) {
    const fstype = device.fstype ?? "";
    if (!device.path || !MOUNTABLE.has(fstype) || device.mountpoint) continue;
    if (sources.has(device.path) || (device["maj:min"] && ids.has(device["maj:min"]))) continue;
    if (UNINTERESTING.test(device.parttypename ?? "")) continue;
    unmounted.push({
      device: device.path,
      fstype,
      label: device.label ?? "",
      size: Number(device.size) || 0,
      type: device.parttypename ?? "",
    });
  }
  return { drives, unmounted };
}

/**
 * The drive --drive names: its number in the list, its name, label, mount
 * point or device, or any path on it. The first drive when nothing is asked for.
 */
export function pickDrive(wanted: string | undefined, drives: Drive[]): Drive | undefined {
  if (!wanted) return drives[0];
  if (IS_MAC) return drives[0];
  const named = drives.find((d) => [d.name, d.label, d.mount, d.device].includes(wanted));
  if (named) return named;
  if (/^\d+$/.test(wanted)) return drives[Number(wanted) - 1];
  if (IS_WINDOWS) {
    const target = resolve(wanted);
    return drives.find((drive) => drive.mount.toLowerCase() === target.toLowerCase() ||
      insidePath(target, drive.mount) ||
      [drive.name, drive.label].some((name) => name.toLowerCase() === wanted.toLowerCase()));
  }
  if (!isAbsolute(wanted) && !existsSync(wanted)) return undefined;
  const mount = mountOf(resolve(wanted), readMounts());
  return drives.find((d) => d.id === mount?.id);
}

/** One line about a partition that is not mounted. */
export function describePartition(p: Partition): string {
  const what = p.fstype === "BitLocker" ? "bitlocker, locked" : p.fstype;
  return `${basename(p.device).padEnd(10)}  ${(p.label || "(no label)").padEnd(12)}  ${what}`;
}

/** The command that mounts a partition read-only without sudo on most desktops. */
export function mountCommand(p: Partition): string {
  return `udisksctl mount -b ${p.device} -o ro`;
}
