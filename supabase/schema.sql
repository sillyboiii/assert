create table if not exists public.profiles (
  wallet_address text primary key,
  username text not null default '',
  pfp_url text not null default '',
  locked boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_preferences (
  wallet_address text primary key,
  dismissed_request_ids text[] not null default '{}',
  hidden_friend_addresses text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists user_preferences_updated_at on public.user_preferences;
create trigger user_preferences_updated_at
before update on public.user_preferences
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;

drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public"
on public.profiles for select
using (true);

drop policy if exists "profiles can be upserted by app" on public.profiles;
create policy "profiles can be upserted by app"
on public.profiles for insert
with check (true);

drop policy if exists "profiles can be updated by app" on public.profiles;
create policy "profiles can be updated by app"
on public.profiles for update
using (true)
with check (true);

drop policy if exists "preferences can be read by app" on public.user_preferences;
create policy "preferences can be read by app"
on public.user_preferences for select
using (true);

drop policy if exists "preferences can be upserted by app" on public.user_preferences;
create policy "preferences can be upserted by app"
on public.user_preferences for insert
with check (true);

drop policy if exists "preferences can be updated by app" on public.user_preferences;
create policy "preferences can be updated by app"
on public.user_preferences for update
using (true)
with check (true);
