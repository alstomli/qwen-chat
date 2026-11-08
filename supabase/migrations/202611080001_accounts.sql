create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy "Read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "Edit own profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create function public.create_account_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name) values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80));
  return new;
end;
$$;
revoke all on function public.create_account_profile() from public, anon, authenticated;
create trigger account_profile_created after insert on auth.users for each row execute function public.create_account_profile();
insert into public.profiles (id, display_name) select id, left(coalesce(raw_user_meta_data ->> 'display_name', ''), 80) from auth.users on conflict (id) do nothing;

-- Check live session existence as well as verified email before paid inference.
-- No caller-supplied user/session arguments and no direct access to auth tables.
create function public.chat_session_active() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = auth.uid() and u.email_confirmed_at is not null
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function public.chat_session_active() from public, anon;
grant execute on function public.chat_session_active() to authenticated;
