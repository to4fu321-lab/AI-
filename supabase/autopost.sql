-- 動画オート投稿（/autopost）と会員制動画サイト（/members）のための表と、動画の置き場。
-- Supabase の SQL Editor に貼って 1 回実行する（何度実行しても壊れない）。
-- どの表も RLS を有効にして公開用の許可を作らないので、サーバー（service_role）からしか読めない。

create table if not exists autopost_videos (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  memo text not null default '',
  path text not null default '',          -- 置き場（Storage）の中の場所。空ならアップロード未完了
  thumb text not null default '',         -- 一覧用の小さい絵（data URL）
  frames jsonb not null default '[]',     -- AI に見せるコマ（data URL の配列）
  duration real not null default 0,
  width int not null default 0,
  height int not null default 0,
  size bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists autopost_sites (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                     -- youtube / x / instagram / own / manual
  name text not null,
  enabled boolean not null default true,
  auto boolean not null default true,     -- 「おまかせ」で投稿まで進めるか
  rules jsonb not null default '{}',      -- 必ず入れる文・ハッシュタグ・口調など
  cred_enc text not null default '',      -- ログイン情報・API の鍵（AES-256-GCM で暗号化）
  created_at timestamptz not null default now()
);

create table if not exists autopost_posts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references autopost_videos(id) on delete cascade,
  site_id uuid not null references autopost_sites(id) on delete cascade,
  title text not null default '',
  body text not null default '',
  status text not null default 'draft',   -- draft / posting / posted / failed
  url text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique (video_id, site_id)
);

create table if not exists autopost_members (
  id uuid primary key default gen_random_uuid(),
  login_id text not null unique,
  name text not null default '',
  pass_hash text not null,                -- scrypt のハッシュ（元のパスワードは残さない）
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table autopost_videos enable row level security;
alter table autopost_sites enable row level security;
alter table autopost_posts enable row level security;
alter table autopost_members enable row level security;

-- 動画の置き場（非公開）。見るときは毎回、期限つきの URL を発行する
insert into storage.buckets (id, name, public)
values ('autopost', 'autopost', false)
on conflict (id) do nothing;
