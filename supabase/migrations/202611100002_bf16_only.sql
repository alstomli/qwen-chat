-- BF16-only history writes; preserve deployed migration files and existing rows.
-- The frontend omits conversations with explicit unsupported model metadata.
begin;
create or replace function public.clean_chat_payload(p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare m jsonb; source jsonb; sources jsonb; web jsonb; messages jsonb := '[]'; clean jsonb;
begin
  if octet_length(convert_to(p::text,'UTF8'))>2100000 then raise exception 'Conversation payload too large'; end if;
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'messages') is distinct from 'array' or
    jsonb_typeof(p->'title') is distinct from 'string' or char_length(p->>'title') > 160 or
    jsonb_array_length(p->'messages') > 10000 then raise exception 'Invalid conversation'; end if;
  if p ? 'model' and p->>'model' is distinct from 'bf16' then raise exception 'Unsupported conversation model'; end if;
  for m in select value from jsonb_array_elements(p->'messages') loop
    if jsonb_typeof(m->'id') is distinct from 'string' or coalesce(m->>'role','') not in ('user','assistant') or jsonb_typeof(m->'content') is distinct from 'string' then raise exception 'Invalid message'; end if;
    clean := jsonb_build_object('id',m->>'id','role',m->>'role','content',m->>'content');
    if m->>'role' = 'assistant' then
      if m ? 'model' and m->>'model' is distinct from 'bf16' then raise exception 'Unsupported answer model'; end if;
      if coalesce(m->>'state','') not in ('complete','stopped','error') then raise exception 'Only terminal answers can be saved'; end if;
      clean := clean || jsonb_build_object('state',m->>'state');
      if m->>'model' = 'bf16' then clean := clean || jsonb_build_object('model',m->>'model'); end if;
      if jsonb_typeof(m->'useAdapter') = 'boolean' then clean := clean || jsonb_build_object('useAdapter',m->'useAdapter'); end if;
      -- Only fixed error/completion categories, never raw gateway errors or diagnostics.
      if m->>'state' = 'error' then clean := clean || jsonb_build_object('note','The reply failed. Please retry.');
      elsif m->>'state' = 'stopped' then clean := clean || jsonb_build_object('note','You stopped this reply.'); end if;
      web := public.clean_web_search_metadata(m->'webSearch');
      if web is not null then clean := clean || jsonb_build_object('webSearch',web); end if;
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
      if m->'searchRequested' = 'true' then clean := clean || jsonb_build_object('searchRequested',true); end if;
      if m->'docsMode' = 'true' then clean := clean || jsonb_build_object('docsMode',true); end if;
    end if;
    messages := messages || jsonb_build_array(clean);
  end loop;
  clean := jsonb_build_object('title',p->>'title','messages',messages);
  if p->>'model' = 'bf16' then clean := clean || jsonb_build_object('model',p->>'model'); end if;
  if jsonb_typeof(p->'useAdapter') = 'boolean' then clean := clean || jsonb_build_object('useAdapter',p->'useAdapter'); end if;
  return clean;
end;
$$;
revoke all on function public.clean_chat_payload(jsonb) from public, anon, authenticated;

commit;
