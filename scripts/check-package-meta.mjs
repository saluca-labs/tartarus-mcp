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

// npm is retired as a Saluca channel (2026-09-16): the @saluca/* and
// @salucallc/* packages were removed from the registry and this package is not
// published. Guard against any of that creeping back in.
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
for (const dep of Object.keys(allDeps)) {
  if (/^@saluca(llc)?\//.test(dep)) problems.push(`package.json depends on ${dep}, which is no longer on npm; use the vendored code`);
}
if (pkg.private !== true) {
  problems.push('package.json must be "private": true; tartarus-mcp is not published to npm');
}
if (pkg.publishConfig) {
  problems.push("package.json has publishConfig; tartarus-mcp is not published to npm");
}
const lock = existsSync("package-lock.json") ? readFileSync("package-lock.json", "utf8") : "";
if (/node_modules\/@saluca(llc)?\//.test(lock)) {
  problems.push("package-lock.json still resolves an @saluca/@salucallc package from npm");
}
const installDocs = [["README.md", readme]];
if (existsSync("src/index.ts")) installDocs.push(["src/index.ts", readFileSync("src/index.ts", "utf8")]);
for (const [name, text] of installDocs) {
  if (/npx\s+(-y\s+)?tartarus-mcp/.test(text) || /tartarus-mcp@\d/.test(text)) {
    problems.push(`${name} installs tartarus-mcp from the npm registry; it is not published there`);
  }
  if (/npm\s+(i|install)\s+(-g\s+|--global\s+)?(tartarus-mcp|@saluca)/.test(text)) {
    problems.push(`${name} tells users to npm install a Saluca package; build from source instead`);
  }
  if (/npmjs\.com\/package\/@saluca/.test(text)) {
    problems.push(`${name} links to a removed npm package`);
  }
}
if (existsSync(".github/workflows")) {
  for (const f of readdirSync(".github/workflows")) {
    if (/npm publish/.test(readFileSync(`.github/workflows/${f}`, "utf8"))) {
      problems.push(`.github/workflows/${f} runs npm publish; npm is retired`);
    }
  }
}
// Source-build install docs must pin one full commit SHA everywhere.
// CI separately checks that the pinned commit is an ancestor of HEAD.
const checkoutPins = [...readme.matchAll(/git checkout (\S+)/g)].map((m) => m[1]);
const githubPins = [...readme.matchAll(/github:saluca-labs\/tartarus-mcp(#[^"'\s]*)?/g)].map((m) => (m[1] ?? "").slice(1));
const pins = [...checkoutPins, ...githubPins];
if (checkoutPins.length === 0) problems.push("README has no `git checkout <sha>` pin in the source install");
for (const pin of pins) {
  if (!/^[0-9a-f]{40}$/.test(pin)) problems.push(`README pins ${JSON.stringify(pin)}; pin a full 40-character commit SHA`);
}
if (new Set(pins).size > 1) problems.push(`README pins more than one commit: ${[...new Set(pins)].join(", ")}`);
if (process.env.GITHUB_OUTPUT && pins.length) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT, `readme_pin=${pins[0]}\n`);
}
for (const f of ["src/vendor/asphodel/LICENSE", "src/vendor/asphodel/NOTICE"]) {
  if (!existsSync(f)) problems.push(`${f} is missing; the vendored Apache-2.0 code must keep its notices`);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log(`OK: ${pkg.name}@${pkg.version} license=${pkg.license} repository=${repoUrl}`);
