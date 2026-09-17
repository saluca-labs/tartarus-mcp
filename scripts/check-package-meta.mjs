// Guards the package metadata the 2026-09-16 audit found wrong.
// The repo LICENSE (FSL-1.1, Apache 2.0 future licence) is authoritative.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const EXPECTED_LICENSE = "FSL-1.1-ALv2";
const EXPECTED_REPO = process.argv[2];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const licenseText = readFileSync("LICENSE", "utf8");
const problems = [];

if (!licenseText.startsWith("# Functional Source License, Version 1.1, Apache 2.0 Future License")) {
  problems.push("LICENSE is no longer FSL-1.1-ALv2; update EXPECTED_LICENSE deliberately");
}
if (pkg.license !== EXPECTED_LICENSE) {
  problems.push(`package.json license is ${JSON.stringify(pkg.license)}, expected ${EXPECTED_LICENSE}`);
}
if (!pkg.files || !pkg.files.includes("LICENSE")) {
  problems.push("package.json files must include LICENSE");
}
const repoUrl = pkg.repository && pkg.repository.url;
if (!repoUrl || repoUrl !== `git+https://github.com/${EXPECTED_REPO}.git`) {
  problems.push(`package.json repository.url is ${JSON.stringify(repoUrl)}, expected git+https://github.com/${EXPECTED_REPO}.git`);
}
if (/has moved to \[saluca-labs\]/i.test(readme)) {
  problems.push("README still carries the self-referential 'moved to saluca-labs' banner");
}
if (/@latest\b/.test(readme)) {
  problems.push("README recommends a floating @latest version; pin one");
}
if (existsSync("src")) {
  for (const f of readdirSync("src", { recursive: true })) {
    if (!/\.[cm]?[jt]s$/.test(f)) continue;
    if (/@latest\b/.test(readFileSync(`src/${f}`, "utf8"))) {
      problems.push(`src/${f} writes a floating @latest version; pin the package version`);
    }
  }
}
if (/^Apache 2\.0/m.test(readme)) {
  problems.push("README licence section says Apache 2.0; the repo LICENSE is FSL-1.1-ALv2");
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log(`OK: ${pkg.name}@${pkg.version} license=${pkg.license} repository=${repoUrl}`);
