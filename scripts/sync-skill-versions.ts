import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIELD = /^( *library_version:\s*")([^"]*)(")/m;

function* walkSkillFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(dir, entry.name);
    const skill = join(nested, "SKILL.md");
    if (existsSync(skill)) yield skill;
    yield* walkSkillFiles(nested);
  }
}

let touched = 0;
for (const pkg of readdirSync("packages", { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  const pkgDir = join("packages", pkg.name);
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const { version } = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof version !== "string") continue;
  const skillsDir = join(pkgDir, "skills");
  if (!existsSync(skillsDir)) continue;
  for (const file of walkSkillFiles(skillsDir)) {
    const before = readFileSync(file, "utf8");
    const after = before.replace(FIELD, `$1${version}$3`);
    if (after !== before) {
      writeFileSync(file, after);
      touched++;
    }
  }
  console.log(`sync-skill-versions: ${pkgDir} → ${version}`);
}
console.log(`sync-skill-versions: ${touched} skill(s) touched`);
