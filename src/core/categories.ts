import { homedir } from "node:os";
import { join } from "node:path";
import { IS_MAC, IS_WINDOWS } from "./platform";

export type CategoryId =
  | "apps"
  | "developer"
  | "photos"
  | "movies"
  | "documents"
  | "music"
  | "system"
  | "caches"
  | "trash";

/**
 * safe:   regenerates on its own or was already thrown away; clearing loses nothing.
 * review: yours to decide; the tool shows it but never deletes it for you.
 * keep:   personal data or managed by the system; never offered for deletion.
 */
export type Tier = "safe" | "review" | "keep";

export type Rgb = [number, number, number];

export interface Category {
  id: CategoryId;
  name: string;
  color: Rgb;
  tier: Tier;
  blurb: string;
}

/** Order is the order of segments in the bar and of the legend, row by row. */
export const CATEGORIES: Category[] = [
  {
    id: "apps",
    name: "Apps",
    color: [59, 130, 246],
    tier: "review",
    blurb: IS_MAC || IS_WINDOWS
      ? "Applications and the data they keep."
      : "Applications and the data they keep: /opt, Flatpak, Snap, ~/.local/share, ~/.config.",
  },
  {
    id: "developer",
    name: "Developer",
    color: [34, 197, 94],
    tier: "review",
    blurb: "Toolchains, SDKs, simulators, containers and tool folders.",
  },
  { id: "photos", name: "Photos", color: [236, 72, 153], tier: "keep", blurb: "Your pictures and photo libraries." },
  {
    id: "movies",
    name: IS_MAC ? "Movies" : "Videos",
    color: [139, 92, 246],
    tier: "keep",
    blurb: "Your videos and video projects.",
  },
  {
    id: "documents",
    name: "Documents",
    color: [34, 211, 238],
    tier: "review",
    blurb: IS_MAC || IS_WINDOWS
      ? "Documents, Desktop, Downloads and other folders in your home."
      : "Documents, Desktop, Downloads, other folders in your home, and loose files on other drives.",
  },
  { id: "music", name: "Music", color: [234, 179, 8], tier: "keep", blurb: "Your music and audio projects." },
  {
    id: "system",
    name: "System data",
    color: [156, 163, 175],
    tier: "keep",
    blurb: IS_WINDOWS ? "Windows, system-managed files, and protected data." : IS_MAC
      ? "macOS, logs, snapshots and anything this scan cannot read. The system manages these."
      : "The system, packages, logs, swap, snapshots and anything this scan cannot read. Your package manager handles these.",
  },
  {
    id: "caches",
    name: "Caches",
    color: [249, 115, 22],
    tier: "safe",
    blurb: "Apps and tools rebuild these when they need them.",
  },
  { id: "trash", name: "Trash", color: [239, 68, 68], tier: "safe", blurb: "Things you have already deleted." },
];

export const CATEGORY: Record<CategoryId, Category> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c]),
) as Record<CategoryId, Category>;

export const TIER_LABEL: Record<Tier, string> = {
  safe: "Safe to clear",
  review: "Review first",
  keep: "Keep",
};

export interface Root {
  path: string;
  /** System data is otherwise whatever the disk reports beyond what was measured; a system root lists where some of it is. */
  category: CategoryId;
  /** Category for the dot-folders directly inside this root, when it differs. */
  hidden?: CategoryId;
}

/**
 * Folders the scan measures on a Mac, and the category each one counts toward. A root
 * nested inside another root is measured on its own and left out of the outer
 * one, so nothing is counted twice (Xcode's DerivedData counts as a cache, not
 * as Developer).
 */
export function roots(home: string = homedir()): Root[] {
  const h = (...parts: string[]) => join(home, ...parts);
  return [
    { path: "/Applications", category: "apps" },
    { path: h("Applications"), category: "apps" },
    // Everything else apps keep: Application Support, Containers, Mail and so on.
    { path: h("Library"), category: "apps" },
    // Listed on their own so each app's folder is measured separately.
    { path: h("Library/Application Support"), category: "apps" },
    { path: h("Library/Containers"), category: "apps" },
    { path: h("Library/Group Containers"), category: "apps" },
    { path: "/Library/Application Support", category: "apps" },

    { path: h("Library/Developer"), category: "developer" },
    { path: h("Library/Containers/com.docker.docker"), category: "developer" },
    { path: h(".docker"), category: "developer" },
    { path: h(".cargo"), category: "developer" },
    { path: h(".rustup"), category: "developer" },
    { path: h("go"), category: "developer" },
    { path: h(".gradle"), category: "developer" },
    { path: h(".m2"), category: "developer" },
    { path: h(".nvm"), category: "developer" },
    { path: h(".pyenv"), category: "developer" },
    { path: h(".android"), category: "developer" },
    { path: h(".bun"), category: "developer" },
    { path: "/opt/homebrew", category: "developer" },
    { path: "/usr/local", category: "developer" },
    { path: "/Library/Developer", category: "developer" },

    { path: h("Pictures"), category: "photos" },
    { path: h("Movies"), category: "movies" },

    { path: h("Documents"), category: "documents" },
    { path: h("Desktop"), category: "documents" },
    { path: h("Downloads"), category: "documents" },
    { path: h("Library/Mobile Documents"), category: "documents" },
    { path: h("Library/CloudStorage"), category: "documents" },
    { path: "/Users/Shared", category: "documents" },
    // The rest of the home folder: project folders count as your files, and
    // dot-folders (~/.vscode, ~/.ollama, ...) as developer tooling.
    { path: home, category: "documents", hidden: "developer" },

    { path: h("Music"), category: "music" },

    { path: h("Library/Caches"), category: "caches" },
    { path: h(".cache"), category: "caches" },
    { path: h(".npm"), category: "caches" },
    { path: h("Library/Developer/Xcode/DerivedData"), category: "caches" },
    { path: h("Library/Developer/CoreSimulator/Caches"), category: "caches" },
    { path: h(".bun/install/cache"), category: "caches" },
    { path: h(".gradle/caches"), category: "caches" },

    { path: h(".Trash"), category: "trash" },
  ];
}

/** The categories this tool is willing to clear, in the order it suggests them. */
export const CLEARABLE: Array<Extract<CategoryId, "caches" | "trash">> = ["caches", "trash"];
