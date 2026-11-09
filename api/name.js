import { createClient } from '@supabase/supabase-js';
import { modelConfigMap, resolveModel, getApiKey, callModelStream } from './_models.js';

/**
 * Vercel Node Function: POST /api/name
 * 1. 按前端选择的模型调用对应服务商（doubao / deepseek / qwen / kimi）的流式接口生成 3 组名字
 * 2. 边生成边以 SSE 推给前端
 * 3. 生成结束后把「起名需求 / 名字方案 / 使用的模型」写入 Supabase
 *
 * 模型配置统一在 api/_models.js 的 modelConfigMap 里，一套共用调用代码。
 *
 * 需要的环境变量（本地写 .env，线上写 Vercel → Settings → Environment Variables）：
 *   DOUBAO_API_KEY             火山方舟 API Key（兼容旧名 ARK_API_KEY）
 *   DEEPSEEK_API_KEY           DeepSeek API Key
 *   DASHSCOPE_API_KEY          阿里云 DashScope（通义千问）API Key（兼容旧名 QWEN_API_KEY）
 *   KIMI_API_KEY               月之暗面 Kimi API Key（兼容 MOONSHOT_API_KEY）
 *   DOUBAO_MODEL / DEEPSEEK_MODEL / QWEN_MODEL / KIMI_MODEL   选填，覆盖默认模型 ID
 *   SUPABASE_URL               必填
 *   SUPABASE_ANON_KEY          必填（或 SUPABASE_SERVICE_ROLE_KEY）
 *   SUPABASE_TABLE             选填，默认 naming_records
 */

export const config = {
  maxDuration: 60,
};

const TABLE = process.env.SUPABASE_TABLE || 'naming_records';
const MAX_REQUIREMENT = 800;

const SYSTEM_PROMPT = `你是一位资深的中文命名顾问，精通字义训诂、古典诗词典故与现代品牌语感。

任务：根据用户给出的起名需求，给出恰好 3 组候选名字。

输出格式必须严格遵守，除下面这种结构外不要输出任何开场白、前言、总结、编号列表或代码块围栏：

### 名字
寓意：……（2~4 句，说明字面含义、气质联想、适用场景，并点出关键字各自的字义）
来源：……（若有诗词、典故、成语或文化出处请注明；若无则写「无特定出处，取字义组合」）

接着用完全相同的格式输出第 2 组和第 3 组。

硬性要求：
1. 恰好 3 组，风格之间要有明显区分度，便于用户挑选；
2. 同一批里不要重复用字、不要同音；
3. 真实可用，避免生僻字、拗口组合与不雅谐音；
4. 每组的「寓意」都要具体贴合用户需求，不要套话。`;

/* ----------------------------- 工具函数 ----------------------------- */

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return JSON.parse(req.body || '{}');
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw || '{}');
}

function stripMarks(text) {
  return text.replace(/[*`]/g, '').trim();
}

/** 从模型输出的文本里解析出结构化名字方案 */
function parseNames(raw) {
  const blocks = raw.split(/\n\s*(?=#{2,4}\s)/);
  const names = [];

  for (const block of blocks) {
    const match = block.match(/^#{2,4}\s*(.+?)\s*(?:\n([\s\S]*))?$/);
    if (!match) continue;

    const name = stripMarks(match[1])
      .replace(/^第?\s*\d+\s*[组.、):：-]?\s*/, '')
      .replace(/^[「『"']|[」』"']$/g, '')
      .trim();
    const body = (match[2] || '').trim();

    const lines = body
      .split('\n')
      .map((l) => stripMarks(l.replace(/^[-*\s]+/, '')))
      .filter(Boolean);

    const pick = (keys) => {
      const hit = lines.find((l) => keys.some((k) => new RegExp(`^${k}\\s*[:：]`).test(l)));
      if (!hit) return '';
      return hit.replace(new RegExp(`^(${keys.join('|')})\\s*[:：]\\s*`), '').trim();
    };

    if (!name) continue;

    names.push({
      name,
      meaning: pick(['寓意', '含义', '释义']) || lines.join(' '),
      source: pick(['来源', '出处', '典故']),
    });
  }

  return names;
}

function getSupabase() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!rawUrl || !key) return null;
  // 兼容用户在控制台复制时带了结尾的 /
  const url = rawUrl.trim().replace(/\/+$/, '');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function saveRecord(record) {
  const supabase = getSupabase();
  if (!supabase) {
    return { saved: false, reason: '未配置 SUPABASE_URL / SUPABASE_ANON_KEY' };
  }
  try {
    // 优先带 returning 拿回记录 id；若表上没有 SELECT 策略，RLS 会拦住这次回读，
    // 此时退化为纯插入（不读回），保证「记录能落库」这个主目标不受影响。
    const first = await supabase.from(TABLE).insert(record).select('id, created_at').single();
    if (!first.error) {
      return { saved: true, id: first.data?.id, createdAt: first.data?.created_at };
    }

    const fallback = await supabase.from(TABLE).insert(record);
    if (!fallback.error) {
      return { saved: true, id: null, createdAt: null, note: '已写入，但表缺少 SELECT 策略，未能读回记录 id' };
    }
    return { saved: false, reason: fallback.error.message || first.error.message };
  } catch (err) {
    return { saved: false, reason: err?.message || '写入 Supabase 失败' };
  }
}

/* ----------------------------- 主处理函数 ----------------------------- */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: '仅支持 POST 请求' });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }

  const requirement = String(payload.requirement ?? '').trim();
  if (requirement.length < 2) {
    return res.status(400).json({ error: '请填写起名需求（至少 2 个字）' });
  }
  if (requirement.length > MAX_REQUIREMENT) {
    return res.status(400).json({ error: `起名需求请控制在 ${MAX_REQUIREMENT} 字以内` });
  }

  // 前端传来的模型 id → modelConfigMap 中的配置
  const requestedId = String(payload.model || '').trim();
  if (requestedId && !modelConfigMap[requestedId]) {
    return res.status(400).json({
      error: `未知模型「${requestedId}」，可选：${Object.keys(modelConfigMap).join(' / ')}`,
    });
  }
  const { id: modelId, cfg } = resolveModel(requestedId);

  const apiKey = getApiKey(cfg);
  if (!apiKey) {
    return res.status(400).json({
      error: `模型「${cfg.label}」未配置密钥：请在 .env 里填写 ${cfg.keyEnv} 后重试`,
    });
  }

  const nameType = String(payload.nameType || '人名').slice(0, 20);
  const style = String(payload.style || '').slice(0, 40);
  const extra = String(payload.extra || '').slice(0, 200);

  const userPrompt = [
    `起名类型：${nameType}`,
    style ? `偏好风格：${style}` : '',
    extra ? `补充要求：${extra}` : '',
    `起名需求：${requirement}`,
    '请严格按约定格式输出 3 组候选名字。',
  ]
    .filter(Boolean)
    .join('\n');

  // 建立 SSE 通道
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const send = (data) => {
    if (clientClosed) return false;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      clientClosed = true;
      return false;
    }
  };

  // 先把「用的是哪个模型」告诉前端，便于页面标注
  send({ type: 'meta', modelId, modelLabel: cfg.label, model: cfg.model });

  const controller = new AbortController();
  // 各家首字速度差异大，超时在 modelConfigMap 里按模型配（kimi 单独放宽）
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs || 55000);

  try {
    const fullText = await callModelStream(cfg, apiKey, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      signal: controller.signal,
      onDelta: (text) => send({ type: 'delta', text }),
    });

    if (!fullText.trim()) {
      send({ type: 'error', message: '模型未返回内容，请稍后重试' });
      return res.end();
    }

    const names = parseNames(fullText);

    const saved = await saveRecord({
      requirement,
      name_type: nameType,
      style: style || null,
      extra: extra || null,
      // 存「服务商标识:模型 ID」，历史记录里能看出是哪个模型生成的
      model: `${modelId}:${cfg.model}`,
      names,
      raw_output: fullText,
    });

    send({
      type: 'done',
      names,
      modelId,
      modelLabel: cfg.label,
      model: cfg.model,
      raw: fullText,
      saved: saved.saved,
      recordId: saved.id ?? null,
      reason: saved.saved ? undefined : saved.reason,
    });

    return res.end();
  } catch (err) {
    const message =
      err?.name === 'AbortError'
        ? '生成超时，请缩短需求后重试'
        : err?.message || '服务端异常';
    send({ type: 'error', message: `生成失败：${message}` });
    return res.end();
  } finally {
    clearTimeout(timeout);
  }
}
