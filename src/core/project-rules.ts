import { execFile } from "node:child_process";
import { lstatSync, promises as fs, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isProtectedPath } from "./cleanup-policy";
import { fileBytes } from "./platform";
import type { Item } from "./scan";

export type ProjectLabel = {
  verdict: "junk" | "unused" | "system";
  reason: string;
  cleanup: "blocked" | "review" | "rebuildable";
};

export interface ProjectCandidate extends Item {
  label: ProjectLabel;
}

type Rule = {
  tool: string;
  markers: readonly (string | RegExp)[];
  paths: readonly string[];
  rebuild: string;
  fingerprint?: { readonly files?: readonly string[]; readonly folders?: readonly string[] };
  review?: boolean;
};

// Project-marker approach from Kondo and Disco. Shulker uses a narrower set
// for generic names and requires additional evidence for common source folders.
const RULES: readonly Rule[] = [
  { tool: "Cargo", markers: ["Cargo.toml"], paths: ["target"], fingerprint: { files: ["CACHEDIR.TAG", ".rustc_info.json"] }, rebuild: "run cargo build again" },
  { tool: "Cargo", markers: ["Cargo.toml"], paths: [".xwin-cache"], rebuild: "redownload the cross-compilation SDK" },
  { tool: "Node", markers: ["package.json"], paths: ["node_modules"], rebuild: "reinstall dependencies with the project's package manager" },
  { tool: "Next.js", markers: [/^next\.config\.[cm]?[jt]s$/], paths: [".next"], rebuild: "run the project's Next.js build again" },
  { tool: "Nuxt", markers: [/^nuxt\.config\.[cm]?[jt]s$/], paths: [".nuxt"], rebuild: "run the project's Nuxt build again" },
  { tool: "Turborepo", markers: ["turbo.json"], paths: [".turbo"], rebuild: "rerun the Turborepo tasks" },
  { tool: "Angular", markers: ["angular.json"], paths: [".angular/cache"], rebuild: "Angular regenerates its build cache" },
  { tool: "SvelteKit", markers: [/^svelte\.config\.[cm]?[jt]s$/], paths: [".svelte-kit"], rebuild: "run the project's SvelteKit build again" },
  { tool: "Python", markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", /\.py$/], paths: [".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__"], rebuild: "rerun the Python tool that generated it" },
  { tool: "Python test environment", markers: ["pyproject.toml", "tox.ini", "noxfile.py"], paths: [".tox", ".nox"], review: true, rebuild: "rerun the test environment setup; local changes may be lost" },
  { tool: "Jupyter", markers: [/\.ipynb$/], paths: [".ipynb_checkpoints"], review: true, rebuild: "checkpoints may contain earlier notebook versions" },
  { tool: "Pixi", markers: ["pixi.toml", "pixi.lock"], paths: [".pixi"], review: true, rebuild: "rerun pixi install; local environment changes may be lost" },
  { tool: "Gradle", markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], paths: [".gradle"], rebuild: "Gradle regenerates the project cache" },
  { tool: "Gradle", markers: ["build.gradle", "build.gradle.kts"], paths: ["build"], fingerprint: { folders: ["classes", "generated", "intermediates", "outputs", "reports"] }, rebuild: "run the Gradle build again" },
  { tool: "Maven", markers: ["pom.xml"], paths: ["target"], fingerprint: { folders: ["classes", "generated-sources", "maven-status", "surefire-reports"] }, rebuild: "run the Maven build again" },
  { tool: "CMake", markers: ["CMakeLists.txt"], paths: ["build", "cmake-build-debug", "cmake-build-release"], fingerprint: { files: ["CMakeCache.txt"] }, rebuild: "configure and build with CMake again" },
  { tool: ".NET", markers: [/\.[cf]sproj$/i], paths: ["obj"], fingerprint: { files: ["project.assets.json"] }, rebuild: "restore and build the .NET project again" },
  { tool: ".NET", markers: [/\.[cf]sproj$/i], paths: ["bin"], fingerprint: { folders: ["Debug", "Release"] }, review: true, rebuild: "rebuild the .NET project; check for manually copied releases" },
  { tool: "Unity", markers: ["Assembly-CSharp.csproj"], paths: ["Library"], fingerprint: { files: ["ArtifactDB", "SourceAssetDB"] }, rebuild: "reopen the project in Unity to reimport assets" },
  { tool: "Unreal", markers: [/\.uproject$/i], paths: ["DerivedDataCache", "Intermediate"], rebuild: "open or build the project in Unreal again" },
  { tool: "Composer", markers: ["composer.json"], paths: ["vendor"], fingerprint: { files: ["autoload.php"] }, rebuild: "run composer install again" },
  { tool: "Flutter", markers: ["pubspec.yaml"], paths: [".dart_tool", "linux/flutter/ephemeral", "windows/flutter/ephemeral"], rebuild: "restore dependencies and rebuild with Flutter" },
  { tool: "Swift", markers: ["Package.swift"], paths: [".build"], rebuild: "run swift build again" },
  { tool: "Zig", markers: ["build.zig"], paths: [".zig-cache", "zig-cache", "zig-out"], rebuild: "run zig build again" },
  { tool: "Godot", markers: ["project.godot"], paths: [".godot"], rebuild: "reopen the project in Godot to rebuild its cache" },
  { tool: "Elixir", markers: ["mix.exs"], paths: ["_build"], rebuild: "run mix compile again" },
  { tool: "Haskell Stack", markers: ["stack.yaml"], paths: [".stack-work"], rebuild: "run stack build again" },
  { tool: "Cabal", markers: ["cabal.project", /\.cabal$/], paths: ["dist-newstyle"], rebuild: "run cabal build again" },
  { tool: "sbt", markers: ["build.sbt"], paths: ["target", "project/target"], fingerprint: { folders: ["streams"] }, rebuild: "run the sbt build again" },
  { tool: "Terraform", markers: [".terraform.lock.hcl"], paths: [".terraform"], review: true, rebuild: "rerun terraform init; check backend configuration and local state first" },
  { tool: "CocoaPods", markers: ["Podfile"], paths: ["Pods"], fingerprint: { files: ["Manifest.lock"] }, rebuild: "run pod install again" },
];

const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const RULE_NAMES = new Set(RULES.flatMap(({ paths }) => paths.map((path) => fold(path.split("/").at(-1)!))));
const AMBIGUOUS_NAMES = new Set([...RULE_NAMES, "dist", "build", "out", "venv", ".venv", "env", ".expo", ".parcel-cache", ".angular"]);
const entriesCache = new Map<string, readonly string[]>();
const labelsCache = new Map<string, ProjectLabel | null>();
const MAX_CACHED_LABELS = 4000;
const MAX_CACHED_PROJECTS = 2000;

function contains(base: string, path: string): boolean {
  const delta = relative(base, path);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(".." + sep));
}

type Config = {
  exclude: string[];
  rules: Map<string, string>;
  error?: string;
};

let settings: Config | undefined;

function configPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error();
  const path = /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new Error();
  return resolve(path);
}

function loadConfig(): Config {
  if (settings) return settings;
  const file = process.env.SHULKER_CONFIG || join(homedir(), ".shulker.json");
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const { exclude = [], rules = [] } = raw as { exclude?: unknown; rules?: unknown };
    if (!Array.isArray(exclude) || !Array.isArray(rules)) throw new Error();
    const custom = new Map<string, string>();
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || typeof rule.reason !== "string" || !rule.reason.trim()) throw new Error();
      const reason = rule.reason.trim();
      if (reason.length > 300 || /[\x00-\x1f\x7f-\x9f]/.test(reason)) throw new Error();
      custom.set(fold(configPath(rule.path)), reason);
    }
    return settings = { exclude: exclude.map(configPath), rules: custom };
  } catch (error) {
    const missingDefault = (error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.SHULKER_CONFIG;
    return settings = { exclude: [], rules: new Map(), error: missingDefault ? undefined : "Cannot read cleanup configuration; review ~/.shulker.json or SHULKER_CONFIG." };
  }
}

export function clearProjectRuleCache(): void {
  settings = undefined;
  entriesCache.clear();
  labelsCache.clear();
}

/** Both a configured path and a removal containing that path are protected. */
export function cleanupExclusion(path: string): string | null {
  const { exclude, error } = loadConfig();
  if (error) return error;
  if (!isAbsolute(path)) return null;
  if (exclude.some((entry) => contains(entry, path) || contains(path, entry))) return "Protected by your cleanup exclusions.";
  return null;
}

export function ambiguousArtifactName(path: string): boolean {
  return AMBIGUOUS_NAMES.has(fold(basename(path)));
}

function markerNames(path: string): readonly string[] {
  const key = fold(path);
  const existing = entriesCache.get(key);
  if (existing) return existing;
  let names: string[] = [];
  try {
    names = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    // An unreadable project does not qualify as evidence.
  }
  if (entriesCache.size >= MAX_CACHED_PROJECTS) entriesCache.clear();
  entriesCache.set(key, names);
  return names;
}

function hasType(path: string, type: "file" | "folder"): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return !!info && (type === "file" ? info.isFile() : info.isDirectory());
}

function matchProject(item: Item, listedVenvMarker?: boolean): ProjectLabel | null {
  const path = item.path;
  const config = loadConfig();
  const custom = config.rules.get(fold(path));
  if (!item.dir && !custom) return null;
  try {
    if (listedVenvMarker === undefined) {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || (item.dir ? !info.isDirectory() : !info.isFile())) return null;
    }
    if (custom) return { verdict: "unused", cleanup: "review", reason: `custom rule · ${custom}` };
    if (listedVenvMarker ?? hasType(join(path, "pyvenv.cfg"), "file")) {
      return { verdict: "unused", cleanup: "review", reason: "Python environment · contains pyvenv.cfg · review locally installed packages before recreating it" };
    }
    if (!RULE_NAMES.has(fold(basename(path)))) return null;
    for (const { tool, markers, paths, rebuild, fingerprint, review } of RULES) {
      for (const artifact of paths) {
        const segments = artifact.split("/");
        if (fold(segments.at(-1)!) !== fold(basename(path))) continue;
        const project = resolve(path, ...segments.map(() => ".."));
        if (fold(join(project, ...segments)) !== fold(path) || project === path) continue;
        const marker = markerNames(project).find((name) =>
          markers.some((pattern) => typeof pattern === "string" ? fold(pattern) === fold(name) : pattern.test(fold(name))));
        if (!marker) continue;
        const proof = fingerprint?.files?.find((name) => hasType(join(path, name), "file"))
          ?? fingerprint?.folders?.find((name) => hasType(join(path, name), "folder"));
        if (fingerprint && !proof) continue;
        return {
          verdict: review ? "unused" : "junk",
          cleanup: review ? "review" : "rebuildable",
          reason: `${tool} artifact · ${marker}${proof ? ` and ${proof}` : ""} · ${rebuild}`,
        };
      }
    }
  } catch {
    // Denied or replaced paths do not qualify for cleanup.
  }
  return null;
}

export function projectLabel(item: Item): ProjectLabel | null {
  const excluded = cleanupExclusion(item.path);
  if (excluded) return { verdict: "system", cleanup: "blocked", reason: excluded };
  if (!isAbsolute(item.path) || (!item.dir && !loadConfig().rules.has(fold(item.path)))) return null;
  if (isProtectedPath(item.path)) return null;
  const key = `${item.dir ? "d" : "f"}${fold(item.path)}`;
  if (labelsCache.has(key)) return labelsCache.get(key)!;
  const label = matchProject(item);
  if (labelsCache.size >= MAX_CACHED_LABELS) labelsCache.clear();
  labelsCache.set(key, label);
  return label;
}

/** Recheck markers after confirmation, since project files can change while the UI is open. */
export function freshProjectLabel(item: Item): ProjectLabel | null {
  clearProjectRuleCache();
  return projectLabel(item);
}

/** Recheck the selected target and its contents before making a filesystem change. */
export async function recheckProjectCandidate(
  item: Item,
  skip?: (path: string) => boolean,
): Promise<ProjectLabel | null> {
  const label = freshProjectLabel(item);
  if (!label || label.cleanup === "blocked" || skip?.(item.path)) return null;
  if (!item.dir) return label;
  const { candidates } = await discoverProjectCandidates([item.path], { includeRoots: true, skip });
  return candidates.find(({ path }) => fold(path) === fold(item.path))?.label ?? null;
}

/** Git itself handles nested ignore files, tracked files, and negations. */
export function gitIgnoreEvidence(path: string): Promise<ProjectLabel | null> {
  if (!isAbsolute(path) || cleanupExclusion(path)) return Promise.resolve(null);
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return new Promise((done) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-C", dirname(path), "check-ignore", "-q", "--", "./" + basename(path)], {
      cwd: homedir(),
      env,
      timeout: 2000,
      windowsHide: true,
    }, (error) => done(error ? null : {
      verdict: "unused",
      cleanup: "blocked",
      reason: "ignored by Git · inspect in your project before removing",
    }));
  });
}

export async function discoverProjectCandidates(
  roots: readonly string[],
  options: {
    signal?: AbortSignal;
    skip?: (path: string) => boolean;
    onCandidate?: (candidate: ProjectCandidate) => void;
    maxDirectories?: number;
    includeRoots?: boolean;
  } = {},
): Promise<{ candidates: ProjectCandidate[]; truncated: boolean }> {
  const candidates: ProjectCandidate[] = [];
  const config = loadConfig();
  if (config.error) return { candidates, truncated: false };
  const examined = new Set<string>();
  const linksOrForeign = (path: string) =>
    options.skip?.(path) || config.exclude.some((entry) => contains(entry, path));
  const maxDirectories = options.maxDirectories ?? 100_000;
  let directories = 0;
  let truncated = false;
  const stopped = () => options.signal?.aborted || truncated;
  async function list(path: string) {
    if (stopped()) return;
    if (directories === maxDirectories) {
      truncated = true;
      return;
    }
    directories++;
    try {
      if (!(await fs.lstat(path)).isDirectory()) return;
      return await fs.readdir(path, { withFileTypes: true });
    } catch {
      // A missing, unreadable, or replaced folder contributes no evidence.
    }
  }
  async function visit(path: string, root = false, measure = false): Promise<number | null> {
    const key = fold(path);
    if (stopped()) return null;
    if (examined.has(key) || linksOrForeign(path)) return 0;
    examined.add(key);
    const entries = await list(path);
    if (!entries) return null;
    const label = (!root || options.includeRoots) && !measure && !cleanupExclusion(path) && !isProtectedPath(path)
      ? matchProject({ path, size: 0, dir: true }, entries.some((entry) => entry.isFile() && fold(entry.name) === fold("pyvenv.cfg")))
      : null;
    let bytes = 0;
    let complete = true;
    if (label || measure) {
      for (const entry of entries) {
        if (stopped()) return null;
        const child = join(path, entry.name);
        if (linksOrForeign(child) || isProtectedPath(child)) {
          complete = false;
          continue;
        }
        if (entry.isDirectory()) {
          const subtree = await visit(child, false, true);
          if (subtree === null) complete = false;
          else bytes += subtree;
        } else if (entry.isFile()) {
          try {
            const stat = await fs.lstat(child);
            if (stat.isFile()) bytes += fileBytes(stat);
            else complete = false;
          } catch {
            complete = false;
          }
        }
      }
      if (label && complete && bytes > 0) {
        const candidate = { path, size: bytes, dir: true, label };
        labelsCache.set(`d${key}`, label);
        candidates.push(candidate);
        options.onCandidate?.(candidate);
      }
      return complete ? bytes : null;
    }
    for (const entry of entries) {
      if (stopped()) break;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && config.rules.has(fold(child)) && !linksOrForeign(child) && !isProtectedPath(child)) {
        const label = projectLabel({ path: child, size: 0 });
        if (!label || label.cleanup === "blocked") continue;
        try {
          const stat = await fs.lstat(child);
          const candidate = { path: child, size: fileBytes(stat), dir: false, label };
          if (!stat.isFile() || candidate.size <= 0) continue;
          candidates.push(candidate);
          options.onCandidate?.(candidate);
        } catch {
          // The configured file may have disappeared during the scan.
        }
      }
    }
    return 0;
  }
  const uniqueRoots = [...new Set(roots.filter(isAbsolute).map((path) => resolve(path)))].sort((a, b) => a.length - b.length);
  for (const root of uniqueRoots) await visit(root, true);
  candidates.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  return { candidates, truncated };
}
