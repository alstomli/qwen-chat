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
  insert into public.profiles (id, display_name) values (new.id, left(coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''), new.raw_user_meta_data ->> 'display_name', ''), 80));
  return new;
end;
$$;
revoke all on function public.create_account_profile() from public, anon, authenticated;
create trigger account_profile_created after insert on auth.users for each row execute function public.create_account_profile();
insert into public.profiles (id, display_name) select id, left(coalesce(nullif(raw_user_meta_data ->> 'full_name', ''), nullif(raw_user_meta_data ->> 'name', ''), raw_user_meta_data ->> 'display_name', ''), 80) from auth.users on conflict (id) do nothing;

-- Check live session existence and a verified matching Google identity before inference.
-- Profile metadata above is display-only and never grants authorization.
-- No caller-supplied user/session arguments and no direct access to auth tables.
create function public.chat_session_active() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = auth.uid() and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous, false)
      and exists (
        select 1 from auth.identities i
        where i.user_id = u.id and i.provider = 'google'
          and i.identity_data -> 'email_verified' = 'true'::jsonb
          and lower(i.identity_data ->> 'email') = lower(u.email)
      )
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function public.chat_session_active() from public, anon;
grant execute on function public.chat_session_active() to authenticated;
