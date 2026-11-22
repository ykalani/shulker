import { basename } from "node:path";
import { CATEGORIES, CATEGORY, CLEARABLE, type CategoryId } from "../core/categories";
import { classify, type Label, type Usage } from "../core/classify";
import { canRecyclePath, deduplicateCleanup, isProtectedPath, windowsCache } from "../core/cleanup-policy";
import { cleanupExclusion, clearProjectRuleCache, discoverProjectCandidates, freshProjectLabel, gitIgnoreEvidence, projectLabel,
  recheckProjectCandidate } from "../core/project-rules";
import {
  cannotRemove,
  demoCulprit,
  demoUsage,
  findCulprit,
  forgetAllSizes,
  forgetSizes,
  usage as lookUpUsage,
  type Culprit,
  deleteForGood,
  deletesForGood,
  demoChildren,
  listFolder,
  moveToTrash,
  reveal,
  trashPathFor,
  type ListHandle,
} from "../core/browse";
import { clean, plan, type Clearable } from "../core/clean";
import { demoDrives, demoLayout, demoPlan, startDemoScan } from "../core/demo";
import { listDrives, pickDrive, type Drive, type Partition } from "../core/drives";
import { size, tilde } from "../core/format";
import { layoutFor, scopedLayout, type Layout } from "../core/layout";
import { FILE_MANAGER, insidePath, IS_MAC, IS_WINDOWS, OS_NAME } from "../core/platform";
import { diskSpace, emptySnapshot, measure, startScan, unmeasuredBytes, type Item, type ScanHandle, type ScanSnapshot } from "../core/scan";

export interface Action {
  id: Clearable;
  /** Path being removed right now. */
  current: string;
}

/** Which side of the screen the arrow keys move in. */
export type Pane = "sidebar" | "list";

/** A folder opened inside the detail pane. */
export interface Level {
  path: string;
  size: number;
}

export interface AppState {
  /** Mounted drives; one on a Mac. */
  drives: Drive[];
  /** Index of the drive on screen. */
  drive: number;
  /** How the drive on screen is measured; null while it is being worked out. */
  layout: Layout | null;
  /** Partitions with files on them that are not mounted. */
  unmounted: Partition[];
  scan: ScanSnapshot;
  /** Category shown in the detail pane. */
  selected: CategoryId;
  /** Category under the pointer in the bar or sidebar. */
  hover: CategoryId | null;
  pane: Pane;
  /** Highlighted row in the detail list. */
  row: number;
  /** Folders opened below the category, outermost first. */
  stack: Level[];
  /** Contents of the innermost opened folder. */
  children: Item[];
  /** True while the opened folder is still being measured. */
  listing: boolean;
  /** Category-wide clearing in progress. */
  action: Action | null;
  /** What is waiting for a second press: a category to clear, or one item to remove. */
  confirm: { kind: "category"; id: Clearable } | { kind: "item"; path: string } | null;
  /** Item being moved or deleted right now. */
  removing: string | null;
  /** Estimated bytes cleared since the app started. */
  freed: number;
  /** One line about the last action, shown until the next one. */
  note: string | null;
  /** When each listed item was last opened or changed, by path. */
  usage: Record<string, Usage>;
  /** Where the space inside each folder is, by path; "pending" while it is being measured. */
  culprits: Record<string, Culprit | "pending">;
  /** Show only things labelled junk or unused. */
  junkOnly: boolean;
  projectView: boolean;
  projectScanning: boolean;
  projects: Item[];
  projectBytes: number;
  gitEvidence: Record<string, Label | null>;
}

export interface Options {
  demo: boolean;
  dryRun: boolean;
  /** Drive to open first: a number, name, mount point or any path on it. */
  drive?: string;
  path?: string;
}

type Listener = () => void;

/** Sizes below this are not worth a suggestion. */
const WORTH_CLEARING = 50e6;
/** Longest list the detail pane draws. */
export const MAX_ROWS = 150;

export class Store {
  private state: AppState = {
    drives: [],
    drive: 0,
    layout: null,
    unmounted: [],
    scan: emptySnapshot(),
    selected: CATEGORIES[0].id,
    hover: null,
    pane: "sidebar",
    row: 0,
    stack: [],
    children: [],
    listing: false,
    action: null,
    confirm: null,
    removing: null,
    freed: 0,
    note: null,
    usage: {},
    culprits: {},
    junkOnly: false,
    projectView: false,
    projectScanning: false,
    projects: [],
    projectBytes: 0,
    gitEvidence: {},
  };
  private listeners = new Set<Listener>();
  private scanHandle: ScanHandle | null = null;
  private listHandle: ListHandle | null = null;
  private confirmTimer: NodeJS.Timeout | null = null;
  private culpritHandle: ListHandle | null = null;
  private culpritQueue: Item[] = [];
  private usagePending = new Set<string>();
  private enrichScheduled = false;
  /** Finished scans by drive, so switching back to a drive is instant. */
  private scans = new Map<string, ScanSnapshot>();
  /** Bumped on every drive load, so a slow one that was overtaken is dropped. */
  private loads = 0;
  private projectsScan: AbortController | null = null;
  private projectsLoaded = false;
  private gitPending: string | null = null;

  constructor(readonly options: Options) {}

  get = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>) {
    const before = this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      before.selected !== this.state.selected ||
      before.stack !== this.state.stack ||
      before.children !== this.state.children ||
      before.projects !== this.state.projects ||
      before.projectView !== this.state.projectView ||
      before.row !== this.state.row ||
      before.scan.phase !== this.state.scan.phase ||
      before.junkOnly !== this.state.junkOnly
    ) {
      this.scheduleEnrich();
    }
  }

  // ---- labels, last-used dates and culprits ---------------------------------

  /** What an item probably is, and why. */
  label(item: Item, state: AppState = this.state): Label {
    const named = IS_WINDOWS ? windowsCache(item.path) : undefined;
    const exclusion = !this.options.demo && cleanupExclusion(item.path);
    if (exclusion) return { verdict: "system", reason: exclusion, cleanup: "blocked" };
    if (named) return { verdict: "junk", reason: `${named.label} · the tool regenerates it` };
    if (!this.options.demo && isProtectedPath(item.path)) return {
      verdict: "system", reason: "Managed by the system or its application.", cleanup: "blocked",
    };
    const category = state.projectView ? "documents" : state.selected;
    const label = classify(item, category, state.usage[item.path]);
    return label.verdict === "yours" ? state.gitEvidence[item.path] ?? label : label;
  }

  toggleJunkOnly() {
    this.clearConfirm();
    this.set({ junkOnly: !this.state.junkOnly, row: 0 });
  }

  /** Fetches dates and culprits for whatever just came on screen, once things settle. */
  private scheduleEnrich() {
    if (this.enrichScheduled) return;
    this.enrichScheduled = true;
    setTimeout(() => {
      this.enrichScheduled = false;
      this.enrich();
    }, 120);
  }

  private enrich() {
    const { scan, listing, row } = this.state;
    if (scan.phase !== "done" && this.state.stack.length === 0) return;
    const all = this.allEntries().slice(0, MAX_ROWS);

    // Last-used dates for every visible row.
    const missing = all.map((i) => i.path).filter((p) => !(p in this.state.usage) && !this.usagePending.has(p));
    if (missing.length > 0) {
      if (this.options.demo) {
        const usage = { ...this.state.usage };
        for (const p of missing) usage[p] = demoUsage(p);
        this.set({ usage });
      } else {
        for (const p of missing) this.usagePending.add(p);
        void lookUpUsage(missing).then((found) => {
          for (const p of missing) this.usagePending.delete(p);
          this.set({ usage: { ...this.state.usage, ...Object.fromEntries(found) } });
        });
      }
    }

    // Culprits: the highlighted folder first, then the biggest few on screen.
    if (listing) return;
    const entries = this.entries();
    const current = entries[row];
    if (current && !this.options.demo && this.label(current).verdict === "yours" &&
        !(current.path in this.state.gitEvidence) && this.gitPending !== current.path) {
      const path = current.path;
      const ticket = this.loads;
      this.gitPending = path;
      void gitIgnoreEvidence(path).then((label) => {
        if (this.gitPending === path) this.gitPending = null;
        if (ticket === this.loads) this.set({ gitEvidence: { ...this.state.gitEvidence, [path]: label } });
      });
    }
    const wanted = [entries[row], ...entries.filter((i) => i.dir).slice(0, 4)].filter(
      (i): i is Item => !!i && !!i.dir && !(i.path in this.state.culprits),
    );
    const seen = new Set<string>();
    this.culpritQueue = wanted.filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)));
    this.nextCulprit();
  }

  private nextCulprit(): void {
    if (this.culpritHandle) return;
    const item = this.culpritQueue.shift();
    if (!item) return;
    if (item.path in this.state.culprits) return this.nextCulprit();
    this.set({ culprits: { ...this.state.culprits, [item.path]: "pending" } });
    const finish = (culprit: Culprit) => {
      this.culpritHandle = null;
      this.set({ culprits: { ...this.state.culprits, [item.path]: culprit } });
      this.nextCulprit();
    };
    if (this.options.demo) {
      const category = this.state.selected;
      const depth = this.state.stack.length + 1;
      const timer = setTimeout(() => finish(demoCulprit(category, item.path, item.size, depth)), 350);
      this.culpritHandle = { cancel: () => clearTimeout(timer) };
      return;
    }
    this.culpritHandle = findCulprit(item.path, finish);
  }

  /** Stops measuring culprits that are no longer on screen. */
  private dropCulpritWork() {
    this.culpritQueue = [];
    if (this.culpritHandle) {
      this.culpritHandle.cancel();
      this.culpritHandle = null;
      const culprits = { ...this.state.culprits };
      for (const [path, value] of Object.entries(culprits)) if (value === "pending") delete culprits[path];
      this.state = { ...this.state, culprits };
    }
  }

  /** Opens every folder on the way to the highlighted folder's culprit and lands on it. */
  goToCulprit(row = this.state.row) {
    const item = this.entries()[row];
    const culprit = item ? this.state.culprits[item.path] : undefined;
    if (!item || !culprit || culprit === "pending" || culprit.chain.length === 0 || this.state.removing) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    const path = [item, ...culprit.chain];
    const last = path[path.length - 1];
    // Land in the folder that holds the culprit, with the culprit highlighted.
    const target = path[path.length - 2];
    const above = path.slice(0, path.length - 2).map((i) => ({ path: i.path, size: i.size }));
    this.set({ stack: [...this.state.stack, ...above] });
    this.openItem(target, last.path);
  }

  /** True when nothing is deleted for real. */
  get pretend(): boolean {
    return this.options.demo || this.options.dryRun;
  }

  // ---- scanning ------------------------------------------------------------

  /** Lists the drives again and measures the one on screen from scratch. */
  rescan(note: string | null = null) {
    if (this.state.action || this.state.removing) return;
    this.stopWork();
    forgetAllSizes();
    clearProjectRuleCache();
    this.scans.clear();
    this.set({ scan: emptySnapshot(), note, stack: [], children: [], listing: false, row: 0,
      culprits: {}, projects: [], projectBytes: 0, projectScanning: false, gitEvidence: {} });
    const current = this.state.drives[this.state.drive];
    void this.load(async () => {
      const { drives, unmounted } = this.options.demo ? { drives: demoDrives(), unmounted: [] } : await listDrives();
      const keep = current ? drives.findIndex((d) => d.id === current.id) : -1;
      const wanted = this.options.path ?? this.options.drive;
      const asked = pickDrive(wanted, drives);
      if (wanted && !asked && !current) throw new Error(`No drive matches ${wanted}.`);
      this.set({ drives, unmounted, drive: keep >= 0 ? keep : Math.max(0, drives.indexOf(asked ?? drives[0])) });
    });
  }

  private stopWork() {
    this.projectsScan?.abort();
    this.projectsScan = null;
    this.projectsLoaded = false;
    this.scanHandle?.cancel();
    this.scanHandle = null;
    this.listHandle?.cancel();
    this.clearConfirm();
    this.dropCulpritWork();
  }

  /** Works out the drive's layout, then shows its last scan or measures it. */
  private async load(before?: () => Promise<void>) {
    const ticket = ++this.loads;
    this.set({ layout: null });
    try {
      await before?.();
      const drive = this.state.drives[this.state.drive];
      if (ticket !== this.loads) return;
      if (!drive) throw new Error("No readable drives found.");
      const base = this.options.demo ? demoLayout(drive) : await layoutFor(drive);
      const layout = this.options.path && !this.options.demo ? await scopedLayout(base, this.options.path) : base;
      if (ticket !== this.loads) return;
      this.set({ layout, ...(layout.scope && !this.state.projectView ? { selected: layout.roots[0].category } : {}) });
      const cached = this.scans.get(drive.id);
      if (cached) {
        this.set({ scan: cached });
        if (this.state.projectView) void this.findProjects();
        return;
      }
      const start = this.options.demo ? startDemoScan : startScan;
      const handle = start(layout, (scan) => {
        if (this.scanHandle !== handle) return;
        if (scan.phase === "done") this.scans.set(drive.id, scan);
        this.set({ scan });
        if (scan.phase === "done" && this.state.projectView) void this.findProjects();
      });
      this.scanHandle = handle;
      await handle.done;
    } catch (error) {
      if (ticket === this.loads) this.set({ note: error instanceof Error ? error.message : String(error),
        scan: { ...this.state.scan, phase: "done" } });
    }
  }

  /** Shows another drive: by index, or relative to this one with step. */
  setDrive(index: number) {
    const { drives, drive, action, removing } = this.state;
    if (action || removing || drives.length < 2 || this.options.path) return;
    const next = ((index % drives.length) + drives.length) % drives.length;
    if (next === drive) return;
    // Keep what the current drive's scan knows, deletions included.
    if (this.state.scan.phase === "done") this.scans.set(drives[drive].id, this.state.scan);
    this.stopWork();
    this.set({ drive: next, scan: emptySnapshot(), note: null, stack: [], children: [], listing: false,
      row: 0, pane: "sidebar", projects: [], projectBytes: 0, projectScanning: false });
    void this.load();
  }

  nextDrive(step = 1) {
    this.setDrive(this.state.drive + step);
  }

  // ---- moving around -------------------------------------------------------

  setHover(hover: CategoryId | null) {
    if (hover !== this.state.hover) this.set({ hover });
  }

  /** Shows a category in the detail pane, back at its top level. */
  select(id: CategoryId, pane: Pane = this.state.pane) {
    if (!this.state.projectView && id === this.state.selected && this.state.stack.length === 0) {
      if (pane !== this.state.pane) this.set({ pane });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    this.set({ selected: id, stack: [], children: [], listing: false, row: 0, pane, projectView: false });
  }

  moveCategory(delta: number) {
    if (this.state.projectView) {
      if (delta < 0) this.select(CATEGORIES[CATEGORIES.length - 1].id, "sidebar");
      return;
    }
    const index = CATEGORIES.findIndex((c) => c.id === this.state.selected);
    if (index === CATEGORIES.length - 1 && delta > 0) {
      this.toggleProjects();
      return;
    }
    const next = CATEGORIES[Math.max(0, Math.min(CATEGORIES.length - 1, index + delta))];
    this.select(next.id, "sidebar");
  }

  setPane(pane: Pane) {
    if (pane === "list" && this.entries().length === 0 && !this.state.projectView) return;
    if (pane !== this.state.pane) this.set({ pane });
  }

  /** What the detail pane lists right now. */
  entries(state: AppState = this.state): Item[] {
    const list = this.allEntries(state);
    return list.length > MAX_ROWS ? list.slice(0, MAX_ROWS) : list;
  }

  /** Every entry, including those past the drawing limit. */
  allEntries(state: AppState = this.state): Item[] {
    const list = state.stack.length === 0 ? (state.projectView ? state.projects : state.scan.items[state.selected]) : state.children;
    if (!state.junkOnly) return list;
    return list.filter((item) => {
      const { verdict } = this.label(item, state);
      return verdict === "junk" || verdict === "unused";
    });
  }

  toggleProjects() {
    if (this.state.action || this.state.removing) return;
    if (this.state.projectView) {
      this.select(this.state.selected, "sidebar");
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    this.set({ projectView: true, pane: "list", junkOnly: false, stack: [], children: [],
      listing: false, row: 0, note: null });
    void this.findProjects();
  }

  private async findProjects() {
    const { layout, scan } = this.state;
    if (!layout || scan.phase !== "done" || this.projectsLoaded || this.projectsScan) return;
    if (this.options.demo) {
      const projects = deduplicateCleanup([...scan.items.caches, ...scan.items.developer].slice(0, 8));
      this.set({ projects, projectBytes: projects.reduce((total, item) => total + item.size, 0) });
      this.projectsLoaded = true;
      return;
    }
    const controller = new AbortController();
    this.projectsScan = controller;
    this.set({ projectScanning: true });
    const roots = layout.roots.filter((root) => root.category !== "system" && root.category !== "trash")
      .map((root) => root.path);
    try {
      const { candidates, truncated } = await discoverProjectCandidates(roots, {
        signal: controller.signal, skip: (path) => layout.skip(path) || (!roots.includes(path) && isProtectedPath(path)),
      });
      if (controller.signal.aborted) return;
      const caches = scan.items.caches.filter((item) => !cleanupExclusion(item.path) &&
        (!IS_WINDOWS || !!windowsCache(item.path)));
      const projects = deduplicateCleanup([...caches, ...candidates]);
      this.projectsLoaded = true;
      this.set({ projects, projectBytes: projects.reduce((total, item) => total + item.size, 0),
        ...(truncated ? { note: "Cleanup search reached its directory limit. Scan a smaller folder with --path." } : {}) });
    } catch (error) {
      if (!controller.signal.aborted) this.set({ note: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.projectsScan === controller) {
        this.projectsScan = null;
        this.set({ projectScanning: false });
      }
    }
  }

  /** Bytes in the current list labelled junk, and labelled unused. */
  reclaimable(state: AppState = this.state): { junk: number; unused: number } {
    const list = state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
    let junk = 0;
    let unused = 0;
    for (const item of list) {
      const { verdict } = this.label(item, state);
      if (verdict === "junk") junk += item.size;
      else if (verdict === "unused") unused += item.size;
    }
    return { junk, unused };
  }

  /** Size of whatever the detail pane is looking at. */
  scopeSize(state: AppState = this.state): number {
    const top = state.stack[state.stack.length - 1];
    return top ? top.size : state.scan.sizes[state.selected];
  }

  moveRow(delta: number) {
    const count = this.entries().length;
    if (count === 0) return;
    const row = Math.max(0, Math.min(count - 1, this.state.row + delta));
    if (row !== this.state.row) {
      this.clearConfirm();
      this.set({ row });
    }
  }

  setRow(row: number) {
    if (row !== this.state.row) this.clearConfirm();
    this.set({ row, pane: "list" });
  }

  /** Opens the highlighted folder and measures what is inside. */
  open(row = this.state.row) {
    const item = this.entries()[row];
    if (!item || !item.dir || this.state.removing) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    const stack = [...this.state.stack, { path: item.path, size: item.size }];

    if (this.options.demo) {
      this.set({
        stack,
        children: demoChildren(this.state.selected, item.path, item.size, stack.length),
        listing: false,
        row: 0,
        pane: "list",
        note: null,
      });
      return;
    }

    this.set({ stack, children: [], listing: true, row: 0, pane: "list", note: null });
    const handle = listFolder(
      item.path,
      (children, done) => {
        if (this.listHandle !== handle) return;
        this.set({ children, listing: !done });
      },
      this.state.layout?.foreign,
    );
    this.listHandle = handle;
  }

  /** Goes up one folder; from the category's top level, back to the sidebar. */
  back() {
    this.clearConfirm();
    const { stack } = this.state;
    if (stack.length === 0) {
      this.set({ pane: "sidebar" });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const left = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    if (rest.length === 0) {
      const list = this.state.projectView ? this.state.projects : this.state.scan.items[this.state.selected];
      const row = Math.max(0, list.findIndex((i) => i.path === left.path));
      this.set({ stack: [], children: [], listing: false, row });
      return;
    }
    // Measure the parent again and land on the folder we just left.
    const parent = rest[rest.length - 1];
    this.set({ stack: rest.slice(0, -1) });
    this.openItem({ path: parent.path, size: parent.size, dir: true }, left.path);
  }

  /** Opens a folder that is not necessarily in the current list. */
  private openItem(item: Item, highlight?: string) {
    const stack = [...this.state.stack, { path: item.path, size: item.size }];
    const pick = (children: Item[]) => Math.max(0, children.findIndex((c) => c.path === highlight));
    if (this.options.demo) {
      const children = demoChildren(this.state.selected, item.path, item.size, stack.length);
      this.set({ stack, children, listing: false, row: pick(children), pane: "list" });
      return;
    }
    this.set({ stack, children: [], listing: true, row: 0, pane: "list" });
    const handle = listFolder(
      item.path,
      (children, done) => {
        if (this.listHandle !== handle) return;
        this.set({ children, listing: !done, row: done ? pick(children) : this.state.row });
      },
      this.state.layout?.foreign,
    );
    this.listHandle = handle;
  }

  /** Jumps back to a level in the breadcrumb: -1 is the category itself. */
  jump(level: number) {
    const { stack } = this.state;
    if (level >= stack.length - 1) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.clearConfirm();
    if (level < 0) {
      this.set({ stack: [], children: [], listing: false, row: 0 });
      return;
    }
    const target = stack[level];
    this.set({ stack: stack.slice(0, level) });
    this.openItem({ path: target.path, size: target.size, dir: true });
  }

  // ---- acting on items -----------------------------------------------------

  /** Why the highlighted item cannot be removed, or null. */
  blocked(item: Item | undefined): string | null {
    if (!item) return "Nothing selected.";
    const { layout, selected } = this.state;
    if (!layout) return "Still working out this drive.";
    if (layout.lookOnly) return layout.lookOnly.charAt(0).toUpperCase() + layout.lookOnly.slice(1) + ".";
    if (selected === "system" && !this.state.projectView) return IS_MAC ? "macOS manages System data." : `${OS_NAME} manages System data · the label says how to shrink it.`;
    if (this.options.demo) return null;
    const exclusion = cleanupExclusion(item.path);
    if (exclusion) return exclusion;
    const cache = IS_WINDOWS && !!windowsCache(item.path);
    if (!canRecyclePath(item.path, cache)) return "Protected by the system or the application that owns it.";
    const project = projectLabel(item);
    if (project?.cleanup === "blocked") return project.reason;
    if (!cache && this.state.projectView && !project) {
      return "Only verified project artifacts and named caches can be recycled.";
    }
    if (!cache && !project && this.state.gitEvidence[item.path]?.cleanup === "blocked") {
      return "Git ignore status is review context.";
    }
    return cannotRemove(item.path, layout, project?.cleanup === "rebuildable" || project?.cleanup === "review");
  }

  async reveal(row = this.state.row) {
    const item = this.entries()[row];
    if (!item) return;
    if (this.options.demo) {
      this.set({ note: `Demo: would show ${tilde(item.path)} in ${FILE_MANAGER}.` });
      return;
    }
    try {
      await reveal(item.path);
      this.set({ note: `Showing ${basename(item.path)} in ${FILE_MANAGER}.` });
    } catch {
      this.set({ note: `Could not show ${tilde(item.path)} in ${FILE_MANAGER}.` });
    }
  }

  /** First press arms, second press within a few seconds removes. */
  removeItem(row = this.state.row, confirmed = false) {
    const { state } = this;
    if (state.action || state.removing || state.scan.phase !== "done") return;
    const item = this.entries()[row];
    const reason = this.blocked(item);
    if (reason) {
      this.set({ note: reason });
      return;
    }
    if (confirmed && state.confirm?.kind === "item" && state.confirm.path === item.path) {
      this.clearConfirm();
      void this.runRemove(item);
      return;
    }
    if (confirmed) return;
    this.arm({ kind: "item", path: item.path });
    if (row !== state.row) this.set({ row, pane: "list" });
  }

  private async runRemove(item: Item) {
    const category = this.state.selected;
    const layout = this.state.layout;
    if (!layout) return;
    const projectView = this.state.projectView;
    const project = freshProjectLabel(item);
    const artifact = project?.cleanup === "rebuildable" || project?.cleanup === "review";
    const forGood = !artifact && !projectView && deletesForGood(category);
    this.set({ removing: item.path, note: null });

    let ok = true;
    let error = "";
    let trashed = trashPathFor(item.path, layout);
    if (this.pretend) {
      await new Promise((done) => setTimeout(done, 450));
    } else {
      try {
        if (project?.cleanup === "blocked" || (projectView && !artifact && !(IS_WINDOWS && windowsCache(item.path)))) {
          throw new Error("Cleanup eligibility changed. Rescan and review the item again.");
        }
        if (artifact && !IS_WINDOWS && !(await recheckProjectCandidate(item, layout.foreign))) {
          throw new Error("Project evidence or contents changed. Rescan and review the item again.");
        }
        if (forGood) await deleteForGood(item.path, category);
        else trashed = await moveToTrash(item.path, layout, artifact);
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
      }
    }

    if (!ok) {
      const short = error.split("\n")[0].slice(0, 120);
      this.set({ removing: null, note: `Could not remove ${basename(item.path)}${short ? `: ${short}` : "."}` });
      return;
    }

    if (this.options.dryRun && !this.options.demo) {
      const verb = forGood ? "delete" : "move to Trash";
      this.set({ removing: null, note: `Dry run: would ${verb} ${basename(item.path)} (${size(item.size)}).` });
      return;
    }

    if (projectView && !this.pretend) {
      this.set({ removing: null });
      this.rescan(`Moved ${basename(item.path)} to ${IS_WINDOWS ? "the Recycle Bin" : "Trash"}. Space stays occupied until emptied.`);
      return;
    }
    if (projectView) {
      const projects = this.state.projects.filter((candidate) => candidate.path !== item.path);
      this.set({ projects, projectBytes: projects.reduce((total, candidate) => total + candidate.size, 0),
        removing: null, row: Math.max(0, Math.min(this.state.row, projects.length - 1)),
        note: `Demo: would move ${basename(item.path)} to Trash.` });
      return;
    }
    // Anything measured above or inside it is out of date now.
    forgetSizes(item.path);
    const culprits = { ...this.state.culprits };
    for (const path of Object.keys(culprits)) {
      if (path === item.path || insidePath(item.path, path)) delete culprits[path];
    }
    this.state = { ...this.state, culprits };

    // Take the item out of every list that holds it, and shrink the folders above it.
    const { scan, stack, children } = this.state;
    const drop = (list: Item[]) => list.filter((i) => i.path !== item.path);
    const sizes = { ...scan.sizes, [category]: Math.max(0, scan.sizes[category] - item.size) };
    const items = { ...scan.items, [category]: drop(scan.items[category]) };
    const shrink = (list: Item[]) =>
      list.map((i) => (insidePath(item.path, i.path) ? { ...i, size: Math.max(0, i.size - item.size) } : i));
    items[category] = shrink(items[category]);
    const nextStack = stack.map((level) => ({ ...level, size: Math.max(0, level.size - item.size) }));

    let space = scan;
    let measured = scan.measured;
    let freed = this.state.freed;
    if (forGood) {
      measured -= scan.sizes[category] - sizes[category];
      freed += item.size;
    } else {
      // Still on disk, only in the Trash now.
      sizes.trash += item.size;
      measured += item.size - (scan.sizes[category] - sizes[category]);
      if (!IS_WINDOWS) items.trash = [{ path: trashed, size: item.size, dir: item.dir }, ...items.trash].sort((a, b) => b.size - a.size);
    }
    if (this.options.demo && forGood) {
      const taken = Math.min(item.size, scan.used);
      space = { ...scan, used: scan.used - taken, available: scan.available + taken };
    } else if (!this.pretend) {
      const after = await diskSpace(layout.drive);
      if (after.total > 0) space = { ...scan, ...after };
      if (!layout.scope) sizes.system += unmeasuredBytes({ ...space, measured }) - unmeasuredBytes(scan);
    }

    const list = stack.length === 0 ? items[category] : drop(children);
    const trashName = IS_WINDOWS ? "the Recycle Bin" : "Trash";
    const verb = forGood ? "Deleted" : `Moved to ${trashName}:`;
    const prefix = this.pretend ? "Dry run, nothing changed. Would have " + (forGood ? "deleted" : "moved to Trash") : verb;
    this.set({
      scan: { ...space, sizes, items, measured },
      stack: nextStack,
      children: stack.length === 0 ? children : list,
      row: Math.min(this.state.row, Math.max(0, Math.min(list.length, MAX_ROWS) - 1)),
      removing: null,
      freed,
      note: `${prefix} ${basename(item.path)} (${size(item.size)}).${forGood || this.pretend ? "" : " Space stays occupied until the bin is emptied."}`,
    });
  }

  // ---- clearing a whole category ------------------------------------------

  /** The next thing worth clearing, or null. */
  suggestion(): Clearable | null {
    const { scan, action } = this.state;
    if (action) return action.id;
    if (scan.phase !== "done") return null;
    return CLEARABLE.find((id) => scan.sizes[id] >= WORTH_CLEARING) ?? null;
  }

  canClear(id: CategoryId): id is Clearable {
    const { layout, scan } = this.state;
    return !!layout && !layout.lookOnly && !layout.scope && (!IS_WINDOWS || this.options.demo) &&
      !this.state.projectView && (CLEARABLE as CategoryId[]).includes(id) && scan.sizes[id] >= WORTH_CLEARING;
  }

  pressCategory() {
    if (this.canClear(this.state.selected)) this.press(this.state.selected);
    else this.set({ note: "Select an individual cleanup candidate to review removal." });
  }

  confirmAction() {
    const confirm = this.state.confirm;
    if (confirm?.kind === "category") this.press(confirm.id, true);
    else if (confirm?.kind === "item") this.removeItem(this.state.row, true);
  }

  /** First press arms the button, second press within a few seconds clears. */
  press(id: Clearable, confirmed = false) {
    if (this.state.action || this.state.removing || this.state.scan.phase !== "done") return;
    if (confirmed && this.state.confirm?.kind === "category" && this.state.confirm.id === id) {
      this.clearConfirm();
      void this.run(id);
      return;
    }
    if (!confirmed) this.arm({ kind: "category", id });
  }

  private arm(confirm: NonNullable<AppState["confirm"]>) {
    this.clearConfirm();
    this.set({ confirm });
    this.confirmTimer = setTimeout(() => this.set({ confirm: null }), 4000);
  }

  private clearConfirm() {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.state.confirm) this.set({ confirm: null });
  }

  private async run(id: Clearable) {
    const layout = this.state.layout;
    if (!layout || layout.lookOnly) return;
    const original = this.state.scan;
    const dryRun = this.options.dryRun && !this.options.demo;
    const before = original.sizes[id];
    this.listHandle?.cancel();
    this.set({ action: { id, current: "" }, note: null, hover: null, selected: id, stack: [], children: [], row: 0 });

    const items = this.options.demo ? demoPlan(id, layout) : await plan(id, this.state.scan.items[id], layout);

    const onProgress = ({ path, freed }: { path: string; freed: number }) => {
      const scan = this.state.scan;
      const taken = Math.min(freed, scan.sizes[id]);
      const simulated = this.options.demo ? Math.min(taken, scan.used) : 0;
      this.set({
        action: { id, current: path },
        scan: {
          ...scan,
          sizes: { ...scan.sizes, [id]: scan.sizes[id] - taken },
          measured: dryRun ? scan.measured : scan.measured - taken,
          used: scan.used - simulated,
          available: scan.available + simulated,
        },
      });
    };

    let skipped = 0;
    if (this.options.demo) {
      for (const item of items) {
        await new Promise((done) => setTimeout(done, 70));
        onProgress({ path: item.path, freed: item.size });
      }
    } else {
      const result = await clean(id, items, layout, { dryRun: this.options.dryRun, onProgress });
      skipped = result.skipped.length;
    }

    // Replace the running estimate with what is actually on disk now.
    let scan = this.state.scan;
    if (!this.pretend) {
      const [left, space] = await Promise.all([measure(id, layout), diskSpace(layout.drive)]);
      const sizes = { ...scan.sizes, [id]: left };
      const measured = scan.measured + (left - scan.sizes[id]);
      scan = { ...scan, ...(space.total > 0 ? space : {}), sizes, measured };
      sizes.system += unmeasuredBytes(scan) - unmeasuredBytes(original);
    }
    const freed = Math.max(0, before - scan.sizes[id]);
    scan = { ...scan, items: { ...scan.items, [id]: [] } };

    const outcome = dryRun ? "would be cleared" : "cleared (estimated)";
    const parts = [`${CATEGORY[id].name}: ${size(freed)} ${outcome}.`];
    if (skipped > 0) parts.push(`${skipped} ${skipped === 1 ? "item was" : "items were"} in use or protected and left alone.`);
    this.set({
      scan: dryRun ? original : scan,
      action: null,
      pane: "sidebar",
      freed: this.state.freed + (dryRun ? 0 : freed),
      note: parts.join(" "),
    });
  }

  stop() {
    this.loads++;
    this.stopWork();
  }
}
