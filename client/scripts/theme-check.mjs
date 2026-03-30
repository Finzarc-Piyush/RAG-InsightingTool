import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(process.cwd(), 'src');
const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const ignorePathFragments = ['/src/components/ui/', '/src/lib/'];
const temporaryDebtFiles = new Set([
  'src/pages/Dashboard/Components/DashboardList.tsx',
  'src/pages/Home/Components/ChartRenderer.tsx',
  'src/pages/Home/Components/DataSummaryModal.tsx',
  'src/pages/Home/Components/DatasetEnrichmentLoader.tsx',
  'src/pages/Home/Home.tsx',
]);

const forbiddenPatterns = [
  { name: 'bg-white', regex: /\bbg-white(?:\/\d+)?\b/g },
  { name: 'text-gray-*', regex: /\btext-gray-\d{2,3}\b/g },
  { name: 'bg-gray-*', regex: /\bbg-gray-\d{2,3}(?:\/\d+)?\b/g },
  { name: 'border-gray-*', regex: /\bborder-gray-\d{2,3}(?:\/\d+)?\b/g },
  { name: 'hover:bg-gray-*', regex: /\bhover:bg-gray-\d{2,3}(?:\/\d+)?\b/g },
  { name: 'hardcoded hex color', regex: /#[0-9a-fA-F]{3,8}\b/g },
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (!allowedExtensions.has(path.extname(entry.name))) continue;
    const normalized = fullPath.replaceAll(path.sep, '/');
    if (ignorePathFragments.some((fragment) => normalized.includes(fragment))) continue;
    files.push(fullPath);
  }
  return files;
}

function getChangedSourceFiles() {
  try {
    const output = execSync('git diff --name-only --diff-filter=ACMRTUXB HEAD -- src', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((rel) => (rel.startsWith('client/') ? rel.slice('client/'.length) : rel))
      .map((rel) => path.resolve(process.cwd(), rel))
      .filter((abs) => allowedExtensions.has(path.extname(abs)));
  } catch {
    return [];
  }
}

function run() {
  const checkAll = process.argv.includes('--all');
  const files = checkAll ? walk(root) : getChangedSourceFiles();

  if (!checkAll && files.length === 0) {
    console.log('theme-check: no changed source files to inspect.');
    return;
  }
  const violations = [];

  for (const file of files) {
    const relativeFile = path.relative(process.cwd(), file).replaceAll(path.sep, '/');
    if (temporaryDebtFiles.has(relativeFile)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const rule of forbiddenPatterns) {
        if (rule.regex.test(line)) {
          violations.push({
            file: relativeFile,
            line: i + 1,
            rule: rule.name,
            content: line.trim(),
          });
        }
        rule.regex.lastIndex = 0;
      }
    }
  }

  if (violations.length === 0) {
    console.log('theme-check: no hardcoded light-only palette usage found.');
    return;
  }

  console.error('theme-check: found style tokens violations:\n');
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} [${v.rule}] ${v.content}`);
  }
  process.exitCode = 1;
}

run();
