# AI 起名 · 多模型版

一个开箱即用的中文起名网页：输入需求，流式生成 3 组候选名字（含字义解析与出处），并自动归档到 Supabase。

支持四家模型一键切换：**豆包 Doubao、DeepSeek、通义千问 Qwen（DashScope）、Kimi**。

## 项目结构

```
index.html          前端页面（起名表单 + 模型下拉框 + 流式结果卡片）
api/name.js         POST /api/name：流式生成 + 落库
api/models.js       GET  /api/models：返回模型清单与密钥配置状态
api/_models.js      模型配置中心（modelConfigMap）+ 共用的流式调用
dev-server.mjs      本地预览服务器（等价于 vercel dev）
supabase.sql        Supabase 建表脚本
.env.example        环境变量模板（复制为 .env 后填值）
```

## 多模型是怎么做的

四家都提供 OpenAI 兼容的 `/chat/completions` 流式接口，所以只用一套 `callModelStream()`：

- **endpoint**：豆包 `ark.cn-beijing.volces.com`；DeepSeek `api.deepseek.com`；Qwen `每个业务空间各自的 maas.aliyuncs.com 域名`；Kimi `api.moonshot.cn`
- **差异**全部收敛在 `api/_models.js` 的 `modelConfigMap`：模型 ID、密钥变量名（含旧名别名）、特有请求参数（如 Kimi 强制 `temperature=1`）、超时
- 新增一家只需往 `modelConfigMap` 加一项，前端下拉框会自动出现，无需改页面

## 环境变量

复制 `.env.example` 为 `.env`，按需填写。**密钥只放环境变量，代码里不出现明文。**

| 变量 | 必需 | 说明 |
|---|---|---|
| `DOUBAO_API_KEY` | 用豆包时必需 | 火山方舟 API Key（兼容旧名 `ARK_API_KEY`） |
| `DEEPSEEK_API_KEY` | 用 DeepSeek 时必需 | 账户需有余额 |
| `DASHSCOPE_API_KEY` | 用 Qwen 时必需 | `sk-ws-` 开头的业务空间密钥 |
| `DASHSCOPE_BASE_URL` | 用 Qwen 时必需 | 业务空间专属域名，在百炼「按量付费 Base URL」处复制 |
| `KIMI_API_KEY` | 用 Kimi 时必需 | 月之暗面 API Key |
| `SUPABASE_URL` | 必需 | Supabase 项目地址 |
| `SUPABASE_ANON_KEY` | 必需 | publishable / anon key |
| `SUPABASE_TABLE` | 选填 | 默认 `naming_records` |
| `DOUBAO_MODEL` / `DEEPSEEK_MODEL` / `QWEN_MODEL` / `KIMI_MODEL` | 选填 | 覆盖默认模型 ID |

未配置某家的密钥时，它在下拉框里会标注「未配置密钥」，选择后会返回一条明确的提示，不影响其他模型。

## 本地运行

```bash
npm install
cp .env.example .env      # 填好密钥
npm run dev:local         # http://localhost:3000
```

`dev:local` 用 `dev-server.mjs` 模拟 Vercel 的「静态文件 + /api 函数」路由，无需 Vercel 登录态。
若已登录 Vercel，也可以直接用 `npm run dev`（即 `vercel dev`）。

## Supabase 建表与权限

在 Supabase SQL Editor 依次执行：

1. `supabase.sql`（建表 + 索引）
2. 权限三件套（缺一不可，报错文本各不相同）：

```sql
-- 表级权限：缺了报 permission denied for table
grant usage on schema public to anon;
grant select, insert, update, delete on public.naming_records to anon;
grant usage, select on sequence public.naming_records_id_seq to anon;

-- RLS 策略：缺了报 new row violates row-level security policy
create policy "naming_insert_all_roles" on public.naming_records
  as permissive for insert to public with check (true);
create policy "naming_select_all_roles" on public.naming_records
  as permissive for select to public using (true);
create policy "naming_delete_all_roles" on public.naming_records
  as permissive for delete to public using (true);
```

代码层面也做了兜底：写入时若因缺少 SELECT 策略读不回记录 id，会自动降级为纯插入，保证数据落库。

## 部署到 Vercel

1. 把仓库导入 Vercel
2. 在 Settings → Environment Variables 里填与本地 `.env` 相同的变量（`DASHSCOPE_BASE_URL` 也要填，否则 Qwen 会走公开域名并 401）
3. Deploy，得到公网域名

注意：Kimi 的首字延迟波动很大（实测 30~120 秒），而 Vercel 函数默认上限 60 秒，线上调用 Kimi 可能超时。要么升级套餐提高 `maxDuration`，要么把 Kimi 当本地备用。

## 已知限制

- 通义千问：密钥有效但业务空间未开通模型/无额度时，返回 403 `AccessDenied.Unpurchased`
- DeepSeek：余额为 0 时返回 402 `Insufficient Balance`
- 这两种情况页面都会给出中文提示，不影响豆包与 Kimi 使用
