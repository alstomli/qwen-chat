// Local PostgreSQL semantics checks. Does not contact Supabase or any hosted service.
// PGlite is an optional verification dependency; CHAT_TEST_PGLITE accepts its absolute dist/index.js path.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.CHAT_TEST_PGLITE ? pathToFileURL(resolve(process.env.CHAT_TEST_PGLITE)).href : '@electric-sql/pglite');
import { readFile, readdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture({ beforeHistory } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, is_anonymous boolean default false,
      raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key, user_id uuid references auth.users on delete cascade, not_after timestamptz);
    create table auth.identities(id uuid primary key, provider_id text, user_id uuid references auth.users on delete cascade,
      provider text, identity_data jsonb, email text generated always as (lower(identity_data->>'email')) stored);
    create function auth.jwt() returns jsonb language sql stable as $$ select current_setting('request.jwt.claims',true)::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid(),auth.jwt() to authenticated, anon;
  `);
  const dir = `${root}/supabase/migrations`;
  for (const file of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) {
    if (file !== '202611080001_accounts.sql' && beforeHistory) { await beforeHistory(db); beforeHistory = undefined; }
    await db.exec(await readFile(`${dir}/${file}`, 'utf8'));
  }
  const addUser = async (id = randomUUID()) => {
    const session = randomUUID(); const email = `qa-${id}@example.com`;
    await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())', [id,email]);
    await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [session,id]);
    await db.query('insert into auth.identities(id,provider_id,user_id,provider,identity_data) values ($1,$2,$1,$3,$4)',
      [id, `google-${id}`, 'google', { sub: `google-${id}`, email, email_verified: true }]);
    return { id, session };
  };
  const as = async (user, role = 'authenticated') => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(user ? { sub: user.id, session_id: user.session } : {})]);
    await db.exec(`set role ${role}`);
  };
  const admin = () => db.exec('reset role');
  return { db, addUser, as, admin };
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const check = (name, test) => test().then(() => console.log(`PASS: ${name}`));
const chat = (text = 'hello', title = 'Independent QA') => ({ title, model: '4bit', messages: [
  { id: randomUUID(), role: 'user', content: text },
  { id: randomUUID(), role: 'assistant', content: 'A terminal answer', state: 'complete', model: '4bit' },
] });
const rpc = async (db, sql, params = []) => (await db.query(`select public.${sql} as value`, params)).rows[0].value;
async function helpers(f) {
  const { db } = f;
  const names = (await db.query("select proargnames from pg_proc where proname='save_chat' and pronamespace='public'::regnamespace")).rows[0].proargnames;
  const save = (id, payload = chat(), revision = 0, op = randomUUID(), created = new Date().toISOString()) =>
    rpc(db, names.length >= 5 ? 'save_chat($1,$2,$3,$4,$5)' : 'save_chat($1,$2,$3,$4)',
      names.length >= 5 ? [id,payload,revision,op,created] : [id,payload,revision,op]);
  const get = id => rpc(db, 'get_chat_history($1)', [id]);
  const usage = () => rpc(db, 'chat_history_usage()');
  return { save, get, usage };
}

await check('account cap includes existing accounts, permits existing login, transactional rollback and deletion frees slot', async () => {
  const f = await fixture({ beforeHistory: async db => {
    for (let i=0;i<99;i++) await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())', [randomUUID(),`existing${i}@example.com`]);
  } });
  try {
    assert.equal(await rpc(f.db,'registration_capacity()').then(v=>v.available),true);
    const existingId=(await f.db.query('select id from auth.users limit 1')).rows[0].id;
    await f.db.query('insert into auth.users(id,email) values ($1,$2) on conflict(id) do nothing',[existingId,'ignored@example.com']);
    assert.equal((await f.db.query('select accounts from public.registration_slots')).rows[0].accounts,99);
    const user = await f.addUser();
    assert.equal(await rpc(f.db,'registration_capacity()').then(v=>v.available),false);
    await f.db.query('insert into auth.users(id,email) values ($1,$2) on conflict(id) do nothing',[existingId,'ignored-at-full@example.com']);
    assert.equal((await f.db.query('select accounts from public.registration_slots')).rows[0].accounts,100);
    await assert.rejects(f.addUser(), /Registration is full/);
    assert.equal((await f.db.query('select count(*)::int n from auth.users')).rows[0].n,100);
    await f.as(user);
    assert.equal(await rpc(f.db,'chat_session_active()'),true);
    await f.admin();
    const remove = (await f.db.query('select id from auth.users where id<>$1 limit 1',[user.id])).rows[0].id;
    await f.db.query('delete from auth.users where id=$1',[remove]);
    await f.db.exec('begin');
    await f.addUser();
    await f.db.exec('rollback');
    assert.equal(await rpc(f.db,'registration_capacity()').then(v=>v.available),true);
    const results = await Promise.allSettled(Array.from({length: 8}, () => f.db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())',[randomUUID(),'parallel@example.com'])));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await f.db.query('select count(*)::int n from auth.users')).rows[0].n,100);
    assert.equal((await f.db.query('select accounts from public.registration_slots')).rows[0].accounts,100);
  } finally { await f.db.close(); }
});

await check('cloud ownership, privilege boundary, Google live sessions, immutable canonical payload and safe idempotency', async () => {
  const f = await fixture();
  try {
    const alice = await f.addUser(), bob = await f.addUser();
    const { save, get, usage } = await helpers(f);
    const id = randomUUID(), op = randomUUID();
    await f.as(alice);
    const payload = chat('你好🌍');
    payload.image = 'data:image/png;base64,PRIVATE';
    payload.messages[0].imageName = 'photo.png'; payload.messages[0].image = 'SECRET_IMAGE';
    payload.messages[1].note = 'PRIVATE_RAW_ERROR'; payload.messages[1].diagnostics = { token: 'PRIVATE_TOKEN' };
    const first = await save(id,payload,0,op);
    assert.equal(first.status,'saved'); assert.equal(first.revision,1);
    const persisted = await get(id); const serialized = JSON.stringify(persisted);
    assert.ok(serialized.includes('你好🌍')); assert.ok(serialized.includes('photo.png'));
    for (const secret of ['PRIVATE','SECRET_IMAGE','PRIVATE_RAW_ERROR','PRIVATE_TOKEN']) assert.ok(!serialized.includes(secret),secret);
    assert.equal((await save(id,payload,0,op)).status,'saved');
    assert.equal((await save(id,chat('replace attack'),0,op)).status,'conflict');
    assert.equal((await get(id)).revision,1);
    assert.ok(JSON.stringify(await get(id)).includes('你好🌍'));
    assert.equal((await save(id,chat('stale'),0)).status,'conflict');
    assert.equal((await save(id,chat('updated'),1)).revision,2);
    await assert.rejects(f.db.query('insert into public.chat_history(user_id,id,payload,payload_bytes,last_operation) values($1,$2,$3,1,$4)',[alice.id,randomUUID(),{},randomUUID()]), /permission denied/);
    await assert.rejects(f.db.query('update public.chat_history set payload=$1', [{}]), /permission denied/);
    await assert.rejects(rpc(f.db,'measure_chat_storage()'), /permission denied/);
    await f.as(bob);
    assert.equal(await get(id),null); assert.equal((await usage()).count,0);
    assert.equal((await f.db.query('select id from public.chat_history')).rows.length,0);
    await rpc(f.db,'delete_chat($1)',[id]);
    await f.as(alice); assert.equal((await usage()).count,1);
    await f.admin(); await f.db.query('delete from auth.sessions where id=$1',[alice.session]);
    await f.as(alice);
    for (const sql of ['chat_history_usage()','list_chat_history()','get_chat_history($1)','delete_chat($1)']) {
      await assert.rejects(rpc(f.db,sql,sql.includes('$1')?[id]:[]), /Authentication required/);
    }
    assert.equal((await f.db.query('select id from public.chat_history')).rows.length,0);
    await f.as(null,'anon');
    await assert.rejects(rpc(f.db,'chat_history_usage()'), /permission denied/);
    await assert.rejects(f.db.query('select * from public.chat_history'), /permission denied/);
  } finally { await f.db.close(); }
});

await check('atomic chat count cap, LRU eviction, protected current chat, pagination, stale deletion and rollback', async () => {
  const f = await fixture();
  try {
    const user = await f.addUser(); await f.as(user);
    const { save, get, usage } = await helpers(f); const ids=[];
    for(let i=0;i<50;i++) { const id=randomUUID(); ids.push(id); assert.equal((await save(id,chat(`message${i}`))).status,'saved'); }
    assert.equal((await usage()).count,50);
    assert.equal((await save(ids[0],chat('oldest is now current'),1)).status,'saved');
    const newId=randomUUID(); const result=await save(newId,chat('newest'));
    assert.equal(result.status,'saved'); assert.deepEqual(result.evicted,[ids[1]]);
    assert.equal(await get(ids[1]),null); assert.ok(await get(ids[0]));
    assert.equal((await save(ids[1],chat('stale offline retry'))).status,'deleted');
    const first=await rpc(f.db,'list_chat_history(null,null,20)');
    assert.equal(first.length,20); assert.equal('messages' in first[0],false);
    const second=await rpc(f.db,'list_chat_history($1,$2,20)',[first.at(-1).cursor,first.at(-1).id]);
    assert.equal(second.length,20); assert.equal(new Set([...first,...second].map(c=>c.id)).size,40);
    await f.db.exec('begin');
    const transient=randomUUID(); const before=await usage();
    assert.equal((await save(transient)).status,'saved');
    await f.db.exec('rollback');
    assert.equal(await get(transient),null); assert.deepEqual(await usage(),before);
    const deleted=ids[0]; await rpc(f.db,'delete_chat($1)',[deleted]);
    assert.equal((await usage()).count,49);
    assert.equal((await save(deleted,chat('delayed in-flight response'),2)).status,'deleted');
    assert.equal(await get(deleted),null);
  } finally { await f.db.close(); }
});

await check('UTF-8 budget includes canonical metadata; whole-chat byte eviction; oversized writes preserve current state', async () => {
  const f = await fixture();
  try {
    const user=await f.addUser(); await f.as(user); const {save,get,usage}=await helpers(f);
    const old=randomUUID(), current=randomUUID();
    await save(old,chat('中'.repeat(300000)));
    await save(current,chat('🌍'.repeat(300000)));
    assert.equal(await get(old),null); assert.equal((await usage()).count,1);
    await f.admin();
    const row=(await f.db.query('select payload_bytes,octet_length(convert_to(payload::text,\'UTF8\')) as actual from public.chat_history where id=$1',[current])).rows[0];
    assert.equal(row.payload_bytes,row.actual); assert.ok(row.actual>1200000);
    await f.as(user); const before=await get(current), beforeUsage=await usage();
    assert.equal((await save(current,chat('🌍'.repeat(500000)),1)).status,'oversized');
    assert.deepEqual(await get(current),before); assert.deepEqual(await usage(),beforeUsage);
    for (const payload of [null,{}, {title:'bad',messages:null}, {title:'bad',messages:[{}]}, {title:'bad',messages:[{id:'m',role:'assistant',content:'not terminal'}]}]) {
      await assert.rejects(save(randomUUID(),payload), /Invalid|terminal/);
    }
    assert.deepEqual(await usage(),beforeUsage);
    const exactId=randomUUID(), exactPayload=chat('');
    await f.admin();
    const overhead=(await f.db.query("select octet_length(convert_to((public.clean_chat_payload($1)||jsonb_build_object('id',$2::uuid))::text,'UTF8')) n",[exactPayload,exactId])).rows[0].n;
    exactPayload.messages[0].content='x'.repeat(2000000-overhead);
    await f.as(user);
    assert.equal((await save(exactId,exactPayload)).status,'saved');
    assert.equal((await usage()).bytes,2000000);
    exactPayload.messages[0].content+='x';
    assert.equal((await save(exactId,exactPayload,1)).status,'oversized');
    assert.equal((await usage()).bytes,2000000);
  } finally { await f.db.close(); }
});

await check('bounded tombstones prevent delete-before-create resurrection, expired retries cannot resurrect, message pages stay bounded', async () => {
  const f=await fixture();
  try {
    const user=await f.addUser(); await f.as(user); const {save,get}=await helpers(f);
    const absent=randomUUID(); await rpc(f.db,'delete_chat($1)',[absent]); await rpc(f.db,'delete_chat($1)',[absent]);
    assert.equal((await save(absent)).status,'deleted','A create delayed until after deletion must not resurrect');
    await f.admin();
    assert.equal((await f.db.query('select count(*)::int n from public.chat_history_deleted')).rows[0].n,1,'Repeated delete is idempotent');
    await f.as(user);
    const existing=randomUUID(); const payload={title:'Paged',messages:Array.from({length:235},(_,i)=>({id:`m${i}`,role:'user',content:`text${i}`}))};
    await save(existing,payload);
    const a=await get(existing), b=await rpc(f.db,'get_chat_history($1,100,1000)',[existing]);
    assert.equal(a.totalMessages,235); assert.equal(a.payload.messages.length,100);
    assert.equal(b.payload.messages.length,100); assert.equal(b.payload.messages[0].id,'m100');
    const old=randomUUID(); await save(old); await rpc(f.db,'delete_chat($1)',[old]);
    await f.admin();
    await f.db.query("update public.chat_history_deleted set deleted_at=now()-interval '49 hours' where id=$1",[old]);
    await rpc(f.db,'measure_chat_storage()');
    assert.equal((await f.db.query('select count(*)::int n from public.chat_history_deleted where id=$1',[old])).rows[0].n,0);
    await f.as(user);
    assert.equal((await save(old,chat('stale create'),0,randomUUID(),new Date(Date.now()-49*3600000).toISOString())).status,'expired');
    assert.equal((await save(old,chat('stale update'),1)).status,'deleted');
    await f.admin();
    await f.db.exec('delete from public.chat_history_deleted');
    await f.db.query("insert into public.chat_history_deleted(user_id,id) select $1,md5('qa'||n)::uuid from generate_series(1,1000) n",[user.id]);
    await f.as(user);
    assert.equal((await save(randomUUID())).status,'create_limited');
    await assert.rejects(rpc(f.db,'delete_chat($1)',[randomUUID()]),/Recent deletion limit reached/);
    await f.admin(); const marker=(await f.db.query('select id from public.chat_history_deleted limit 1')).rows[0].id; await f.as(user);
    await rpc(f.db,'delete_chat($1)',[marker]);
    assert.equal((await save(existing,chat('existing still updates'),1)).status,'saved');
    await rpc(f.db,'delete_chat($1)',[existing]);
    await f.admin();
    assert.ok((await f.db.query('select count(*)::int n from public.chat_history_deleted')).rows[0].n<=1050);
  } finally { await f.db.close(); }
});

await check('database guard warns350MB, blocks400MB, resumes onlybelow350MB; paused saves cannot evict; service role only', async () => {
  const f=await fixture();
  try {
    const user=await f.addUser(); const {save,usage}=await helpers(f); await f.as(user);
    const id=randomUUID(); await save(id); const before=await usage(); await f.admin();
    // Keep the production function body, replacing only PostgreSQL's physical database measurement with a fixture value.
    await f.db.exec('create table public.qa_size(bytes bigint); insert into public.qa_size values(0); create function public.qa_database_bytes() returns bigint language sql as $$select bytes from public.qa_size$$;');
    const original=(await f.db.query("select pg_get_functiondef('public.measure_chat_storage()'::regprocedure) as definition")).rows[0].definition;
    assert.ok(original.includes('pg_catalog.pg_database_size(pg_catalog.current_database())'));
    await f.db.exec(original.replace('pg_catalog.pg_database_size(pg_catalog.current_database())','public.qa_database_bytes()'));
    for(const [size,warning,paused] of [[349999999,false,false],[350000000,true,false],[399999999,true,false],[400000000,true,true],[399999999,true,true],[350000000,true,true],[349999999,false,false]]) {
      await f.db.query('update public.qa_size set bytes=$1',[size]);
      await f.db.exec('set role service_role'); const result=await rpc(f.db,'measure_chat_storage()'); await f.admin();
      assert.equal(result.warning,warning,`${size} warning`); assert.equal(result.paused,paused,`${size} paused`);
    }
    await f.db.exec('update public.qa_size set bytes=400000000'); await f.as(user);
    assert.equal((await save(randomUUID())).status,'paused');
    assert.equal((await usage()).count,before.count); assert.equal((await usage()).bytes,before.bytes);
    await assert.rejects(rpc(f.db,'measure_chat_storage()'),/permission denied/);
  } finally { await f.db.close(); }
});

console.log('Independent QA executed production migrations in PGlite PostgreSQL, with a simulated Supabase auth schema; no hosted changes. Parallel submissions share one serialized PGlite connection, so independent-session locking remains unverified.');
