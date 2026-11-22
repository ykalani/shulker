#!/usr/bin/env node
"use strict";

const args = process.argv.slice(2);

const HELP = `Shulker explores disk usage and finds cleanup candidates.

Usage: shulker [options]

  (no options)   Open the interactive terminal dashboard.
  --dry-run      Interactive view, but clearing only pretends: nothing is deleted.
  --demo         Interactive view on a made-up disk. Reads and deletes nothing.
  --plain        Print a text summary and exit. Deletes nothing.
  --json         Print the summary as JSON and exit. Deletes nothing.
  --drives       List mounted drives and detected partitions, and exit.
  --drive <d>    Start on drive <d>: its number from --drives, its name, mount
                 point, label or device, or any path on it.
  --path <dir>   Scan only this existing directory.
  --docker       Show Docker disk usage.
  --docker-prune Review and prune dangling Docker images using Docker's prompt.
  --version      Show the Shulker version.
  -h, --help     Show this help.
`;

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(require("../package.json").version + "\n");
  process.exit(0);
}

const known = new Set(["--dry-run", "--demo", "--plain", "--json", "--drives", "--docker", "--docker-prune"]);
let unknown;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--drive" || arg === "--path") {
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
      process.stderr.write(`shulker: ${arg} needs a value\n\n${HELP}`);
      process.exit(2);
    }
    i++;
  } else if (!known.has(arg) && !/^--(?:drive|path)=.+$/.test(arg)) {
    unknown = arg;
    break;
  }
}
if (unknown) {
  process.stderr.write(`shulker: unknown option ${unknown}\n\n${HELP}`);
  process.exit(2);
}

function fail(error) {
  process.stderr.write(`shulker: ${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
}

if (args.includes("--docker") || args.includes("--docker-prune")) {
  if (args.length !== 1) {
    fail("Use --docker or --docker-prune on its own.");
  } else {
    require("../dist/core/docker-cleanup.js")
      .runDockerCleanup(args[0] === "--docker" ? "usage" : "prune").catch(fail);
  }
} else if (args.includes("--plain") || args.includes("--json") || args.includes("--drives") ||
    !process.stdout.isTTY || !process.stdin.isTTY) {
  require("../dist/plain.js")
    .runPlain(args)
    .catch(fail);
} else {
  require("../dist/main.js");
}
