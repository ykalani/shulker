const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { demoDrives, demoLayout, demoSpace, startDemoScan } = require("../dist/core/demo");
const { IS_MAC, IS_WINDOWS } = require("../dist/core/platform");
const { diskSpace, emptySnapshot, startScan } = require("../dist/core/scan");
const { toJson, toText } = require("../dist/plain");
const { diskSegments } = require("../dist/ui/bar");
const { frame } = require("../dist/ui/terminal");
const { Store } = require("../dist/ui/store");

const drive = demoDrives()[0];
const stats = { blocks: 100, bsize: 1024, bfree: 95, bavail: 90 };
const used = (IS_MAC ? 10 : 5) * stats.bsize;
const space = { total: 100 * stats.bsize, used, available: 90 * stats.bsize };
const matches = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
};

test("filesystem accounting respects reserved blocks and the selected volume", { skip: IS_WINDOWS }, async (t) => {
  const mock = t.mock.method(fs, "statfs", async () => stats);
  const selected = { ...drive, mount: "/mnt/example" };
  assert.deepEqual(await diskSpace(selected), space);
  assert.equal(mock.mock.calls[0].arguments[0], IS_MAC ? "/System/Volumes/Data" : selected.mount);
});

test("folder estimates can exceed filesystem usage while disk meter stays bounded", { skip: IS_WINDOWS }, async (t) => {
  const root = await fs.mkdtemp(join(__dirname, ".shulker-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "first"));
  await fs.mkdir(join(root, "second"));
  await fs.writeFile(join(root, "first", "sample"), Buffer.alloc(64 * 1024, 1));
  await fs.link(join(root, "first", "sample"), join(root, "second", "sample"));
  t.mock.method(fs, "statfs", async () => stats);
  const layout = { ...demoLayout(drive), roots: [{ path: root, category: "documents" }] };
  const updates = [];
  const scan = await startScan(layout, (update) => updates.push(update), { concurrency: 1, throttleMs: 0 }).done;
  assert(updates.some((update) => update.phase === "scanning" && update.measured > update.used));
  for (const update of updates) matches(update, space);
  assert(scan.measured > scan.total);
  assert.equal(scan.sizes.documents, scan.measured);
  assert.equal(scan.sizes.system, 0);
  assert.equal(scan.items.documents.length, 2);
  matches(JSON.parse(toJson(scan, layout)), { ...space, measured: scan.measured });
  assert.match(toText(scan, layout, 1), /above filesystem usage/);
  assert(Math.abs(diskSegments(scan).reduce((sum, s) => sum + s.fraction, 0) - used / space.total) < 1e-8);
});

test("disk scan refreshes capacity, available bytes and usage together", { skip: IS_WINDOWS }, async (t) => {
  const after = { ...stats, blocks: 101, bfree: 94, bavail: 89 };
  let calls = 0;
  t.mock.method(fs, "statfs", async () => calls++ ? after : stats);
  const scan = await startScan(demoLayout(drive), () => {}).done;
  matches(scan, { total: 101 * stats.bsize, available: 89 * stats.bsize, used: used + 2 * stats.bsize });
});

test("failed refresh keeps initial usage and accounts for unmeasured space", { skip: IS_WINDOWS }, async (t) => {
  let calls = 0;
  t.mock.method(fs, "statfs", async () => {
    if (calls++) throw new Error("unavailable");
    return stats;
  });
  const scan = await startScan(demoLayout(drive), () => {}).done;
  matches(scan, { ...space, measured: 0 });
  assert.equal(scan.sizes.system, used);
});

test("the meter includes occupied space that has not been measured", () => {
  const scan = { ...emptySnapshot(), total: 100, used: 50, available: 40, measured: 20 };
  scan.sizes.documents = 20;
  const segments = diskSegments(scan);
  assert.equal(segments.find((segment) => segment.id === "documents").fraction, 0.2);
  assert.equal(segments.at(-1).fraction, 0.3);
});

test("demo maintains volume totals and renders visible storage and cleanup panes", { timeout: 10_000 }, async (t) => {
  const store = new Store({ demo: true, dryRun: true });
  t.after(() => store.stop());
  const layout = demoLayout(drive);
  const space = demoSpace(drive);
  const scan = await startDemoScan(layout, (update) => matches(update, space)).done;
  assert.equal(scan.measured, space.used);
  Object.assign(store, { state: { ...store.get(), drive: 0, drives: [drive], scan, layout } });
  const display = () => frame(store, 90, 26).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(display(), /SHULKER/);
  assert.match(display(), /STORAGE +│ +Apps/);
  store.toggleProjects();
  assert.match(display(), /Cleanup candidates/);
  store.removeItem();
  store.removeItem();
  assert.equal(store.get().removing, null);
  assert.match(display(), /Press Y to confirm removal/);
  const confirmation = new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      if (store.get().removing || !store.get().note) return;
      unsubscribe();
      resolve();
    });
  });
  store.confirmAction();
  await confirmation;
  assert.match(store.get().note, /Demo: would move/);
});
