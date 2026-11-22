# Shulker

Shulker is a terminal dashboard for exploring disk usage and reviewing cleanup candidates on Windows, macOS, and Linux. It builds on [fix-storage](https://github.com/govijr/fix-storage), with a redesigned terminal UI and a Windows backend.

## Run it

On Windows, download the x64 or ARM64 ZIP from the [latest GitHub release](https://github.com/ykalani/shulker/releases/latest), extract it, and run `shulker.exe --demo` from a terminal. The Windows executable includes its runtime.

### Run from source

Install Git and Node.js 22 or later, then run these commands in a terminal:

```powershell
git clone https://github.com/ykalani/shulker.git
cd shulker
npm ci
npm run demo
```

To scan the checkout you are already in, run `npm start -- --path .`. To scan a volume, run `npm start`. Start with `npm start -- --path . --dry-run` to preview cleanup. All scans run locally.

| Action | Command |
| --- | --- |
| Scan a folder | `npm start -- --path .` |
| List volumes | `npm start -- --drives` |
| Generate a JSON report | `npm start -- --path . --json` |
| Inspect Docker disk usage | `npm start -- --docker` |
| Review and prune dangling Docker images | `npm start -- --docker-prune` |

Docker cleanup requires a local Docker context and uses Docker's interactive confirmation and its report of reclaimed space.

## Dashboard

- Use **Tab** to switch between storage categories and the item list. Use **↑ ↓** to move, **→** to open, and **←** to go back. **G** jumps to the largest contributor when a folder has a clear one.
- Press **P** to see cleanup candidates with their evidence and estimated sizes. Press **O** to reveal the selected item in the file manager.
- Press **D**, then **Y**, to confirm removal. Shulker moves verified project artifacts to the OS trash. Windows recycling requires a fixed NTFS volume and rejects junctions, protected paths, and virtual disks. The Recycle Bin holds the data until emptied.
- Windows folder sizes are logical bytes and can differ from disk allocation or reclaimable space. Overlapping candidates are counted once by path. The candidate search may reach its directory limit on large drives. Use a narrower `--path` to inspect a specific project.

### Custom cleanup rules

Create `~/.shulker.json` or point `SHULKER_CONFIG` at a configuration file. Rules use exact absolute paths or paths relative to your home using `~/`. Exclusions also protect containing folders from cleanup. Configured matches require review. Git ignore status is evidence for inspection only.

```json
{
  "exclude": ["~/projects/site/node_modules/local-data"],
  "rules": [
    { "path": "~/projects/site/generated-preview", "reason": "Recreated by the preview build" }
  ]
}
```

## Development and credits

Run `npm test` to compile and test the app. The repository preserves fix-storage's upstream history and MIT license. Project detection draws from Kondo and Disco. The Windows cache allowlist and protection policy draw from [cull](https://github.com/legostin/cull) and [cleaner](https://github.com/vyrti/cleaner). [sweeprs](https://github.com/salamaashoush/sweeprs) informed deduplication and tool-managed cleanup. [gdu](https://github.com/dundee/gdu) informed user exclusions and Git review context.

On Windows ARM64 with x64 emulation and PowerShell 7, run `npm ci` and then `./scripts/package-windows.ps1 -Staging .tmp/sea -Destination .tmp/release` to build and smoke-test both portable ZIPs.
