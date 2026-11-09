import { listModels, DEFAULT_MODEL_ID } from './_models.js';

/**
 * GET /api/models
 * 返回 modelConfigMap 里的模型清单（含是否已配置密钥），供前端下拉框动态生成。
 * 这样新增一家服务商只需改 _models.js，前端无需改动。
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: '仅支持 GET 请求' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    defaultModel: DEFAULT_MODEL_ID,
    models: listModels(),
  });
}
