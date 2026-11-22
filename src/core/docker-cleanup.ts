import { execFile, spawn } from "node:child_process";

function readDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function runDocker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker exited with ${signal ?? `status ${code}`}.`));
    });
  });
}

export function localDockerEndpoint(host: string): boolean {
  return /^unix:\/\/\/[^\r\n]+$/.test(host) || /^npipe:\/\/\/\/\.\/pipe\/[^\/\\\r\n]+$/i.test(host);
}

/** Use Docker's own disk usage report, confirmation and reclaimed-space output. */
export async function runDockerCleanup(mode: "usage" | "prune"): Promise<void> {
  if (mode === "usage") {
    await runDocker(["system", "df"]);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Docker cleanup needs an interactive terminal for Docker's confirmation prompt.");
  }
  if (process.env.DOCKER_HOST) {
    throw new Error("Docker cleanup requires a local Docker context. Clear DOCKER_HOST to use it.");
  }
  const context = await readDocker(["context", "show"]);
  if (!context || /[\u0000-\u001f\u007f]/.test(context)) {
    throw new Error("Could not identify the active Docker context.");
  }
  const host = await readDocker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "--", context]);
  if (!localDockerEndpoint(host)) {
    throw new Error("Docker cleanup requires a local Docker context.");
  }
  process.stdout.write(`Docker context: ${context}\n`);
  // Without --all or --force, Docker confirms and removes only dangling images.
  await runDocker([`--context=${context}`, "image", "prune"]);
}
