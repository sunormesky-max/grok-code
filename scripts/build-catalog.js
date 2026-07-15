#!/usr/bin/env node
/**
 * Generate in-app catalog from examples/mcp and examples/skills
 * → renderer/catalog-data.json
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'renderer', 'catalog-data.json');
const docsCopy = path.join(root, 'docs', 'catalog', 'catalog-data.json');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function walkSkills(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walkSkills(p, base));
    else if (name === 'SKILL.md') {
      const raw = fs.readFileSync(p, 'utf8');
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let meta = { name: path.basename(path.dirname(p)) };
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const m = line.match(/^(\w+):\s*(.+)$/);
          if (m) meta[m[1]] = m[2].trim();
        }
      }
      out.push({
        kind: 'skill',
        id: meta.name || path.basename(path.dirname(p)),
        name: meta.name || path.basename(path.dirname(p)),
        description: meta.description || '',
        path: path.relative(root, p).replace(/\\/g, '/'),
        bodyPreview: raw.replace(/^---[\s\S]*?---\r?\n/, '').slice(0, 400),
      });
    }
  }
  return out;
}

const mcpDir = path.join(root, 'examples', 'mcp');
const mcp = [];
if (fs.existsSync(mcpDir)) {
  for (const name of fs.readdirSync(mcpDir)) {
    if (!name.endsWith('.json')) continue;
    const data = readJson(path.join(mcpDir, name));
    if (!data) continue;
    mcp.push({
      kind: 'mcp',
      id: data.name || name.replace(/\.json$/, ''),
      name: data.name || name,
      description: data.note || data.description || '',
      transport: data.transport || 'stdio',
      command: data.command || '',
      url: data.url || '',
      path: `examples/mcp/${name}`,
      template: data,
    });
  }
}

const skills = walkSkills(path.join(root, 'examples', 'skills'));

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  mcp,
  skills,
  plugins: [
    {
      kind: 'plugin-source',
      id: 'xai-official',
      name: 'xAI Official Marketplace',
      description: '官方插件市场源（需 grok plugin marketplace add）',
      source: 'https://github.com/xai-org/plugin-marketplace.git',
    },
  ],
};

const json = JSON.stringify(catalog, null, 2);
fs.writeFileSync(outFile, json, 'utf8');
try {
  fs.mkdirSync(path.dirname(docsCopy), { recursive: true });
  fs.writeFileSync(docsCopy, json, 'utf8');
} catch (e) {
  console.warn('warn catalog docs copy', e.message);
}
console.log(
  `ok  catalog → ${path.relative(root, outFile)} (+ docs/catalog) (${mcp.length} mcp, ${skills.length} skills)`
);
