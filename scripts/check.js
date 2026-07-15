#!/usr/bin/env node
/**
 * Lightweight CI checks — syntax of main process + renderer scripts
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];

function walk(dir, pred) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'release' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, pred);
    else if (pred(name, p)) files.push(p);
  }
}

walk(path.join(root, 'electron'), (n) => n.endsWith('.js'));
walk(path.join(root, 'renderer'), (n) => n.endsWith('.js'));
walk(path.join(root, 'scripts'), (n) => n.endsWith('.js') && n !== 'check.js');

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('ok ', path.relative(root, file));
  } catch (e) {
    failed += 1;
    console.error('FAIL', path.relative(root, file));
    console.error(e.stderr?.toString() || e.message);
  }
}

// required community files
const required = [
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'ROADMAP.md',
];
for (const f of required) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error('missing', f);
    failed += 1;
  } else {
    console.log('ok ', f);
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll checks passed (${files.length} scripts + community files)`);
