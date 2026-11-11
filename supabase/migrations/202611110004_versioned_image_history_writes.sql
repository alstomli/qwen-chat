-- An older open app can restore the latest shared-cache revision without reading
-- the server again. Keep its saver from dropping metadata that it cannot parse.
begin;
do $$
declare original_definition text;
begin
  if pg_catalog.to_regprocedure('public.save_chat_v2(uuid,jsonb,bigint,uuid,timestamptz)') is null then
    if pg_catalog.to_regprocedure('public.save_chat(uuid,jsonb,bigint,uuid,timestamptz)') is null then
      raise exception 'Versioned history writes require the existing save_chat function';
    end if;
    original_definition := pg_catalog.pg_get_functiondef('public.save_chat(uuid,jsonb,bigint,uuid,timestamptz)'::regprocedure);
    if position('CREATE OR REPLACE FUNCTION public.save_chat(' in original_definition) <> 1 or
      position('public.save_chat_v2(' in original_definition) > 0 then
      raise exception 'Cannot copy the original history saver safely';
    end if;
    -- Change only the function declaration. Preserve the deployed body, defaults,
    -- security, search_path, session checks, locks, CAS, quotas and idempotency.
    execute replace(original_definition, 'CREATE OR REPLACE FUNCTION public.save_chat(', 'CREATE OR REPLACE FUNCTION public.save_chat_v2(');
  end if;
end;
$$;
revoke all on function public.save_chat_v2(uuid,jsonb,bigint,uuid,timestamptz) from public,anon;
grant execute on function public.save_chat_v2(uuid,jsonb,bigint,uuid,timestamptz) to authenticated;

create or replace function public.save_chat(p_id uuid, p_payload jsonb, p_revision bigint, p_operation uuid, p_created_at timestamptz default null) returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); existing public.chat_history;
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_id is null or p_operation is null or p_revision is null or p_revision<0 then raise exception 'Invalid save'; end if;
  -- Use the ORIGINAL saver/deleter's account lock before inspecting metadata.
  -- Holding it through delegation prevents a v2 edit from racing this check.
  insert into public.chat_history_accounts values(u) on conflict do nothing;
  perform 1 from public.chat_history_accounts where user_id=u for update;
  select * into existing from public.chat_history where user_id=u and id=p_id;
  if existing.id is not null and exists (select 1 from jsonb_array_elements(existing.payload->'messages') as item(value)
    where value->'generatedImage'->'version' = '2'::jsonb) then
    return jsonb_build_object('status','conflict','revision',existing.revision);
  end if;
  return public.save_chat_v2(p_id,p_payload,p_revision,p_operation,p_created_at);
end;
$$;
revoke all on function public.save_chat(uuid,jsonb,bigint,uuid,timestamptz) from public,anon;
grant execute on function public.save_chat(uuid,jsonb,bigint,uuid,timestamptz) to authenticated;
notify pgrst, 'reload schema';
commit;
