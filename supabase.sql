-- ============================================================
-- AI 起名 · Supabase 建表脚本
-- 用法：Supabase 控制台 → SQL Editor → 粘贴执行一次
-- ============================================================

-- 1. 起名记录表（存「用户需求 + 生成的名字方案 + 使用的模型」）
create table if not exists public.naming_records (
  id          bigint generated always as identity primary key,
  requirement text        not null,              -- 用户起名需求
  name_type   text,                              -- 起名类型：人名 / 宠物名 / 品牌名 …
  style       text,                              -- 偏好风格
  extra       text,                              -- 补充要求
  model       text        not null,              -- 使用的模型，如 doubao-seed-2-1-pro-260915
  names       jsonb       not null default '[]'::jsonb,  -- 名字方案 [{name, meaning, source}]
  raw_output  text,                              -- 模型原始输出，便于回溯
  created_at  timestamptz not null default now()
);

comment on table  public.naming_records is 'AI 起名记录';
comment on column public.naming_records.names is '解析后的 3 组名字方案 JSON 数组';

-- 2. 常用索引：按时间倒序列出历史记录
create index if not exists naming_records_created_at_idx
  on public.naming_records (created_at desc);

-- 3. 开启行级安全
alter table public.naming_records enable row level security;

-- 4. 权限策略
--    · 本项目 .env 用的是 SUPABASE_ANON_KEY，属于匿名身份，必须执行下面的 policy，
--      否则插入会报 "new row violates row-level security policy"，取消两行注释后执行即可。
--    · 若改用 SUPABASE_SERVICE_ROLE_KEY（服务端密钥，会绕过 RLS），则不需要该 policy。
drop policy if exists "anon_insert_naming_records" on public.naming_records;
create policy "anon_insert_naming_records"
  on public.naming_records for insert to anon with check (true);

-- 5. 自查（可选）
-- select id, requirement, model, jsonb_array_length(names) as name_count, created_at
-- from public.naming_records
-- order by created_at desc
-- limit 20;
