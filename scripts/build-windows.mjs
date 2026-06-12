import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const wailsExe = process.env.WAILS_BIN || "wails";
const releaseDir = join(root, "release", "windows");
const payloadDir = join(root, "build", "bootstrap", "payloads");
const launcherOutput = "codex-switcher.exe";

const payloadTargets = [
  {
    name: "amd64",
    platform: "windows/amd64",
    output: "codex-switcher-windows-amd64.exe",
  },
  {
    name: "arm64",
    platform: "windows/arm64",
    output: "codex-switcher-windows-arm64.exe",
  },
];

function runWailsBuild(platform, output) {
  const args = ["build", "-clean", "-platform", platform, "-o", output];
  if (platform === "windows/386") {
    args.push("-tags", "launcher");
  }

  const result = spawnSync(wailsExe, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

mkdirSync(releaseDir, { recursive: true });
mkdirSync(payloadDir, { recursive: true });

for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".exe")) {
    rmSync(join(releaseDir, entry.name), { force: true });
  }
}

for (const target of payloadTargets) {
  console.log(`\nBuilding payload ${target.name} (${target.platform})...`);
  runWailsBuild(target.platform, target.output);
  const builtPath = join(root, "build", "bin", target.output);
  const payloadPath = join(payloadDir, target.output);
  if (existsSync(payloadPath)) {
    rmSync(payloadPath, { force: true });
  }
  copyFileSync(builtPath, payloadPath);
  console.log(`Staged payload at ${payloadPath}`);
}

console.log(`\nBuilding launcher (windows/386)...`);
runWailsBuild("windows/386", launcherOutput);

const launcherBuiltPath = join(root, "build", "bin", launcherOutput);
const releasePath = join(releaseDir, launcherOutput);
if (existsSync(releasePath)) {
  rmSync(releasePath, { force: true });
}
renameSync(launcherBuiltPath, releasePath);
console.log(`Saved launcher to ${releasePath}`);

for (const target of payloadTargets) {
  const payloadPath = join(payloadDir, target.output);
  if (existsSync(payloadPath)) {
    rmSync(payloadPath, { force: true });
  }
}
try {
  rmSync(join(root, "build", "bootstrap"), { recursive: true, force: true });
} catch {
  // Ignore cleanup failures.
}

console.log("\nSingle-file Windows build complete.");
