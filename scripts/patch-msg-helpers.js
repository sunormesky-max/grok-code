const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'renderer', 'app.js');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('function scrollMessages(force = false) {');
const end = s.indexOf('function summarizeArgs(name, args = {}) {');
if (start < 0 || end < 0) {
  console.error('markers not found', start, end);
  process.exit(1);
}

const insert = `function scrollMessages(force = false, task) {
  const box = task?.pane || messagesEl();
  if (!box) return;
  if (force || messagesNearBottom(box)) box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, { markdown = true } = {}, task) {
  task = task || T();
  const box = task?.pane || messagesEl();
  if (!box) return null;
  const div = document.createElement('div');
  const roleLabel = role === 'user' ? 'You' : role === 'tool' ? 'Tool' : 'Grok';
  div.className = \`msg \${role}\`;
  if (task?.turnId && role === 'assistant') div.dataset.turn = task.turnId;
  div.innerHTML = \`<div class="role">\${roleLabel}</div><div class="body\${markdown && role === 'assistant' ? ' md' : ''}"></div>\`;
  const body = div.querySelector('.body');
  if (markdown && role === 'assistant') body.innerHTML = renderMarkdown(content);
  else body.textContent = content;
  box.appendChild(div);
  scrollMessages(true, task);
  return div;
}

function ensureLiveAssistant(task) {
  task = task || T();
  if (!task) return null;
  if (task.liveAssistantEl?.isConnected) return task.liveAssistantEl;
  const box = task.pane;
  let el =
    (task.turnId && box.querySelector(\`.msg.assistant[data-turn="\${task.turnId}"]\`)) ||
    box.querySelector('.msg.assistant[data-live="1"]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg assistant';
    el.dataset.live = '1';
    if (task.turnId) el.dataset.turn = task.turnId;
    el.innerHTML = \`<div class="role">Grok</div><div class="body stream-body"></div>\`;
    box.appendChild(el);
  }
  task.liveAssistantEl = el;
  return el;
}

function upsertAssistant(text, streaming, task) {
  task = task || T();
  if (!task) return null;
  const el = ensureLiveAssistant(task);
  const body = el.querySelector('.body');
  if (streaming) {
    el.dataset.live = '1';
    body.classList.remove('md');
    body.classList.add('stream-body');
    body.textContent = text || '';
  } else {
    body.classList.add('md');
    body.classList.remove('stream-body');
    body.innerHTML = renderMarkdown(text || '');
    delete el.dataset.live;
  }
  scrollMessages(false, task);
  return el;
}

function finalizeLiveMessages(task) {
  task = task || T();
  if (!task) return;
  const el =
    task.liveAssistantEl ||
    (task.turnId && task.pane.querySelector(\`.msg.assistant[data-turn="\${task.turnId}"]\`)) ||
    task.pane.querySelector('.msg.assistant[data-live="1"]');
  if (el) {
    const body = el.querySelector('.body');
    const text = task.streamBuf || body.textContent || '';
    body.classList.add('md');
    body.classList.remove('stream-body');
    body.innerHTML = renderMarkdown(text);
    delete el.dataset.live;
  }
  const thought =
    task.liveThoughtEl ||
    task.pane.querySelector('.msg.thought[data-live="1"]') ||
    (task.turnId && task.pane.querySelector(\`.msg.thought[data-turn="\${task.turnId}"]\`));
  if (thought) {
    delete thought.dataset.live;
    thought.classList.add('collapsed');
    const summary = thought.querySelector('.thought-summary');
    if (summary) {
      const n = (task.thoughtBuf || '').length;
      summary.textContent = n ? \`Thinking · \${n} 字 · 点击展开\` : 'Thinking';
    }
  }
}

function upsertThought(text, streaming, task) {
  task = task || T();
  if (!task) return;
  const box = task.pane;
  let el = task.liveThoughtEl;
  if (!el?.isConnected) {
    el =
      (task.turnId && box.querySelector(\`.msg.thought[data-turn="\${task.turnId}"]\`)) ||
      box.querySelector('.msg.thought[data-live="1"]');
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg thought collapsed';
    el.dataset.live = '1';
    if (task.turnId) el.dataset.turn = task.turnId;
    el.innerHTML = \`
      <button type="button" class="thought-summary">Thinking…</button>
      <div class="thought-body"></div>\`;
    el.querySelector('.thought-summary').onclick = () => {
      el.classList.toggle('collapsed');
    };
    const asst = task.liveAssistantEl;
    if (asst?.parentNode === box) box.insertBefore(el, asst);
    else box.appendChild(el);
  }
  task.liveThoughtEl = el;
  if (streaming) el.dataset.live = '1';
  const body = el.querySelector('.thought-body');
  const summary = el.querySelector('.thought-summary');
  body.textContent = text || '';
  if (streaming) {
    summary.textContent = 'Thinking…';
    el.classList.add('collapsed');
  } else {
    summary.textContent = \`Thinking · \${(text || '').length} 字 · 点击展开\`;
    el.classList.add('collapsed');
  }
  scrollMessages(false, task);
}

function appendToolStart(d, task) {
  task = task || T();
  if (!task) return;
  const box = task.pane;
  const div = document.createElement('div');
  div.className = 'msg tool running';
  div.dataset.toolId = d.id;
  if (task.turnId) div.dataset.turn = task.turnId;
  div.innerHTML = \`
    <div class="role">Tool</div>
    <div class="body">
      <div class="name">⚙ \${esc(d.name)}</div>
      <div class="args">\${esc(JSON.stringify(summarizeArgs(d.name, d.args), null, 0))}</div>
      <div class="result">running…</div>
    </div>\`;
  const asst = task.liveAssistantEl;
  if (asst?.parentNode === box) box.insertBefore(div, asst);
  else box.appendChild(div);
  scrollMessages(false, task);
}

function appendToolEnd(d, task) {
  task = task || T();
  const scope = task?.pane || document;
  let div = scope.querySelector?.(\`.msg.tool[data-tool-id="\${cssEscape(d.id)}"]\`);
  if (!div && task) {
    appendToolStart(d, task);
    div = task.pane.querySelector(\`.msg.tool[data-tool-id="\${cssEscape(d.id)}"]\`);
  }
  div?.classList.remove('running');
  const el = div?.querySelector('.result');
  if (el) {
    const full = String(d.result || '');
    const preview = full.slice(0, 500);
    el.textContent = preview + (full.length > 500 ? '…（点击展开）' : '');
    el.title = '点击展开/收起';
    el.onclick = () => {
      el.classList.toggle('expanded');
      if (el.classList.contains('expanded')) el.textContent = full || '（空）';
      else el.textContent = preview + (full.length > 500 ? '…（点击展开）' : '');
    };
  }
}

`;

s = s.slice(0, start) + insert + s.slice(end);
fs.writeFileSync(p, s);
console.log('ok patched helpers');
