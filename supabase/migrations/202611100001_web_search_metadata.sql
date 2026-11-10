-- Additive metadata whitelist. No page bodies, snippets, queries, credentials or tool traces.
-- Existing docsSources handling and history RPC access controls remain unchanged.
create function public.clean_web_search_metadata(p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare source jsonb; sources jsonb := '[]'; ids text[] := '{}'; run text;
begin
  if jsonb_typeof(p) is distinct from 'object' or p->'version' is distinct from '1'::jsonb or
    jsonb_typeof(p->'runId') is distinct from 'string' or p->>'runId' !~ '^[a-zA-Z0-9_-]{1,80}$' or
    coalesce(p->>'outcome','') not in ('completed','failed','stopped','interrupted') or
    jsonb_typeof(p->'sources') is distinct from 'array' then return null; end if;
  if jsonb_array_length(p->'sources') > 10 then return null; end if;
  run := p->>'runId';
  for source in select value from jsonb_array_elements(p->'sources') loop
    if jsonb_typeof(source) is distinct from 'object' or source->>'runId' is distinct from run or
      jsonb_typeof(source->'sourceId') is distinct from 'string' or source->>'sourceId' !~ '^S[1-9][0-9]{0,2}$' or
      source->>'sourceId' = any(ids) or jsonb_typeof(source->'title') is distinct from 'string' or
      length(trim(source->>'title')) = 0 or length(source->>'title') > 300 or
      jsonb_typeof(source->'url') is distinct from 'string' or length(source->>'url') > 2048 or
      source->>'url' !~ '^https?://[^/@[:space:]]+([/?#][^[:space:]]*)?$' or
      jsonb_typeof(source->'retrievedAt') is distinct from 'string' or length(source->>'retrievedAt') > 64 or
      source->>'retrievedAt' !~ '^\d{4}-\d\d-\d\dT' or
      coalesce(source->>'evidenceKind','') not in ('search','page') then return null; end if;
    -- A failed cast is handled below; arbitrary date text never reaches stored metadata.
    perform (source->>'retrievedAt')::timestamptz;
    ids := array_append(ids,source->>'sourceId');
    sources := sources || jsonb_build_array(jsonb_build_object('runId',run,'sourceId',source->>'sourceId',
      'title',source->>'title','url',source->>'url','retrievedAt',source->>'retrievedAt','evidenceKind',source->>'evidenceKind'));
  end loop;
  return jsonb_build_object('version',1,'runId',run,'outcome',p->>'outcome','sources',sources);
exception when invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;
revoke all on function public.clean_web_search_metadata(jsonb) from public, anon, authenticated;

create or replace function public.clean_chat_payload(p jsonb) returns jsonb language plpgsql immutable set search_path = '' as $$
declare m jsonb; source jsonb; sources jsonb; web jsonb; messages jsonb := '[]'; clean jsonb;
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
  if p->>'model' in ('4bit','bf16') then clean := clean || jsonb_build_object('model',p->>'model'); end if;
  if jsonb_typeof(p->'useAdapter') = 'boolean' then clean := clean || jsonb_build_object('useAdapter',p->'useAdapter'); end if;
  return clean;
end;
$$;
revoke all on function public.clean_chat_payload(jsonb) from public, anon, authenticated;
