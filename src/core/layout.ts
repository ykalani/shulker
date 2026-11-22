import { promises as fsp, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { roots as macRoots, type CategoryId, type Root } from "./categories";
import { canonical, MAC_DRIVE, mountOf, readMounts, type Drive } from "./drives";
import { insidePath, IS_MAC, IS_WINDOWS } from "./platform";
import { windowsCacheRoots } from "./cleanup-policy";
import { verifyWindowsPath } from "./windows";

/** How one drive is measured: its folders and categories, and what may be removed from it. */
export interface Layout {
  drive: Drive;
  home: string;
  /** Folders the scan measures, and the category each one counts toward. */
  roots: Root[];
  /** A subtree selected with --path, when the volume is not being scanned in full. */
  scope?: string;
  /** Why nothing on this drive may be removed, or null when the usual rules apply. */
  lookOnly: string | null;
  /** True for a folder where a different drive is mounted. */
  foreign(path: string): boolean;
  /** True for a folder this drive's scan leaves out: another drive, or a second view of something measured elsewhere. */
  skip(path: string): boolean;
  /** The one path a file is known by when its drive is mounted more than once (/mnt/disk/home/you -> /home/you). */
  canonical(path: string): string;
}

/** Why a drive of each kind is look only. */
export const LOOK_ONLY = {
  windows: "windows partition, look only · clean it up from windows",
  linux: "another linux install, look only · clean it up from that system",
  boot: "boot partition, look only · removing files here can stop your computer from starting",
} as const;

/** The startup disk's layout on a Mac, unchanged from before drives existed. */
export function macLayout(home: string = homedir()): Layout {
  return {
    drive: MAC_DRIVE,
    home,
    roots: macRoots(home),
    lookOnly: null,
    foreign: () => false,
    skip: () => false,
    canonical: (path) => path,
  };
}

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/** XDG base and user folders, ignoring ones set to the home folder itself (how a folder is turned off). */
function xdg(home: string) {
  const env = (name: string, fallback: string) => {
    const value = process.env[name];
    return value && isAbsolute(value) ? value : fallback;
  };
  const user: Record<string, string> = {};
  try {
    const text = readFileSync(join(env("XDG_CONFIG_HOME", join(home, ".config")), "user-dirs.dirs"), "utf8");
    for (const line of text.split("\n")) {
      const match = /^XDG_([A-Z]+)_DIR="(.*)"\s*$/.exec(line.trim());
      if (!match) continue;
      const path = match[2].replace(/^\$HOME/, home).replace(/\/+$/, "");
      if (isAbsolute(path) && path !== home) user[match[1]] = path;
    }
  } catch {
    // no user-dirs.dirs: the usual English names
  }
  const dir = (key: string, name: string) => user[key] ?? join(home, name);
  return {
    data: env("XDG_DATA_HOME", join(home, ".local", "share")),
    config: env("XDG_CONFIG_HOME", join(home, ".config")),
    cache: env("XDG_CACHE_HOME", join(home, ".cache")),
    desktop: dir("DESKTOP", "Desktop"),
    downloads: dir("DOWNLOAD", "Downloads"),
    documents: dir("DOCUMENTS", "Documents"),
    pictures: dir("PICTURES", "Pictures"),
    videos: dir("VIDEOS", "Videos"),
    music: dir("MUSIC", "Music"),
  };
}

/** The home trash, where things on the same drive as your home folder go. */
export function homeTrash(home: string = homedir()): string {
  return join(xdg(home).data, "Trash");
}

/** Tools that keep their files in a folder of your home. They count as Developer. */
const DEV_FOLDERS = [
  ".docker", ".cargo", ".rustup", "go", ".gradle", ".m2", ".nvm", ".pyenv", ".android", "Android", ".bun", ".deno",
  ".vscode", ".vscode-server", ".cursor", ".ollama", ".lmstudio", ".conda", "miniconda3", "anaconda3", ".julia",
  ".ghcup", ".stack", ".opam", ".sdkman", ".dotnet", ".nuget", ".rbenv", ".gem", ".platformio", ".arduino15",
  ".espressif", ".vagrant.d", ".minikube", ".pub-cache", ".yarn", ".local/lib",
];

/**
 * Every folder a Linux scan might measure. Each drive keeps the ones that live
 * on it. A root nested inside another root is measured on its own and left out
 * of the outer one, so nothing is counted twice.
 */
function linuxRoots(home: string): Root[] {
  const d = xdg(home);
  const h = (...parts: string[]) => join(home, ...parts);
  return [
    { path: "/opt", category: "apps" },
    { path: "/usr/local", category: "apps" },
    { path: "/var/lib/flatpak", category: "apps" },
    { path: "/var/lib/snapd", category: "apps" },
    { path: h("Applications"), category: "apps" },
    { path: h(".var", "app"), category: "apps" },
    { path: join(d.data, "flatpak"), category: "apps" },
    // Everything else apps keep, each app's folder measured separately.
    { path: d.data, category: "apps" },
    { path: d.config, category: "apps" },

    { path: "/var/lib/docker", category: "developer" },
    { path: "/var/lib/containers", category: "developer" },
    { path: "/var/lib/libvirt", category: "developer" },
    { path: "/home/linuxbrew/.linuxbrew", category: "developer" },
    { path: join(d.data, "containers"), category: "developer" },
    { path: join(d.data, "docker"), category: "developer" },
    ...DEV_FOLDERS.map((name): Root => ({ path: h(name), category: "developer" })),

    { path: d.pictures, category: "photos" },
    { path: d.videos, category: "movies" },
    { path: d.documents, category: "documents" },
    { path: d.desktop, category: "documents" },
    { path: d.downloads, category: "documents" },
    // The rest of the home folder: project folders count as your files, and
    // dot-folders (~/.mozilla, ~/.steam, ...) as app data.
    { path: home, category: "documents", hidden: "apps" },
    { path: d.music, category: "music" },

    { path: d.cache, category: "caches" },
    { path: h(".npm"), category: "caches" },
    { path: h(".bun", "install", "cache"), category: "caches" },
    { path: h(".gradle", "caches"), category: "caches" },

    { path: join(d.data, "Trash", "files"), category: "trash" },

    // Listed so System data shows where it is instead of one opaque number.
    { path: "/usr", category: "system" },
    { path: "/var", category: "system" },
    { path: "/var/cache", category: "system" },
    { path: "/var/log", category: "system" },
    { path: "/var/lib", category: "system" },
    { path: "/var/lib/systemd", category: "system" },
    { path: "/etc", category: "system" },
    { path: "/boot", category: "system" },
    { path: "/root", category: "system" },
    { path: "/nix", category: "system" },
    { path: "/swapfile", category: "system" },
    { path: "/swap", category: "system" },
    { path: "/.snapshots", category: "system" },
    { path: "/timeshift", category: "system" },
  ];
}

/** Folder names on a data drive that say what is inside. */
const FOLDER_KIND: Array<[RegExp, CategoryId]> = [
  [/^(pictures|photos|images|fotos|bilder|camera|dcim|screenshots)$/i, "photos"],
  [/^(videos|movies|films|video|recordings)$/i, "movies"],
  [/^(music|audio|songs|podcasts)$/i, "music"],
  [/^(steamlibrary|steam|games|lutris|heroic|epic games|gog games)$/i, "apps"],
];

/** The standard Windows system and profile folders on one volume. */
async function windowsRoots(top: string): Promise<Root[]> {
  const t = (...parts: string[]) => join(top, ...parts);
  const roots: Root[] = [
    { path: top, category: "documents" },
    { path: t("Windows"), category: "system" },
    { path: t("pagefile.sys"), category: "system" },
    { path: t("hiberfil.sys"), category: "system" },
    { path: t("swapfile.sys"), category: "system" },
    { path: t("System Volume Information"), category: "system" },
    { path: t("Recovery"), category: "system" },
    { path: t("$WinREAgent"), category: "system" },
    { path: t("$Windows.~BT"), category: "system" },
    { path: t("$Windows.~WS"), category: "system" },
    { path: t("Program Files"), category: "apps" },
    { path: t("Program Files (x86)"), category: "apps" },
    { path: t("ProgramData"), category: "apps" },
    { path: t("Windows", "Temp"), category: "caches" },
    { path: t("Windows", "SoftwareDistribution", "Download"), category: "caches" },
    { path: t("$Recycle.Bin"), category: "trash" },
    { path: t("Users"), category: "documents" },
  ];
  let users: string[] = [];
  try {
    users = (await fsp.readdir(t("Users"), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !/^(public|default|default user|all users|defaultuser\d*)$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    // no Users folder, or unreadable
  }
  for (const name of users) {
    const u = (...parts: string[]) => t("Users", name, ...parts);
    roots.push(
      { path: u(), category: "documents", hidden: "developer" },
      { path: u("AppData", "Local"), category: "apps" },
      { path: u("AppData", "Roaming"), category: "apps" },
      { path: u("AppData", "LocalLow"), category: "apps" },
      { path: u("AppData", "Local", "Temp"), category: "caches" },
      { path: u("Pictures"), category: "photos" },
      { path: u("Videos"), category: "movies" },
      { path: u("Music"), category: "music" },
    );
  }
  return roots;
}

/** Another Linux install's root, seen from this one. */
function otherLinuxRoots(top: string): Root[] {
  const t = (...parts: string[]) => join(top, ...parts);
  return [
    { path: top, category: "system" },
    { path: t("usr"), category: "system" },
    { path: t("var"), category: "system" },
    { path: t("var", "cache"), category: "system" },
    { path: t("var", "log"), category: "system" },
    { path: t("var", "lib"), category: "system" },
    { path: t("opt"), category: "apps" },
    { path: t("home"), category: "documents" },
    { path: t("srv"), category: "documents" },
  ];
}

/** Swap files in use, wherever they are. They count as System data. */
function swapFiles(): string[] {
  try {
    return readFileSync("/proc/swaps", "utf8")
      .split("\n")
      .slice(1)
      .map((line) => line.split(/\s+/))
      .filter((fields) => fields[1] === "file")
      .map((fields) => fields[0].replace(/\\040/g, " "));
  } catch {
    return [];
  }
}

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Works out which folders to measure on a drive and what may be removed from it. */
export async function layoutFor(drive: Drive, home: string = homedir()): Promise<Layout> {
  if (IS_MAC) return macLayout(home);
  if (IS_WINDOWS) {
    const roots: Root[] = drive.system ? (await windowsRoots(drive.mount)).filter((root) => root.category !== "caches") : [
      { path: drive.mount, category: "documents" },
      { path: join(drive.mount, "$Recycle.Bin"), category: "trash" },
    ];
    if (drive.home && !drive.system) roots.push({ path: home, category: "documents", hidden: "developer" });
    const unique = new Map<string, Root>();
    for (const root of [...roots, ...windowsCacheRoots()]) {
      if (root.path.toLowerCase() === drive.mount.toLowerCase() || insidePath(root.path, drive.mount)) {
        unique.set(root.path.toLowerCase(), root);
      }
    }
    return {
      drive, home, roots: [...unique.values()],
      lookOnly: drive.readOnly ? "the Recycle Bin is available only on fixed NTFS drives" : null,
      foreign: (path) => path.toLowerCase() !== drive.mount.toLowerCase() && !insidePath(path, drive.mount),
      skip: () => false,
      canonical: (path) => resolve(path),
    };
  }

  const all = readMounts();
  const byPoint = new Map(all.map((m) => [m.point, m]));
  const own = drive.mounts;
  const foreign = (path: string) => {
    const mount = byPoint.get(path);
    return !!mount && mount.id !== drive.id;
  };
  const alias = (path: string) => own.length > 1 && canonical(path, all) !== path;
  const onDrive = (path: string) => mountOf(realpath(path), all)?.id === drive.id;

  // The places this filesystem shows its own top level, once each.
  const tops = own.map((m) => m.point).filter((point) => canonical(point, all) === point);
  const top = own.find((m) => m.root === "/")?.point ?? drive.mount;

  let roots: Root[];
  let lookOnly: string | null = null;
  if (drive.kind === "windows") {
    roots = await windowsRoots(top);
    lookOnly = LOOK_ONLY.windows;
  } else if (drive.kind === "linux") {
    roots = otherLinuxRoots(top);
    lookOnly = LOOK_ONLY.linux;
  } else if (drive.kind === "boot") {
    roots = tops.map((path): Root => ({ path, category: "system" }));
    lookOnly = LOOK_ONLY.boot;
  } else {
    roots = linuxRoots(home).filter((root) => onDrive(root.path));
    // Whatever else is on the drive counts as your files, except on the
    // system's own root, where the rest is the system.
    for (const path of tops) {
      if (path === "/" || roots.some((r) => r.path === path || path.startsWith(r.path + "/"))) continue;
      roots.push({ path, category: "documents" });
    }
    // On a drive that is all yours, folder names say what they hold.
    if (!drive.home && !drive.system) {
      for (const path of tops) {
        try {
          for (const entry of await fsp.readdir(path, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const kind = FOLDER_KIND.find(([pattern]) => pattern.test(entry.name));
            if (kind) roots.push({ path: join(path, entry.name), category: kind[1] });
          }
        } catch {
          // unreadable top level; it is measured as one
        }
      }
    }
  }

  for (const path of swapFiles()) {
    if (onDrive(path)) roots.push({ path, category: "system" });
  }

  // Each drive's own trash, where things removed from it go.
  for (const path of tops) {
    for (const trash of [join(path, `.Trash-${uid}`, "files"), join(path, ".Trash", String(uid), "files")]) {
      if (!roots.some((r) => r.path === trash)) roots.push({ path: trash, category: "trash" });
    }
  }
  // A second root for one folder would count it twice; the last one listed wins,
  // so the specific roots added above beat the general lists.
  const unique = new Map<string, Root>();
  for (const root of roots) {
    const path = realpath(root.path);
    unique.delete(path);
    unique.set(path, { ...root, path });
  }
  roots = [...unique.values()];

  if (!lookOnly && drive.readOnly) {
    lookOnly =
      drive.fstype === "ntfs" || drive.fstype === "ntfs3"
        ? "mounted read-only · windows may be hibernated (fast startup); shut windows down fully to write here"
        : "this drive is mounted read-only";
  }
  return {
    drive,
    home,
    roots,
    lookOnly,
    foreign,
    skip: (path) => foreign(path) || alias(path),
    canonical: (path) => (own.length > 1 ? canonical(path, all) : path),
  };
}

/** Keeps a selected directory and its nested category roots, on the same volume. */
export async function scopedLayout(layout: Layout, path: string): Promise<Layout> {
  const scope = resolve(path);
  if (IS_WINDOWS) await verifyWindowsPath(scope);
  if (layout.foreign(scope) || !(await fsp.lstat(scope)).isDirectory()) throw new Error("Choose a directory on the selected drive.");
  if (layout.drive.mount === scope || (IS_WINDOWS && layout.drive.mount.toLowerCase() === scope.toLowerCase())) {
    return layout;
  }
  const enclosing = layout.roots.filter((root) => insidePath(scope, root.path) ||
    (IS_WINDOWS ? scope.toLowerCase() === root.path.toLowerCase() : scope === root.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const roots = layout.roots.filter((root) => insidePath(root.path, scope));
  return { ...layout, scope, roots: [{ path: scope, category: enclosing?.category ?? "documents" }, ...roots] };
}
