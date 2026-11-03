import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const targets = [
  ...[...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]),
  ...[...readme.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]),
];
const missing = [...new Set(targets)]
  .filter(target => !/^(?:https?:|mailto:|#|data:)/i.test(target))
  .map(target => target.replace(/[?#].*$/, ''))
  .filter(target => target && !existsSync(resolve(root, target)));

if (missing.length) {
  console.error(`README has missing local links:\n${missing.map(target => `  - ${target}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('README local links and images exist.');
}
