-- アカウント引っ越し（/migrate）のための表。
-- Supabase の SQL Editor に貼って 1 回実行する（何度実行しても壊れない）。
-- どの表も RLS を有効にして公開用の許可を作らないので、サーバー（service_role）からしか読めない。
-- メールの本文は保存しない。保存するのは、差出人のドメインごとの件数・日付・件名の見本だけ。

create table if not exists migrate_mailboxes (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  token_enc text not null default '',     -- Gmail を読む合言葉（AES-256-GCM で暗号化）
  scan jsonb not null default '{}',       -- 調べている途中の続き（どこまで読んだか）
  scanned int not null default 0,         -- これまでに読んだメールの数
  last_scan timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists migrate_services (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references migrate_mailboxes(id) on delete cascade,
  domain text not null,                   -- 差出人のドメイン（例：example.co.jp）
  name text not null default '',          -- 差出人の表示名でいちばん多いもの
  names jsonb not null default '{}',      -- 表示名ごとの件数
  count int not null default 0,
  signals jsonb not null default '{}',    -- 種類ごとの件数（signup / password / security / billing）
  subjects jsonb not null default '[]',   -- 件名の見本（新しいものから数件）
  first_at timestamptz,
  last_at timestamptz,
  status text not null default 'new',     -- new / move / skip / done
  login_url text not null default '',     -- 開くページ（空ならドメインの先頭）
  note text not null default '',
  updated_at timestamptz not null default now(),
  unique (mailbox_id, domain)
);

alter table migrate_mailboxes enable row level security;
alter table migrate_services enable row level security;
