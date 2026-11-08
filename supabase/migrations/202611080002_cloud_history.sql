-- Append-only migration: 001 is already deployed. No hosted changes are made by this file.
begin;
-- Lock existing accounts while the initial counter and triggers are installed.
lock table auth.users in share row exclusive mode;
create table public.registration_slots (
  singleton boolean primary key default true check (singleton),
  accounts integer not null check (accounts >= 0)
);
insert into public.registration_slots values (true, (select count(*) from auth.users));
alter table public.registration_slots enable row level security;
revoke all on public.registration_slots from public, anon, authenticated;
create function public.enforce_registration_capacity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.registration_slots set accounts = accounts + 1 where singleton and accounts < 100;
    if not found then raise exception 'Registration is full. Existing accounts can still sign in.' using errcode = 'P0001'; end if;
    return new;
  end if;
  update public.registration_slots set accounts = accounts - 1 where singleton;
  return old;
end;
$$;
revoke all on function public.enforce_registration_capacity() from public, anon, authenticated;
create trigger registration_capacity_insert after insert on auth.users for each row execute function public.enforce_registration_capacity();
create trigger registration_capacity_delete after delete on auth.users for each row execute function public.enforce_registration_capacity();
create function public.registration_capacity() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('available', accounts < 100) from public.registration_slots where singleton;
$$;
revoke all on function public.registration_capacity() from public;
grant execute on function public.registration_capacity() to anon, authenticated;

create table public.chat_storage_guard (
  singleton boolean primary key default true check (singleton),
  measured_bytes bigint not null default 0,
  measured_at timestamptz,
  writes_paused boolean not null default false
);
insert into public.chat_storage_guard(singleton) values(true);
alter table public.chat_storage_guard enable row level security;
revoke all on public.chat_storage_guard from public, anon, authenticated;
create function public.measure_chat_storage() returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.chat_storage_guard; bytes bigint;
begin
  select * into g from public.chat_storage_guard where singleton for update;
  bytes := pg_catalog.pg_database_size(pg_catalog.current_database());
  delete from public.chat_history_deleted where deleted_at < now() - interval '48 hours';
  update public.chat_storage_guard set measured_bytes = bytes, measured_at = now(),
    writes_paused = case when bytes >= 400000000 then true when bytes < 350000000 then false else g.writes_paused end
    where singleton returning * into g;
  return jsonb_build_object('bytes', bytes, 'paused', g.writes_paused, 'warning', bytes >= 350000000, 'measuredAt', g.measured_at);
end;
$$;
revoke all on function public.measure_chat_storage() from public, anon, authenticated;
grant execute on function public.measure_chat_storage() to service_role;

create table public.chat_history_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.chat_history (
  user_id uuid not null references public.chat_history_accounts(user_id) on delete cascade,
  id uuid not null,
  payload jsonb not null,
  payload_bytes integer not null check(payload_bytes > 0 and payload_bytes <= 2000000),
  last_messaged_at timestamptz not null default clock_timestamp(),
  revision bigint not null default 1,
  last_operation uuid not null,
  primary key(user_id, id)
);
create index chat_history_recent on public.chat_history(user_id, last_messaged_at desc, id desc);
-- Tombstones intentionally outlive deletion/eviction: an old offline save must never recreate a deleted chat.
create table public.chat_history_deleted (
  user_id uuid not null references public.chat_history_accounts(user_id) on delete cascade,
  id uuid not null,
  deleted_at timestamptz not null default now(),
  primary key(user_id, id)
);
alter table public.chat_history_accounts enable row level security;
alter table public.chat_history enable row level security;
alter table public.chat_history_deleted enable row level security;
revoke all on public.chat_history_accounts, public.chat_history, public.chat_history_deleted from public, anon, authenticated;
grant select on public.chat_history to authenticated;
create policy "Read own cloud conversations" on public.chat_history for select to authenticated using ((select auth.uid()) = user_id and (select public.chat_session_active()));

-- Rebuild a strict allowlist; callers cannot persist images, request diagnostics, settings or arbitrary fields.
create function public.clean_chat_payload(p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare m jsonb; source jsonb; sources jsonb; messages jsonb := '[]'; clean jsonb;
begin
  if octet_length(convert_to(p::text,'UTF8'))>2100000 then raise exception 'Conversation payload too large'; end if;
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'messages') is distinct from 'array' or
    jsonb_typeof(p->'title') is distinct from 'string' or char_length(p->>'title') > 160 or
    jsonb_array_length(p->'messages') > 10000 then raise exception 'Invalid conversation'; end if;
  for m in select value from jsonb_array_elements(p->'messages') loop
    if jsonb_typeof(m->'id') is distinct from 'string' or coalesce(m->>'role','') not in ('user','assistant') or jsonb_typeof(m->'content') is distinct from 'string' then raise exception 'Invalid message'; end if;
    clean := jsonb_build_object('id',m->>'id','role',m->>'role','content',m->>'content');
    if m->>'role' = 'assistant' then
      if coalesce(m->>'state','') not in ('complete','stopped','error') then raise exception 'Only terminal answers can be saved'; end if;
      clean := clean || jsonb_build_object('state',m->>'state');
      if m->>'model' in ('4bit','bf16') then clean := clean || jsonb_build_object('model',m->>'model'); end if;
      if jsonb_typeof(m->'useAdapter') = 'boolean' then clean := clean || jsonb_build_object('useAdapter',m->'useAdapter'); end if;
      -- Only fixed error/completion categories, never raw gateway errors or diagnostics.
      if m->>'state' = 'error' then clean := clean || jsonb_build_object('note','The reply failed. Please retry.');
      elsif m->>'state' = 'stopped' then clean := clean || jsonb_build_object('note','You stopped this reply.'); end if;
      sources := '[]';
      if jsonb_typeof(m->'docsSources') = 'array' and jsonb_array_length(m->'docsSources') <= 3 then
        for source in select value from jsonb_array_elements(m->'docsSources') loop
          if source->>'url' ~ '^https://docs[.]runpod[.]io/(pods/storage/types|pods/troubleshooting/zero-gpus|serverless/endpoints/endpoint-configurations|serverless/endpoints/send-requests|storage/network-volumes)(#[a-z0-9][a-z0-9/-]{0,159})?$' and
            jsonb_typeof(source->'heading') = 'string' and char_length(source->>'heading') <= 160 and source->>'id' ~ '^[1-3]$' then
            sources := sources || jsonb_build_array(jsonb_build_object('id',(source->>'id')::integer,'heading',source->>'heading','url',source->>'url'));
          end if;
        end loop;
        clean := clean || jsonb_build_object('docsSources',sources);
      end if;
    else
      if jsonb_typeof(m->'imageName') = 'string' then clean := clean || jsonb_build_object('imageName',left(m->>'imageName',160)); end if;
      if m->'docsMode' = 'true' then clean := clean || jsonb_build_object('docsMode',true); end if;
    end if;
    messages := messages || jsonb_build_array(clean);
  end loop;
  clean := jsonb_build_object('title',p->>'title','messages',messages);
  if p->>'model' in ('4bit','bf16') then clean := clean || jsonb_build_object('model',p->>'model'); end if;
  if jsonb_typeof(p->'useAdapter') = 'boolean' then clean := clean || jsonb_build_object('useAdapter',p->'useAdapter'); end if;
  return clean;
end;
$$;
revoke all on function public.clean_chat_payload(jsonb) from public, anon, authenticated;

create function public.chat_history_usage() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  return (select jsonb_build_object('bytes',coalesce(sum(payload_bytes),0),'count',count(*),'maxBytes',2000000,'maxCount',50,
    'paused',(select writes_paused from public.chat_storage_guard where singleton)) from public.chat_history where user_id=auth.uid());
end;
$$;
create function public.list_chat_history(p_before timestamptz default null, p_before_id uuid default null, p_limit integer default 20) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(row_data order by last_messaged_at desc,id desc) from (
    select id,last_messaged_at,jsonb_build_object('id',id,'title',payload->>'title','updatedAt',extract(epoch from last_messaged_at)*1000,'cursor',last_messaged_at,'revision',revision,'bytes',payload_bytes,'model',payload->>'model','useAdapter',payload->'useAdapter') row_data
    from public.chat_history where user_id=auth.uid() and (p_before is null or (last_messaged_at,id)<(p_before,p_before_id))
    order by last_messaged_at desc,id desc limit greatest(1,least(p_limit,50))) page),'[]');
end;
$$;
create function public.get_chat_history(p_id uuid, p_offset integer default 0, p_limit integer default 100) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  return (select jsonb_build_object('id',id,'payload',payload - 'messages' || jsonb_build_object('messages',
    coalesce((select jsonb_agg(value order by n) from jsonb_array_elements(payload->'messages') with ordinality x(value,n)
      where n>greatest(0,p_offset) and n<=greatest(0,p_offset)+greatest(1,least(p_limit,100))),'[]')),
    'totalMessages',jsonb_array_length(payload->'messages'),'revision',revision,'updatedAt',extract(epoch from last_messaged_at)*1000)
    from public.chat_history where user_id=auth.uid() and id=p_id);
end;
$$;

create function public.save_chat(p_id uuid, p_payload jsonb, p_revision bigint, p_operation uuid, p_created_at timestamptz default null) returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); existing public.chat_history; cleaned jsonb; bytes integer; total bigint; chats integer; victim uuid; evicted jsonb := '[]'; guard jsonb;
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_id is null or p_operation is null or p_revision is null or p_revision<0 then raise exception 'Invalid save'; end if;
  insert into public.chat_history_accounts values(u) on conflict do nothing;
  perform 1 from public.chat_history_accounts where user_id=u for update;
  if exists(select 1 from public.chat_history_deleted where user_id=u and id=p_id) then return jsonb_build_object('status','deleted'); end if;
  if octet_length(convert_to(p_payload::text,'UTF8'))>2100000 then return jsonb_build_object('status','oversized'); end if;
  cleaned := public.clean_chat_payload(p_payload) || jsonb_build_object('id',p_id);
  select * into existing from public.chat_history where user_id=u and id=p_id;
  if existing.last_operation=p_operation then
    if existing.payload<>cleaned then return jsonb_build_object('status','conflict','revision',existing.revision); end if;
    return jsonb_build_object('status','saved','revision',existing.revision,'evicted','[]'::jsonb,'usage',public.chat_history_usage());
  end if;
  if existing.id is null and p_revision>0 then return jsonb_build_object('status','deleted'); end if;
  if existing.id is null and (p_created_at is null or p_created_at < now()-interval '24 hours' or p_created_at > now()+interval '1 minute') then return jsonb_build_object('status','expired'); end if;
  if existing.id is null and (select count(*) from public.chat_history_deleted where user_id=u)>=1000 then return jsonb_build_object('status','create_limited'); end if;
  if coalesce(existing.revision,0)<>p_revision then return jsonb_build_object('status','conflict','revision',existing.revision); end if;
  bytes := octet_length(convert_to(cleaned::text,'UTF8'));
  if bytes>2000000 then return jsonb_build_object('status','oversized'); end if;
  -- Every write measures as well as the daily job; never trust a day-old measurement.
  guard := public.measure_chat_storage();
  if (guard->>'paused')::boolean then return jsonb_build_object('status','paused'); end if;
  select coalesce(sum(payload_bytes),0),count(*) into total,chats from public.chat_history where user_id=u and id<>p_id;
  while total+bytes>2000000 or chats+1>50 loop
    select id into victim from public.chat_history where user_id=u and id<>p_id order by last_messaged_at,id limit 1;
    if victim is null then raise exception 'Quota calculation failed'; end if;
    insert into public.chat_history_deleted(user_id,id) values(u,victim) on conflict do nothing;
    delete from public.chat_history where user_id=u and id=victim;
    evicted := evicted || jsonb_build_array(victim);
    select coalesce(sum(payload_bytes),0),count(*) into total,chats from public.chat_history where user_id=u and id<>p_id;
  end loop;
  insert into public.chat_history(user_id,id,payload,payload_bytes,last_operation) values(u,p_id,cleaned,bytes,p_operation)
    on conflict(user_id,id) do update set payload=excluded.payload,payload_bytes=excluded.payload_bytes,last_operation=excluded.last_operation,
      revision=public.chat_history.revision+1,last_messaged_at=clock_timestamp() returning * into existing;
  return jsonb_build_object('status','saved','revision',existing.revision,'evicted',evicted,'usage',public.chat_history_usage());
end;
$$;
create function public.delete_chat(p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  insert into public.chat_history_accounts values(u) on conflict do nothing;
  perform 1 from public.chat_history_accounts where user_id=u for update;
  delete from public.chat_history_deleted where user_id=u and deleted_at < now()-interval '48 hours';
  -- A create whose acknowledgement was lost may arrive after this delete. Mark even
  -- missing IDs, bounded per account, so that delayed creation cannot resurrect it.
  -- Existing rows can always be deleted (at most 50 extra markers beyond the cap).
  if not exists(select 1 from public.chat_history where user_id=u and id=p_id)
    and not exists(select 1 from public.chat_history_deleted where user_id=u and id=p_id)
    and (select count(*) from public.chat_history_deleted where user_id=u)>=1000 then
    raise exception 'Recent deletion limit reached. Retry later.' using errcode='P0001';
  end if;
  insert into public.chat_history_deleted(user_id,id) values(u,p_id) on conflict do nothing;
  delete from public.chat_history where user_id=u and id=p_id;
  return public.chat_history_usage();
end;
$$;
revoke all on function public.chat_history_usage(),public.list_chat_history(timestamptz,uuid,integer),public.get_chat_history(uuid,integer,integer),public.save_chat(uuid,jsonb,bigint,uuid,timestamptz),public.delete_chat(uuid) from public,anon;
grant execute on function public.chat_history_usage(),public.list_chat_history(timestamptz,uuid,integer),public.get_chat_history(uuid,integer,integer),public.save_chat(uuid,jsonb,bigint,uuid,timestamptz),public.delete_chat(uuid) to authenticated;
commit;
