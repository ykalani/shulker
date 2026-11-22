const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const {
  canRecyclePath,
  deduplicateCleanup,
  isProtectedPath,
  windowsCache,
  windowsCacheRoots,
} = require("../dist/core/cleanup-policy.js");
const { localDockerEndpoint, runDockerCleanup } = require("../dist/core/docker-cleanup.js");

const local = "C:/Users/Alice/AppData/Local";
const roaming = "C:/Users/Alice/AppData/Roaming";
const profile = "C:/Users/Alice";
const env = { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: profile };

test("Windows candidates stay within the exact named cache boundaries", () => {
  const paths = windowsCacheRoots(env).map(({ path }) => path.replaceAll("\\", "/"));
  assert.deepEqual(paths, [
    local + "/npm-cache",
    local + "/pip/cache",
    local + "/go-build",
    roaming + "/Code/Cache",
    roaming + "/Code/CachedData",
  ]);
  assert.equal(windowsCache(local + "/pip/CACHE/some-file", env)?.label, "pip cache");
  assert.equal(windowsCache(roaming + "/Code/CacheBackup", env), undefined);
  assert.equal(windowsCache(local + "/npm-cache/store.vhdx", env), undefined);
  assert.deepEqual(windowsCacheRoots({ LOCALAPPDATA: "C:/Windows" }), []);
  assert.deepEqual(windowsCacheRoots({}), []);
});

test("Windows protects managed and virtual disk data, with narrow cache exceptions", () => {
  const cache = local + "/npm-cache";
  assert.equal(isProtectedPath(cache, "win32", env), true);
  assert.equal(canRecyclePath(cache, false, "win32", env), false);
  assert.equal(canRecyclePath(cache, true, "win32", env), true);
  assert.equal(canRecyclePath(profile + "/projects/node_modules", false, "win32", env), true);
  for (const path of [
    profile,
    "C:/Users",
    "C:/",
    "C:/Windows/System32",
    "D:/Windows.old/Users",
    "C:/Program Files/Git/etc",
    "C:/ProgramData/Example",
    "C:/System Volume Information",
    "C:/$Recycle.Bin",
    "//host/share/cache",
    profile + "/.ssh",
    profile + "/.git/objects",
    local + "/Docker/wsl/data/ext4.vhdx",
    local + "/npm-cache/file.vhdx",
    local + "/npm-cache/../Docker",
    local + "/npm-cache.:stream",
    roaming + "/Code/User",
  ]) {
    assert.equal(canRecyclePath(path, true, "win32", env), false, path);
  }
  assert.equal(canRecyclePath("/home/alice/ext4.vhdx", false, "linux", {}), false);
});

test("cleanup totals retain disjoint entries and discard aliases and descendants", () => {
  const parent = { path: "C:/work/app/node_modules", size: 90 };
  const sibling = { path: "C:/work/app/node_modules-backup", size: 30 };
  const otherDrive = { path: "D:/work/app/node_modules", size: 10 };
  const items = [
    { path: parent.path + "/dep", size: 50 },
    parent,
    { path: "c:\\WORK\\app\\NODE_MODULES\\", size: 90 },
    sibling,
    otherDrive,
  ];
  assert.deepEqual(deduplicateCleanup(items, "win32"), [parent, sibling, otherDrive]);
  const first = { path: "/build", size: 20 };
  const second = { path: "/BUILD", size: 10 };
  assert.deepEqual(deduplicateCleanup([first, second], "linux"), [first, second]);
});

test("Docker prune only accepts local socket context endpoints", () => {
  assert.equal(localDockerEndpoint("unix:///var/run/docker.sock"), true);
  assert.equal(localDockerEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine"), true);
  for (const host of ["tcp://localhost:2376", "ssh://host", "npipe:////other/pipe/docker", ""]) {
    assert.equal(localDockerEndpoint(host), false, host);
  }
});

test("Docker usage invokes its read-only command without a shell", async (t) => {
  const spawn = t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  await runDockerCleanup("usage");
  assert.deepEqual(spawn.mock.calls.map(({ arguments: args }) => args), [
    ["docker", ["system", "df"], { stdio: "inherit" }],
  ]);
});
