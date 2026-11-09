/**
 * 多模型统一配置 + 共用调用代码
 *
 * 四家服务商都提供 OpenAI 兼容的 /chat/completions 流式接口，
 * 因此只用一套 fetch + SSE 解析就能覆盖 doubao / deepseek / qwen / kimi。
 * 差异（endpoint、模型名、密钥变量名、额外参数）全部收敛在 modelConfigMap 里。
 *
 * 配置项说明：
 *   label      前端下拉框显示名
 *   vendor     服务商中文名
 *   endpoint   对话补全地址（OpenAI 兼容）
 *   model      实际模型 ID（可用环境变量覆盖）
 *   keyEnv     密钥所在的环境变量名（主用）
 *   keyAliases 兼容的旧变量名（如 ARK_API_KEY / MOONSHOT_API_KEY）
 *   extraBody  该服务商特有的请求参数（会合并进 body）
 */
export const modelConfigMap = {
  doubao: {
    label: '豆包 Doubao',
    vendor: '火山方舟',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: process.env.DOUBAO_MODEL || process.env.ARK_MODEL || 'doubao-seed-2-1-pro-260915',
    keyEnv: 'DOUBAO_API_KEY',
    keyAliases: ['ARK_API_KEY'],
    // 起名场景不需要深度思考过程，关掉可省 token 并加快首字
    extraBody: { thinking: { type: 'disabled' } },
  },
  deepseek: {
    label: 'DeepSeek',
    vendor: '深度求索',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
    keyAliases: [],
  },
  qwen: {
    label: '通义千问 Qwen',
    vendor: '阿里云 DashScope',
    // 新版「业务空间」密钥（sk-ws- 开头）必须走业务空间专属域名，
    // 用 DASHSCOPE_BASE_URL 配，形如 https://ws-xxxxxxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
    endpoint: `${(process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')}/chat/completions`,
    model: process.env.QWEN_MODEL || 'qwen-plus',
    keyEnv: 'DASHSCOPE_API_KEY',
    keyAliases: ['QWEN_API_KEY'],
  },
  kimi: {
    label: 'Kimi',
    vendor: '月之暗面',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    // 该密钥在 /v1/models 下可用的是 kimi-k3.1-pro、kimi-k3
    // k3 首字约 31s、整段约 34s；k3.1-pro 约 75s，会超过 Vercel 函数 60s 上限，故默认用 k3
    model: process.env.KIMI_MODEL || 'kimi-k3',
    keyEnv: 'KIMI_API_KEY',
    keyAliases: ['MOONSHOT_API_KEY'],
    // k3 系列只接受 temperature=1，别的值会报 400 invalid temperature
    extraBody: { temperature: 1 },
    // 这家首字很慢且波动大（实测 30~90s，偶尔更久），单独放宽超时
    timeoutMs: 180000,
  },
};

export const DEFAULT_MODEL_ID = 'doubao';

/** 取该模型实际生效的密钥（主变量优先，其次别名） */
export function getApiKey(cfg) {
  if (!cfg) return '';
  const names = [cfg.keyEnv, ...(cfg.keyAliases || [])];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

/** 供前端下拉框使用：模型清单 + 是否已配置密钥 */
export function listModels() {
  return Object.entries(modelConfigMap).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    vendor: cfg.vendor,
    model: cfg.model,
    keyEnv: cfg.keyEnv,
    configured: Boolean(getApiKey(cfg)),
  }));
}

/** 解析前端传来的模型 id，非法时回退到默认模型 */
export function resolveModel(rawId) {
  const id = String(rawId || '').trim();
  if (id && modelConfigMap[id]) return { id, cfg: modelConfigMap[id] };
  return { id: DEFAULT_MODEL_ID, cfg: modelConfigMap[DEFAULT_MODEL_ID] };
}

/**
 * 共用流式调用：四家都走 OpenAI 兼容协议
 * @param {object} cfg    modelConfigMap 中的一项
 * @param {string} apiKey 对应密钥
 * @param {object} opts   { messages, temperature, signal, onDelta }
 * @returns {Promise<string>} 模型输出的完整文本
 */
export async function callModelStream(cfg, apiKey, { messages, temperature = 0.8, signal, onDelta }) {
  const upstream = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature,
      ...(cfg.extraBody || {}),
    }),
    signal,
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    let hint = errText.slice(0, 300);
    let code = '';
    try {
      const parsed = JSON.parse(errText);
      const err = parsed?.error || parsed;
      hint = err?.message || err?.Message || hint;
      code = err?.code || err?.Code || '';
    } catch {
      /* 保持原文 */
    }

    // 把各家常见错误码翻译成可操作的提示。
    // 401/403/402 出现在这一步，说明请求已通过鉴权，所以「密钥」本身是有效的。
    const friendly = {
      'AccessDenied.Unpurchased': '密钥有效，但该业务空间未开通该模型（无可用额度），不充值无法调用',
      invalid_api_key: '密钥无效或已失效，请到控制台重新生成',
      InvalidApiKey: '密钥无效或已失效，请到控制台重新生成',
      InvalidParameter: '请求参数不被该模型接受',
    };
    const tip = friendly[code];
    const status = upstream.status;
    let extra = '';
    if (status === 402 || /insufficient balance/i.test(hint)) {
      extra = '（密钥有效，但账户余额为 0，充值后才能调用）';
    }

    throw new Error(
      `${cfg.vendor} 调用失败（${status}）：${tip || hint}${tip ? `｜原始信息：${hint}` : ''}${extra}`
    );
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // 兼容各家：正文在 delta.content；部分模型会额外给 reasoning_content（跳过）
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        fullText += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }

  return fullText;
}
