import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(root, "skills/miwarang/SKILL.md");
const readmePath = resolve(root, "README.md");
const licensePath = resolve(root, "LICENSE");
const packagePath = resolve(root, "package.json");
const displayConfigPath = resolve(root, "skills.sh.json");

function read(path) {
  return readFileSync(path, "utf8");
}

function fail(message) {
  throw new Error(message);
}

const skill = read(skillPath);
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
if (!frontmatter) fail("SKILL.md is missing YAML frontmatter");

const name = frontmatter[1].match(/^name:\s*([^\s]+)\s*$/m)?.[1];
const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1];
const version = frontmatter[1].match(/^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];

if (name !== "miwarang") fail("skill name must match its directory");
if (!description?.includes("Use when")) fail("description must contain concrete triggers");
if (version !== "1.2.0") fail(`expected skill metadata version 1.2.0, got ${version}`);
if (skill.split("\n").length > 500) fail("SKILL.md must stay under 500 lines");
if (!read(readmePath).includes("npx skills add itokun99/miwarang --skill miwarang")) {
  fail("README must document installing the skill from the canonical repo");
}
if (!read(licensePath).includes("MIT License")) fail("MIT LICENSE is required");

const references = [...skill.matchAll(/\]\(references\/([^)]+\.md)\)/g)].map((match) => match[1]);
if (references.length === 0) fail("SKILL.md must link to its reference files");
for (const reference of references) {
  read(resolve(root, "skills/miwarang/references", reference));
}

for (const token of ["miwarang_delegate", "miwarang_wait", "miwarang_cancel", "fallback"]) {
  if (!skill.includes(token)) fail(`SKILL.md is missing ${token}`);
}

const displayConfig = JSON.parse(read(displayConfigPath));
if (!Array.isArray(displayConfig.groupings) || displayConfig.groupings.length === 0) {
  fail("skills.sh.json must define at least one grouping");
}
if (!displayConfig.groupings.some((group) => group.skills.includes(name))) {
  fail("skills.sh.json must list the skill slug");
}

const packageManifest = JSON.parse(read(packagePath));
if (packageManifest.private === true) fail("npm package must be publishable");
if (!packageManifest.files?.includes("skills")) {
  fail("npm package files must include the skills directory");
}

console.log("skill check: ok");
