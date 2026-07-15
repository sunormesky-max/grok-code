/**
 * 可选 LLM 增强 L1/L2 摘要
 * 默认启发式；contextMode === 'llm' 且有 API Key 时调用 xAI Chat Completions
 */
const https = require('https');

const DEFAULT_MODEL = 'grok-3-mini';
const TIMEOUT_MS = 25000;

function clip(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function postJson(url, headers, body, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.length > 2_000_000) buf = buf.slice(0, 2_000_000);
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`xAI API ${res.statusCode}: ${buf.slice(0, 400)}`));
            return;
          }
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error('Invalid JSON from xAI API'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LLM 摘要超时'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * 用 LLM 精炼 L1 / L2（保留启发式作为输入与回退）
 * @param {object} heuristicContext compressContext 结果
 * @param {{ apiKey?: string, model?: string, projectName?: string, taskTitle?: string }} opts
 */
async function enrichContextWithLlm(heuristicContext, opts = {}) {
  const apiKey = opts.apiKey || process.env.XAI_API_KEY;
  if (!apiKey) {
    return {
      ...heuristicContext,
      mode: 'heuristic',
      llm: { used: false, reason: 'no_api_key' },
    };
  }

  const c = heuristicContext || {};
  const l0preview = (Array.isArray(c.l0) ? c.l0 : [])
    .map((m) => `${m.role}: ${clip(m.content, 600)}`)
    .join('\n');

  const system = `你是 GrokCode 的上下文压缩器。根据对话材料输出严格 JSON（不要 markdown 围栏）：
{"l1":"近端摘要，bullet 列表字符串","l2":"会话脉络：目标/已做/进行中/关键文件/决策"}
要求：中文；信息密度高；不编造；保留文件路径；每段控制在 800 字内。`;

  const user = [
    `项目: ${opts.projectName || '?'} · 任务: ${opts.taskTitle || '?'}`,
    '',
    '## 启发式 L1',
    clip(c.l1, 2500),
    '',
    '## 启发式 L2',
    clip(c.l2, 2500),
    '',
    '## L0 近期原文摘录',
    clip(l0preview, 4000),
    '',
    '## L3 项目记忆（勿改写，仅作参考）',
    clip(c.l3, 1500),
  ].join('\n');

  const model = opts.model || DEFAULT_MODEL;
  try {
    const res = await postJson(
      'https://api.x.ai/v1/chat/completions',
      { Authorization: `Bearer ${apiKey}` },
      {
        model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }
    );

    const text = res?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(text);
    if (!parsed || (!parsed.l1 && !parsed.l2)) {
      return {
        ...c,
        mode: 'heuristic',
        llm: { used: false, reason: 'parse_failed', raw: clip(text, 200) },
      };
    }

    const l1 = clip(parsed.l1 || c.l1 || '', 4000);
    const l2 = clip(parsed.l2 || c.l2 || '', 3500);
    const tiers = (c.tiers || []).map((t) => {
      if (t.id === 'L1') return { ...t, chars: l1.length, desc: '近端摘要（LLM）' };
      if (t.id === 'L2') return { ...t, chars: l2.length, desc: '会话脉络（LLM）' };
      return t;
    });

    return {
      ...c,
      l1,
      l2,
      tiers,
      mode: 'llm',
      llm: { used: true, model },
      stats: {
        ...(c.stats || {}),
        l1Chars: l1.length,
        l2Chars: l2.length,
        llm: true,
      },
    };
  } catch (err) {
    return {
      ...c,
      mode: 'heuristic',
      llm: { used: false, reason: err.message || String(err) },
    };
  }
}

function extractJson(text) {
  const s = String(text || '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* try fence or substring */
  }
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

module.exports = { enrichContextWithLlm, DEFAULT_MODEL };
