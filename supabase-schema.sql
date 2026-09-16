-- 在 Supabase Dashboard 的 SQL Editor 中完整运行本文件。
create table if not exists public.decks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  description text not null default '' check (char_length(description) <= 300),
  environment text not null default 'bp01' check (environment in ('bp01', 'bp02')),
  cards jsonb not null default '{}'::jsonb check (jsonb_typeof(cards) = 'object'),
  is_public boolean not null default false,
  author_name text not null default '玩家' check (char_length(author_name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.decks
  add column if not exists environment text not null default 'bp01'
  check (environment in ('bp01', 'bp02'));

create index if not exists decks_owner_updated_idx on public.decks (owner_id, updated_at desc);
create index if not exists decks_public_updated_idx on public.decks (is_public, updated_at desc) where is_public;
create index if not exists decks_public_environment_updated_idx on public.decks (environment, updated_at desc) where is_public;

create table if not exists public.site_metrics (
  id boolean primary key default true check (id),
  total_visits bigint not null default 0 check (total_visits >= 0),
  updated_at timestamptz not null default now()
);

insert into public.site_metrics (id, total_visits) values (true, 0)
on conflict (id) do nothing;

alter table public.site_metrics enable row level security;
revoke all on table public.site_metrics from anon, authenticated;

create or replace function public.get_site_stats(increment_visit boolean default false)
returns table (total_visits bigint, total_registrations bigint)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if increment_visit then
    update public.site_metrics as metrics
      set total_visits = metrics.total_visits + 1, updated_at = now()
      where metrics.id = true;
  end if;
  return query
    select metrics.total_visits, (select count(*)::bigint from auth.users)
    from public.site_metrics as metrics
    where metrics.id = true;
end;
$$;

revoke all on function public.get_site_stats(boolean) from public;
grant execute on function public.get_site_stats(boolean) to anon, authenticated;

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
