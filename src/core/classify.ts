import { basename, extname } from "node:path";
import type { CategoryId } from "./categories";
import { canRecyclePath, isProtectedPath, windowsCache } from "./cleanup-policy";
import { IS_MAC, IS_WINDOWS } from "./platform";
import { ambiguousArtifactName, projectLabel } from "./project-rules";
import type { Item } from "./scan";

/**
 * junk:   regenerates by itself or is a leftover; removing it loses nothing.
 * unused: probably not needed any more (old, or one of a kind you can redo); your call.
 * yours:  your data, in use; shown for context only.
 * system: the OS or a tool manages it; leave it to them.
 */
export type Verdict = "junk" | "unused" | "yours" | "system";

export interface Usage {
  /** Milliseconds since epoch. */
  at: number;
  /** "opened" when a last-opened date is known, "changed" when only the modification time is. */
  kind: "opened" | "changed";
}

export interface Label {
  verdict: Verdict;
  /** Short, lowercase reason, e.g. "rebuilds with npm install". */
  reason: string;
  cleanup?: "blocked" | "review" | "rebuildable";
}

const DAY = 24 * 3600 * 1000;

/**
 * Folders that are one thing as far as the user is concerned: a culprit search
 * stops at them instead of digging into their internals.
 */
export function isWhole(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === "node_modules" ||
    BUILD_CACHES.has(name) ||
    /\.(app|framework|photoslibrary|fcpbundle|logicx|imovielibrary|bundle|vmwarevm|pvm|utm|sparsebundle|xcarchive)$/.test(name)
  );
}

/** "3 days", "7 months", "2 years". */
export function age(ms: number): string {
  const days = Math.max(0, Math.floor(ms / DAY));
  if (days < 1) return "today";
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"}`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"}`;
}

/** "today", "3 days ago". */
export function ago(ms: number): string {
  const text = age(ms);
  return text === "today" ? "today" : `${text} ago`;
}

/** Compact age for a column: "3d", "7mo", "2y". */
export function shortAge(ms: number): string {
  const days = Math.max(0, Math.floor(ms / DAY));
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30.4)}mo`;
  return `${Math.floor(days / 365)}y`;
}

const BUILD_CACHES = new Set([
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".angular",
  ".expo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".dart_tool",
]);
const INSTALLERS = new Set([".dmg", ".pkg", ".mpkg", ".iso", ".xip", ".deb", ".rpm", ".msi"]);
const ARCHIVES = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz"]);
const SCREEN_CAPTURE = /^(screen recording|screenshot|cleanshot|screen shot|recording)\b/i;

function idle(usage: Usage | undefined, now: number): number | null {
  return usage ? now - usage.at : null;
}

/** What a piece of System data is, and the command that shrinks it when there is one. */
const SYSTEM_REASONS: Array<[RegExp, string]> = [
  [/^\/var\/cache\/pacman(\/|$)/, "pacman's package downloads · sudo paccache -rk1 keeps one version"],
  [/^\/var\/cache\/apt(\/|$)/, "apt's package downloads · sudo apt clean"],
  [/^\/var\/cache\/(dnf|libdnf5|yum)(\/|$)/, "dnf's package downloads · sudo dnf clean all"],
  [/^\/var\/cache\/zypp(\/|$)/, "zypper's package downloads · sudo zypper clean"],
  [/^\/var\/log\/journal(\/|$)/, "systemd journal · sudo journalctl --vacuum-size=500M shrinks it"],
  [/^\/var\/log(\/|$)/, "system logs"],
  [/^\/var\/lib\/systemd\/coredump(\/|$)/, "crash dumps · coredumpctl lists them; safe to delete with sudo"],
  [/^\/var\/tmp(\/|$)/, "temporary files · systemd-tmpfiles clears old ones"],
  [/^\/var\/cache(\/|$)/, "system caches"],
  [/^\/usr(\/|$)/, "installed packages · remove ones you don't use with your package manager"],
  [/^\/nix(\/|$)/, "nix store · nix-collect-garbage -d frees old generations"],
  [/^\/boot(\/|$)/, "kernels and boot files · removing them can stop your computer from starting"],
  [/^\/(swapfile|swap)(\/|$)|\/swap(file)?(\.img)?$/i, "swap file · the system uses it as extra memory"],
  [/^\/(\.snapshots|timeshift)(\/|$)/, "snapshots · remove old ones with snapper or timeshift"],
  [/^\/etc(\/|$)/, "system settings"],
  [/\/hiberfil\.sys$/i, "windows hibernation file · powercfg /h off in windows removes it"],
  [/\/pagefile\.sys$/i, "windows page file · windows sizes it itself"],
  [/\/swapfile\.sys$/i, "windows swap file"],
  [/\/System Volume Information(\/|$)/, "restore points · manage them in windows system protection"],
  [/\/Windows\/WinSxS(\/|$)/, "windows component store · disk cleanup in windows shrinks it"],
  [/\/\$Windows\.~(BT|WS)(\/|$)/, "leftovers from a windows upgrade · disk cleanup in windows removes them"],
  [/\/(Windows|Recovery|\$WinREAgent)(\/|$)/, "windows itself"],
  [/\/EFI\/Microsoft(\/|$)/, "the windows boot loader · removing it stops windows from starting"],
  [/\/EFI(\/|$)/, "boot loaders · removing them can stop your computer from starting"],
];

function systemReason(path: string): string {
  for (const [pattern, reason] of SYSTEM_REASONS) if (pattern.test(path)) return reason;
  return IS_MAC ? "managed by macOS" : "managed by the system";
}

/** Decides what an item probably is, from its name, where it lives, and when it was last used. */
export function classify(item: Item, category: CategoryId, usage?: Usage, now: number = Date.now()): Label {
  const path = IS_WINDOWS ? item.path.replace(/\\/g, "/") : item.path;
  const name = basename(item.path);
  const lower = name.toLowerCase();
  const ext = extname(lower);
  const since = idle(usage, now);
  const untouched =
    since !== null && usage && since > 30 * DAY ? ` · ${usage.kind === "opened" ? "not opened" : "not touched"} in ${age(since)}` : "";

  if (category === "system") return { verdict: "system", reason: systemReason(path) };
  if (isProtectedPath(item.path) && !canRecyclePath(item.path, true)) {
    return { verdict: "system", cleanup: "blocked", reason: systemReason(path) };
  }
  const project = projectLabel(item);
  if (project) return project;
  const namedCache = IS_WINDOWS && windowsCache(item.path);
  if (namedCache) return { verdict: "junk", reason: `${namedCache.label} · the application can recreate it` };
  if (category === "trash") return { verdict: "junk", reason: "already in the trash" };
  if (path.includes("/SoftwareDistribution/Download"))
    return { verdict: "junk", reason: "windows update downloads · disk cleanup in windows clears them" };
  if (category === "caches") return { verdict: "junk", reason: "cache · apps rebuild it when they need it" };

  // Platform-managed caches have dedicated paths; generic project names need markers.
  if (path.includes("/Xcode/DerivedData")) return { verdict: "junk", reason: "xcode build products · rebuild on next build" };
  if (path.includes("/iOS DeviceSupport/") || path.includes("/watchOS DeviceSupport/"))
    return { verdict: "junk", reason: "debug symbols for one device os · xcode fetches them again" };
  if (path.includes("/CoreSimulator/Caches")) return { verdict: "junk", reason: "simulator cache" };
  if (/\/steamapps\/shadercache(\/|$)/.test(path)) return { verdict: "junk", reason: "shader cache · steam rebuilds it" };
  if (/\/\.var\/app\/[^/]+\/cache$/.test(path)) return { verdict: "junk", reason: "flatpak app cache · the app rebuilds it" };

  // Installers and leftovers.
  if (INSTALLERS.has(ext)) return { verdict: "junk", reason: `installer · not needed once installed${untouched}` };

  // Probably not needed, but yours to decide.
  if (path.includes("/CoreSimulator/Devices/")) return { verdict: "unused", reason: `simulator device${untouched}` };
  if (path.includes("/Xcode/Archives/")) return { verdict: "unused", reason: `old app archive${untouched}` };
  if (path.includes("/MobileSync/Backup/")) return { verdict: "unused", reason: `iphone or ipad backup${untouched}` };
  if (ARCHIVES.has(ext) && path.includes("/Downloads/")) return { verdict: "unused", reason: `downloaded archive${untouched}` };
  if (SCREEN_CAPTURE.test(name) && since !== null && since > 14 * DAY)
    return { verdict: "unused", reason: `screen capture from ${ago(since)}` };
  if (lower === "windows.old" && item.dir)
    return { verdict: "unused", reason: "previous windows install · disk cleanup in windows removes it" };

  // Things a tool owns; deleting by hand breaks the tool.
  if (lower === "docker.raw" || path.includes("/com.docker.docker/"))
    return { verdict: "system", reason: "docker's disk · shrink it with docker system prune" };
  if (path.includes("/.ollama/models")) return { verdict: "system", reason: "local ai models · remove with ollama rm" };
  if (path.startsWith("/opt/homebrew") || path.startsWith("/usr/local/Cellar") || path.startsWith("/home/linuxbrew/"))
    return { verdict: "system", reason: "homebrew manages this · brew cleanup removes old versions" };
  if (/^\/var\/lib\/docker(\/|$)|\/\.local\/share\/docker(\/|$)/.test(path))
    return { verdict: "system", reason: "docker's images and volumes · shrink them with docker system prune" };
  if (/^\/var\/lib\/containers(\/|$)|\/\.local\/share\/containers(\/|$)/.test(path))
    return { verdict: "system", reason: "podman's images · shrink them with podman system prune" };
  if (/^\/var\/lib\/flatpak(\/|$)|\/\.local\/share\/flatpak(\/|$)/.test(path))
    return { verdict: "system", reason: "flatpak manages this · flatpak uninstall --unused removes leftovers" };
  if (/^\/var\/lib\/snapd(\/|$)/.test(path))
    return { verdict: "system", reason: "snap manages this · snap remove --revision drops old versions" };
  if (/^\/var\/lib\/libvirt(\/|$)/.test(path))
    return { verdict: "system", reason: "virtual machines · remove them in virt-manager" };
  if (!IS_MAC && /^\/(opt|usr\/local)(\/|$)/.test(path))
    return { verdict: "system", reason: "installed software · uninstall it with your package manager" };

  if (item.dir && ambiguousArtifactName(item.path)) return { verdict: "yours", reason: "" };

  // Nothing about the name says junk; fall back to how long it has sat there.
  if (since !== null && usage) {
    const verb = usage.kind === "opened" ? "not opened" : "not touched";
    if (since > 365 * DAY) return { verdict: "unused", reason: `${verb} in ${age(since)}` };
    if (since > 180 * DAY && (ext === ".app" || category === "movies" || path.includes("/Downloads/")))
      return { verdict: "unused", reason: `${verb} in ${age(since)}` };
    return { verdict: "yours", reason: `${usage.kind} ${ago(since)}` };
  }
  return { verdict: "yours", reason: "" };
}
