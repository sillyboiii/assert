-- RLS for wallet-scoped access.
-- Auth is a JWT minted by /api/auth after signing a challenge with the caller's
-- EVM wallet. The JWT's "sub" claim is the (lowercased) wallet address, so every
-- table policy scopes to the row whose wallet_address matches that claim.
-- Without a valid signed-in JWT nothing is readable or writable.

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;

-- optional column for following asserts (added idempotently; safe to re-run)
alter table public.user_preferences add column if not exists followed_goal_ids text[] not null default '{}';

create table if not exists public.referee_denials (
  goal_id text primary key,
  creator_wallet text not null,
  referee_wallet text not null,
  created_at timestamptz not null default now()
);

alter table public.referee_denials enable row level security;

drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile insert" on public.profiles;
drop policy if exists "own profile update" on public.profiles;
drop policy if exists "own profile delete" on public.profiles;

drop policy if exists "own prefs read" on public.user_preferences;
drop policy if exists "own prefs insert" on public.user_preferences;
drop policy if exists "own prefs update" on public.user_preferences;
drop policy if exists "own prefs delete" on public.user_preferences;

drop policy if exists "denials participant read" on public.referee_denials;
drop policy if exists "denials referee insert" on public.referee_denials;
drop policy if exists "denials referee update" on public.referee_denials;

-- legacy permissive policies created when the tables were first created
drop policy if exists "profiles are public" on public.profiles;
drop policy if exists "profiles can be updated by app" on public.profiles;
drop policy if exists "profiles can be upserted by app" on public.profiles;
drop policy if exists "preferences can be read by app" on public.user_preferences;
drop policy if exists "preferences can be updated by app" on public.user_preferences;
drop policy if exists "preferences can be upserted by app" on public.user_preferences;

-- profile rows are intentionally readable by any signed-in wallet so friend
-- lists can show live name/avatar updates (writes stay owner-only below).
-- Anonymous users (no JWT) still see nothing.
drop policy if exists "profiles readable by authenticated users" on public.profiles;
create policy "profiles readable by authenticated users" on public.profiles
  for select
  to authenticated
  using (true);

create policy "own profile read" on public.profiles
  for select
  using (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own profile insert" on public.profiles
  for insert
  with check (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own profile update" on public.profiles
  for update
  using (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own profile delete" on public.profiles
  for delete
  using (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own prefs read" on public.user_preferences
  for select
  using (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own prefs insert" on public.user_preferences
  for insert
  with check (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own prefs update" on public.user_preferences
  for update
  using (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "own prefs delete" on public.user_preferences
  for delete
  using (wallet_address = lower((auth.jwt() ->> 'sub')::text));

create policy "denials participant read" on public.referee_denials
  for select
  to authenticated
  using (
    creator_wallet = lower((auth.jwt() ->> 'sub')::text)
    or referee_wallet = lower((auth.jwt() ->> 'sub')::text)
  );

create policy "denials referee insert" on public.referee_denials
  for insert
  to authenticated
  with check (referee_wallet = lower((auth.jwt() ->> 'sub')::text));

create policy "denials referee update" on public.referee_denials
  for update
  to authenticated
  using (referee_wallet = lower((auth.jwt() ->> 'sub')::text))
  with check (referee_wallet = lower((auth.jwt() ->> 'sub')::text));
