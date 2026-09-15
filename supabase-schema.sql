-- 在 Supabase Dashboard 的 SQL Editor 中完整运行本文件。
create table if not exists public.decks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  description text not null default '' check (char_length(description) <= 300),
  cards jsonb not null default '{}'::jsonb check (jsonb_typeof(cards) = 'object'),
  is_public boolean not null default false,
  author_name text not null default '玩家' check (char_length(author_name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists decks_owner_updated_idx on public.decks (owner_id, updated_at desc);
create index if not exists decks_public_updated_idx on public.decks (is_public, updated_at desc) where is_public;

alter table public.decks enable row level security;
revoke all on table public.decks from anon, authenticated;
grant select on table public.decks to anon;
grant select, insert, update, delete on table public.decks to authenticated;

drop policy if exists "Public decks are readable" on public.decks;
create policy "Public decks are readable" on public.decks
  for select to anon, authenticated
  using (is_public or (select auth.uid()) = owner_id);

drop policy if exists "Users create their own decks" on public.decks;
create policy "Users create their own decks" on public.decks
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users update their own decks" on public.decks;
create policy "Users update their own decks" on public.decks
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users delete their own decks" on public.decks;
create policy "Users delete their own decks" on public.decks
  for delete to authenticated
  using ((select auth.uid()) = owner_id);
