-- RLS for wallet-scoped access.
-- Auth is a JWT minted by /api/auth after signing a challenge with the caller's
-- EVM wallet. The JWT's "sub" claim is the (lowercased) wallet address, so every
-- table policy scopes to the row whose wallet_address matches that claim.
-- Without a valid signed-in JWT nothing is readable or writable.

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;

drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile insert" on public.profiles;
drop policy if exists "own profile update" on public.profiles;
drop policy if exists "own profile delete" on public.profiles;

drop policy if exists "own prefs read" on public.user_preferences;
drop policy if exists "own prefs insert" on public.user_preferences;
drop policy if exists "own prefs update" on public.user_preferences;
drop policy if exists "own prefs delete" on public.user_preferences;

-- legacy permissive policies created when the tables were first created
drop policy if exists "profiles are public" on public.profiles;
drop policy if exists "profiles can be updated by app" on public.profiles;
drop policy if exists "profiles can be upserted by app" on public.profiles;
drop policy if exists "preferences can be read by app" on public.user_preferences;
drop policy if exists "preferences can be updated by app" on public.user_preferences;
drop policy if exists "preferences can be upserted by app" on public.user_preferences;

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