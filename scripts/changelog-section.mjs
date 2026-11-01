// Prints the CHANGELOG.md section for one version (used for GitHub release notes).
// Usage: node ./scripts/changelog-section.mjs 0.2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2]?.replace(/^v/, '');

if (!version) {
  console.error('Usage: node ./scripts/changelog-section.mjs <version>');
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split(/\r?\n/);
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
const start = lines.findIndex((line) => heading.test(line));

if (start === -1) {
  console.error(`No "## [${version}]" section found in CHANGELOG.md`);
  process.exit(1);
}

let end = lines.length;
for (let index = start + 1; index < lines.length; index += 1) {
  if (/^## \[/.test(lines[index]) || /^\[[^\]]+\]:\s/.test(lines[index])) {
    end = index;
    break;
  }
}

process.stdout.write(`${lines.slice(start + 1, end).join('\n').trim()}\n`);
