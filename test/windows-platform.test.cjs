const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { cannotRemove, findCulprit, listFolder } = require("../dist/core/browse");
const { scopedLayout } = require("../dist/core/layout");
const { IS_WINDOWS } = require("../dist/core/platform");
const { startScan } = require("../dist/core/scan");

test("scoped Windows scan uses logical lengths and supports drilling down", { skip: !IS_WINDOWS }, async (t) => {
  const root = await fs.mkdtemp(path.join(__dirname, ".shulker-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const modules = path.join(project, "node_modules");
  await fs.mkdir(modules, { recursive: true });
  await fs.writeFile(path.join(modules, "payload"), Buffer.alloc(1200));
  await fs.writeFile(path.join(project, "package.json"), "{}");
  await fs.writeFile(path.join(root, "notes"), "a note");

  const mount = path.parse(root).root;
  const layout = await scopedLayout({
    drive: { mount },
    roots: [{ path: mount, category: "documents" }],
    lookOnly: null,
    foreign: () => false,
    skip: () => false,
    canonical: path.resolve,
  }, root);
  const scan = await startScan(layout, () => {}).done;
  assert.equal(scan.measured, 1208);
  assert.equal(scan.sizes.system, 0);
  assert.equal(scan.items.documents[0].size, 1202);
  const items = await new Promise((resolve) => {
    listFolder(project, (items, done) => { if (done) resolve(items); });
  });
  assert.equal(items[0].size, 1200);
  const culprit = await new Promise((resolve) => findCulprit(root, resolve));
  assert.equal(culprit.chain.at(-1).path, modules);
  assert.equal(cannotRemove(modules, layout, true), null);
  assert.notEqual(cannotRemove(modules, layout), null);
  assert.notEqual(cannotRemove(root, layout, true), null);
});
