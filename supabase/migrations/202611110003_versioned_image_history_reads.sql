-- Old clients render raw RPC messages before their local metadata parser runs.
-- Reject unsupported edit pages instead of letting an old client erase edit intent.
begin;
create or replace function public.get_chat_history_v2(p_id uuid, p_offset integer default 0, p_limit integer default 100) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.chat_session_active() then raise exception 'Authentication required' using errcode='42501'; end if;
  return (select jsonb_build_object('id',id,'payload',payload - 'messages' || jsonb_build_object('messages',
    coalesce((select jsonb_agg(value order by n) from jsonb_array_elements(payload->'messages') with ordinality x(value,n)
      where n>greatest(0,p_offset) and n<=greatest(0,p_offset)+greatest(1,least(p_limit,100))),'[]')),
    'totalMessages',jsonb_array_length(payload->'messages'),'revision',revision,'updatedAt',extract(epoch from last_messaged_at)*1000)
    from public.chat_history where user_id=auth.uid() and id=p_id);
end;
$$;
revoke all on function public.get_chat_history_v2(uuid,integer,integer) from public,anon;
grant execute on function public.get_chat_history_v2(uuid,integer,integer) to authenticated;

create or replace function public.get_chat_history(p_id uuid, p_offset integer default 0, p_limit integer default 100) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.get_chat_history_v2(p_id,p_offset,p_limit);
  if exists (select 1 from jsonb_array_elements(result->'payload'->'messages') as item(value)
    where value->'generatedImage'->'version' = '2'::jsonb) then
    raise exception 'Reload Kiddo Chat to open reference-image edits';
  end if;
  return result;
end;
$$;
revoke all on function public.get_chat_history(uuid,integer,integer) from public,anon;
grant execute on function public.get_chat_history(uuid,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
