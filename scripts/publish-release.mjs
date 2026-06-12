import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const changelogPath = path.join(root, "CHANGELOG.md");
const artifactPath = path.join(root, "release", "windows", "codex-switcher.exe");

const readFile = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const run = (command, args, options = {}) => {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
};

const capture = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
  }).trim();

const parseVersion = (contents) =>
  contents.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/)?.[1] ?? null;

const currentVersion = parseVersion(readFile("package.json"));
if (!currentVersion) {
  console.error("Could not determine version from package.json");
  process.exit(1);
}

const tagName = `v${currentVersion}`;
const title = `Codex Switcher ${tagName}`;

const assertCleanTree = () => {
  const status = capture("git", ["status", "--short"]);
  if (status) {
    console.error("Git working tree must be clean before publishing a release.");
    console.error(status);
    process.exit(1);
  }
};

const ensureFileExists = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} is missing: ${filePath}`);
    process.exit(1);
  }
};

const extractChangelogSection = (version) => {
  const lines = readFile("CHANGELOG.md").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## [")) {
      end = index;
      break;
    }
  }

  return lines.slice(start + 1, end).join("\n").trim();
};

const createNotes = () => {
  const changelogSection = extractChangelogSection(currentVersion);
  const notes = [
    title,
    "",
    "This release was built locally and published from the workstation, not from GitHub Actions.",
    "",
    "Download",
    "",
    "- `codex-switcher.exe`: single-file Windows launcher that auto-detects the installed architecture and starts the matching payload.",
    "",
    "What to expect",
    "",
    "- Modern Windows desktop GUI for managing multiple Codex accounts",
    "- Native window, tray, and browser/LAN access",
    "- Clean local release artifact for direct download",
  ];

  if (changelogSection) {
    notes.push("", "Changelog", "", changelogSection);
  }

  notes.push("", "Install", "", "1. Download `codex-switcher.exe`.", "2. Run it on Windows.", "3. Add your accounts from the GUI.");

  return notes.join("\n");
};

const notesFile = path.join(os.tmpdir(), `codex-switcher-release-${currentVersion}.md`);

assertCleanTree();
run("bun", ["run", "build:windows"]);
ensureFileExists(artifactPath, "Release artifact");

const notes = createNotes();
fs.writeFileSync(notesFile, notes, "utf8");

const tagExists = (() => {
  try {
    capture("git", ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`]);
    return true;
  } catch {
    return false;
  }
})();

if (!tagExists) {
  run("git", ["tag", "-a", tagName, "-m", tagName]);
}

run("git", ["push", "origin", tagName]);

const releaseExists = (() => {
  try {
    capture("gh", ["release", "view", tagName]);
    return true;
  } catch {
    return false;
  }
})();

if (releaseExists) {
  run("gh", ["release", "edit", tagName, "--title", title, "--notes-file", notesFile, "--latest"]);
  run("gh", ["release", "upload", tagName, artifactPath, "--clobber"]);
  console.log(`Updated GitHub release ${tagName}.`);
} else {
  run("gh", [
    "release",
    "create",
    tagName,
    artifactPath,
    "--title",
    title,
    "--notes-file",
    notesFile,
    "--latest",
  ]);
  console.log(`Created GitHub release ${tagName}.`);
}

