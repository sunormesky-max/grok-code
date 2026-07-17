/**
 * Fail CI/local if electron/*.js require() a relative module that is missing
 * or not tracked by git (the v1.10.6 agent-stream packaging bug).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'electron');

function listJs(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

function relativeRequires(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const out = [];
  const re = /require\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function resolveRel(fromFile, rel) {
  let target = path.normalize(path.join(path.dirname(fromFile), rel));
  if (!target.endsWith('.js') && fs.existsSync(target + '.js')) target += '.js';
  return target;
}

function isGitTracked(absFile) {
  try {
    const rel = path.relative(root, absFile).replace(/\\/g, '/');
    execSync(`git ls-files --error-unmatch -- "${rel}"`, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

let failed = 0;
const files = listJs(electronDir);
for (const file of files) {
  for (const rel of relativeRequires(file)) {
    const target = resolveRel(file, rel);
    const from = path.relative(root, file).replace(/\\/g, '/');
    const to = path.relative(root, target).replace(/\\/g, '/');
    if (!fs.existsSync(target)) {
      console.error(`MISS file  ${from} → ${rel} (resolved ${to})`);
      failed += 1;
      continue;
    }
    if (!isGitTracked(target)) {
      console.error(`UNTRACKED ${from} → ${to}  (will be missing from release asar)`);
      failed += 1;
    }
  }
}

// renderer scripts referenced by index.html must exist + be tracked
const indexPath = path.join(root, 'renderer', 'index.html');
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const re = /src=["']([^"']+\.js)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const rel = m[1].replace(/^\.\//, '');
    const abs = path.join(root, 'renderer', rel);
    const to = path.relative(root, abs).replace(/\\/g, '/');
    if (!fs.existsSync(abs)) {
      console.error(`MISS script index.html → ${to}`);
      failed += 1;
    } else if (!isGitTracked(abs)) {
      console.error(`UNTRACKED script index.html → ${to}`);
      failed += 1;
    }
  }
}

if (failed) {
  console.error(`\ncheck-pack-requires: ${failed} problem(s)`);
  process.exit(1);
}
console.log('check-pack-requires: ok');
