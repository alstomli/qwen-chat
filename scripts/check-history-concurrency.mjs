// Disposable local PostgreSQL only. No hosted URLs, production dependencies or service credentials.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.env.CHAT_TEST_POSTGRES_DISPOSABLE, 'true', 'Set CHAT_TEST_POSTGRES_DISPOSABLE=true for a disposable local PostgreSQL cluster.');
const driver = await import(process.env.CHAT_TEST_PG ? pathToFileURL(resolve(process.env.CHAT_TEST_PG)).href : 'pg');
const { Client } = driver.default ?? driver;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const database = `history_qa_${Date.now()}_${randomUUID().slice(0,8)}`;
const config = { host: '127.0.0.1', port: Number(process.env.CHAT_TEST_POSTGRES_PORT ?? 55439), user: 'postgres', database: 'postgres', connectionTimeoutMillis: 5000, statement_timeout: 15000, application_name: 'cloud-history-local-qa' };
const connections = [], evidence = { database, migrations: [], checks: [], lockBarriers: [], backendPids: [] };
let control, db;
async function connect(name, dbName = database) {
  const client = new Client({ ...config, database: dbName, application_name: `cloud-history-qa-${name}` });
  await client.connect(); client.qaPid=(await client.query('select pg_backend_pid() pid')).rows[0].pid; connections.push(client); return client;
}
const scalar = async (client, sql, params = []) => (await client.query(sql, params)).rows[0].value;
const rpc = (client, call, params = []) => scalar(client, `select public.${call} as value`, params);
const payload = (text = 'Local concurrency fixture') => ({ title: text.slice(0,80), model: 'bf16', messages: [{ id: randomUUID(), role: 'user', content: text }] });
const save = (client, id, body = payload(), revision = 0, operation = randomUUID()) => rpc(client, 'save_chat($1,$2,$3,$4,$5)', [id,body,revision,operation,new Date().toISOString()]);
const usage = client => rpc(client, 'chat_history_usage()');
const pids = async clients => clients.map(client=>client.qaPid);
async function waitLocks(clients, label) {
  const ids = await pids(clients); const deadline = Date.now()+10000;
  while (Date.now()<deadline) {
    const rows = (await db.query("select pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=any($1::int[])",[ids])).rows;
    if (rows.length===ids.length && rows.every(row=>row.wait_event_type==='Lock' && row.blockers.length)) {
      evidence.lockBarriers.push({label,rows}); return;
    }
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail(`${label}: independent sessions never reached the expected PostgreSQL lock barrier`);
}
async function gated(clients, actions, label) {
  await control.query('begin');
  await control.query('select user_id from public.chat_history_accounts where user_id=$1 for update',[alice.id]);
  const outcomes = Promise.allSettled(actions.map((action,index)=>action(clients[index])));
  try { await waitLocks(clients,label); await control.query('commit'); }
  catch(error) { await control.query('rollback'); await outcomes; throw error; }
  const results = await outcomes;
  assert.ok(results.every(result=>result.status==='fulfilled'),`${label}: unexpected RPC failure ${JSON.stringify(results)}`);
  return results.map(result=>result.value);
}
async function check(name, body) { await body(); evidence.checks.push(name); console.log(`PASS: ${name}`); }
const alice = { id: randomUUID(), session: randomUUID() }, bob = { id: randomUUID(), session: randomUUID() };
async function auth(client, user) {
  await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user.id,session_id:user.session})]);
  await client.query('set role authenticated');
}
try {
  control = await connect('cluster','postgres');
  evidence.version = await scalar(control,'select version() as value');
  for (const role of ['anon','authenticated','service_role']) {
    if (!(await scalar(control,'select exists(select 1 from pg_roles where rolname=$1) as value',[role]))) await control.query(`create role ${role}`);
  }
  await control.query(`create database ${database}`);
  db = await connect('inspector'); control = await connect('barrier');
  await db.query(`create schema auth;
    create table auth.users(id uuid primary key,email text,is_anonymous boolean default false,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users on delete cascade,not_after timestamptz);
    create table auth.identities(id uuid primary key,provider_id text,user_id uuid references auth.users on delete cascade,provider text,identity_data jsonb,email text generated always as(lower(identity_data->>'email')) stored);
    create function auth.jwt() returns jsonb language sql stable as $$select current_setting('request.jwt.claims',true)::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to authenticated,anon; grant execute on function auth.uid(),auth.jwt() to authenticated,anon;`);
  const migrations = (await readdir(resolve(root,'supabase/migrations'))).filter(file=>file.endsWith('.sql')).sort();
  for(const file of migrations) {
    if(file!=='202611080001_accounts.sql' && !(await scalar(db,'select exists(select 1 from auth.users) as value'))) {
      for(let i=0;i<99;i++) await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[i===0?alice.id:i===1?bob.id:randomUUID(),`fixture-${i}@example.com`]);
      for(const [index,user] of [alice,bob].entries()) {
        await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[user.session,user.id]);
        await db.query("insert into auth.identities(id,provider_id,user_id,provider,identity_data) values($1,$2,$1,'google',$3)",[user.id,`google-${index}`,{email:`fixture-${index}@example.com`,email_verified:true}]);
      }
    }
    const sql=await readFile(resolve(root,'supabase/migrations',file),'utf8');
    evidence.migrations.push({file,sha256:createHash('sha256').update(sql).digest('hex')});
    await db.query(sql);
  }
  const workers = await Promise.all(Array.from({length:8},(_,index)=>connect(`worker-${index}`)));
  evidence.backendPids = await pids([db,control,...workers]);
  assert.equal(new Set(evidence.backendPids).size,10,'Connections must have distinct PostgreSQL backend processes');

  await check('eight independent sessions race the 100th account; exactly one commits and counter stays exact',async()=>{
    await control.query('begin'); await control.query('select * from public.registration_slots for update');
    const candidates = workers.map(()=>randomUUID());
    const pending = Promise.allSettled(workers.map((worker,index)=>worker.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[candidates[index],`race-${index}@example.com`])));
    try { await waitLocks(workers,'100th signup, eight blocked backends'); await control.query('commit'); }
    catch(error) { await control.query('rollback'); await pending; throw error; }
    const outcomes = await pending;
    assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
    assert.ok(outcomes.filter(result=>result.status==='rejected').every(result=>result.reason.code==='P0001' && /Registration is full/.test(result.reason.message)));
    assert.equal(await scalar(db,'select count(*)::int as value from auth.users'),100);
    assert.equal(await scalar(db,'select accounts as value from public.registration_slots'),100);
    await auth(workers[0],alice); assert.equal(await rpc(workers[0],'chat_session_active()'),true); await workers[0].query('reset role');
    const winner = candidates[outcomes.findIndex(result=>result.status==='fulfilled')];
    await db.query('delete from auth.users where id=$1',[winner]);
    evidence.signup={contenders:8,accepted:1,rejected:7,accountsAfterRace:100,accountsAfterDelete:await scalar(db,'select accounts as value from public.registration_slots')};
  });
  await check('a waiting signup acquires a rolled-back 100th slot without leakage; deletion reopens admission',async()=>{
    const abandoned=randomUUID(), replacement=randomUUID();
    await workers[0].query('begin'); await workers[0].query('insert into auth.users(id,email) values($1,$2)',[abandoned,'abandoned@example.com']);
    const pending=workers[1].query('insert into auth.users(id,email) values($1,$2)',[replacement,'replacement@example.com']);
    await waitLocks([workers[1]],'signup rollback wakes waiting registration'); await workers[0].query('rollback'); await pending;
    assert.equal(await scalar(db,'select exists(select 1 from auth.users where id=$1) as value',[abandoned]),false);
    assert.equal(await scalar(db,'select count(*)::int as value from auth.users'),100);
    assert.equal(await scalar(db,'select accounts as value from public.registration_slots'),100);
    await db.query('delete from auth.users where id=$1',[replacement]); assert.equal((await rpc(db,'registration_capacity()')).available,true);
  });
  await db.query('delete from auth.users where id<>all($1::uuid[])',[[alice.id,bob.id]]);
  await Promise.all(workers.map(worker=>auth(worker,alice)));
  const seeds=[];
  for(let i=0;i<50;i++) { const id=randomUUID(); seeds.push(id); assert.equal((await save(workers[0],id,payload(`seed-${i}`))).status,'saved'); }
  await check('eight concurrent saves atomically maintain 50 chats, evict distinct oldest chats and never their current chat',async()=>{
    const ids=workers.map(()=>randomUUID());
    const results=await gated(workers,ids.map(id=>worker=>save(worker,id)), 'eight quota saves, eight blocked backends');
    results.forEach((result,index)=>{assert.equal(result.status,'saved');assert.equal(result.usage.count,50);assert.ok(result.usage.bytes<=2000000);assert.equal(result.evicted.length,1);assert.ok(!result.evicted.includes(ids[index]));});
    assert.equal(new Set(results.flatMap(result=>result.evicted)).size,8);
    assert.deepEqual(new Set(results.flatMap(result=>result.evicted)),new Set(seeds.slice(0,8)));
    assert.equal(await scalar(db,'select count(*)::int as value from public.chat_history where user_id=$1',[alice.id]),50);
    assert.equal(await scalar(db,'select count(*)::int as value from public.chat_history where user_id=$1 and id=any($2::uuid[])',[alice.id,ids]),8);
    evidence.quota={concurrentSaves:8,finalChatCount:50,distinctOldestEvictions:8};
  });
  const target=seeds.at(-1), competing=[payload('writer A'),payload('writer B')], operations=[randomUUID(),randomUUID()]; let winning;
  await check('same-revision concurrent writers produce one saved revision and one conflict; concurrent identical retries do not advance it',async()=>{
    const results=await gated(workers.slice(0,2),competing.map((body,index)=>worker=>save(worker,target,body,1,operations[index])),'same revision writers');
    assert.deepEqual(results.map(result=>result.status).sort(),['conflict','saved']); winning=results.findIndex(result=>result.status==='saved');
    assert.equal((await rpc(workers[0],'get_chat_history($1)',[target])).revision,2);
    const replay=await gated(workers.slice(0,2),[0,1].map(()=>worker=>save(worker,target,competing[winning],1,operations[winning])),'identical retry writers');
    assert.ok(replay.every(result=>result.status==='saved' && result.revision===2 && result.evicted.length===0));
  });
  await check('delete-before-update and update-before-delete serialize, and stale updates never resurrect deleted conversations',async()=>{
    await workers[0].query('begin'); await rpc(workers[0],'delete_chat($1)',[target]);
    const pending=save(workers[1],target,payload('stale update'),2); await waitLocks([workers[1]],'delete before stale update');
    await workers[0].query('commit'); assert.equal((await pending).status,'deleted');
    const id=seeds.at(-2); await workers[0].query('begin'); assert.equal((await save(workers[0],id,payload('update first'),1)).status,'saved');
    const deletion=rpc(workers[1],'delete_chat($1)',[id]); await waitLocks([workers[1]],'update before delete'); await workers[0].query('commit'); await deletion;
    assert.equal(await rpc(workers[0],'get_chat_history($1)',[id]),null); assert.equal((await save(workers[0],id,payload('stale retry'),1)).status,'deleted');
  });
  await check('delete-before-initial-create and initial-create-before-delete cannot resurrect an uncertain conversation',async()=>{
    const id=randomUUID(); await workers[0].query('begin'); await rpc(workers[0],'delete_chat($1)',[id]);
    const delayed=save(workers[1],id); await waitLocks([workers[1]],'missing-ID delete before delayed initial create'); await workers[0].query('commit'); assert.equal((await delayed).status,'deleted');
    const second=randomUUID(); await workers[0].query('begin'); assert.equal((await save(workers[0],second)).status,'saved');
    const remove=rpc(workers[1],'delete_chat($1)',[second]); await waitLocks([workers[1]],'unacknowledged initial create before delete'); await workers[0].query('commit'); await remove;
    assert.equal((await save(workers[0],second)).status,'deleted'); assert.equal(await rpc(workers[0],'get_chat_history($1)',[second]),null);
  });
  await db.query('delete from public.chat_history where user_id=$1',[alice.id]);
  await check('three concurrent Unicode saves enforce the metadata-inclusive 2,000,000-byte budget with whole-chat eviction',async()=>{
    const ids=workers.slice(0,3).map(()=>randomUUID());
    const results=await gated(workers.slice(0,3),ids.map(id=>worker=>save(worker,id,payload('中'.repeat(250000)))),'Unicode byte quota writers');
    results.forEach((result,index)=>{assert.equal(result.status,'saved');assert.ok(result.usage.bytes<=2000000);assert.ok(!result.evicted.includes(ids[index]));});
    assert.equal((await usage(workers[0])).count,2);
    const bytes=await scalar(db,"select sum(octet_length(convert_to(payload::text,'UTF8')))::int as value from public.chat_history where user_id=$1",[alice.id]);
    assert.equal((await usage(workers[0])).bytes,bytes); assert.ok(bytes>1500000 && bytes<=2000000);
    evidence.bytes={concurrentUnicodeSaves:3,finalChatCount:2,canonicalUtf8Bytes:bytes};
  });
  await check('rolled-back large save restores evicted conversations before a waiting writer proceeds',async()=>{
    const before=(await db.query('select id from public.chat_history where user_id=$1 order by id',[alice.id])).rows.map(row=>row.id);
    const markerCount=await scalar(db,'select count(*)::int as value from public.chat_history_deleted where user_id=$1',[alice.id]);
    const aborted=randomUUID(); await workers[0].query('begin'); const candidate=await save(workers[0],aborted,payload('x'.repeat(1900000))); assert.equal(candidate.evicted.length,2);
    const successor=randomUUID(), pending=save(workers[1],successor); await waitLocks([workers[1]],'quota rollback before waiting save'); await workers[0].query('rollback'); assert.equal((await pending).status,'saved');
    assert.equal(await scalar(db,'select exists(select 1 from public.chat_history where user_id=$1 and id=$2) as value',[alice.id,aborted]),false);
    assert.equal(await scalar(db,'select count(*)::int as value from public.chat_history where user_id=$1 and id=any($2::uuid[])',[alice.id,before]),2);
    assert.equal(await scalar(db,'select count(*)::int as value from public.chat_history_deleted where user_id=$1',[alice.id]),markerCount);
  });
  await check('a second account writes while the first account is locked, and RLS isolates both real sessions',async()=>{
    await auth(workers[7],bob); await control.query('begin'); await control.query('select user_id from public.chat_history_accounts where user_id=$1 for update',[alice.id]);
    const pending=save(workers[0],randomUUID()); await waitLocks([workers[0]],'Alice account held while Bob writes');
    const bobId=randomUUID(); assert.equal((await save(workers[7],bobId,payload('Bob private'))).status,'saved');
    assert.equal(await rpc(workers[1],'get_chat_history($1)',[bobId]),null);
    const bobRows=(await workers[7].query('select user_id from public.chat_history')).rows; assert.ok(bobRows.length && bobRows.every(row=>row.user_id===bob.id));
    await control.query('commit'); assert.equal((await pending).status,'saved');
  });
  evidence.passed=true;
  if(process.env.CHAT_TEST_POSTGRES_EVIDENCE) await writeFile(resolve(process.env.CHAT_TEST_POSTGRES_EVIDENCE),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  // Every connection and the generated database belongs exclusively to this run.
  await Promise.allSettled(connections.map(client=>client.end()));
  const cleanup=new Client(config);
  try { await cleanup.connect(); assert.match(database,/^history_qa_\d+_[a-f0-9]{8}$/); await cleanup.query(`drop database if exists ${database} with (force)`); }
  finally { await cleanup.end(); }
}
