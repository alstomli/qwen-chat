// Local browser fixture only: no live model, provider, Supabase, or deployment.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAuthFixture } from './auth-test-fixture.mjs';
const { chromium } = await import(process.env.CHAT_TEST_PLAYWRIGHT ? pathToFileURL(resolve(process.env.CHAT_TEST_PLAYWRIGHT)).href : 'playwright-core');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshots = resolve(root, '../images-in-chat/web-search');
const base = 'http://127.0.0.1:3002', token = 'local-web-fixture-credential-'.repeat(3);
const limits = { inputCharacters:120000, outputTokens:10240, contextTokens:40960, historyMessages:799, historyBytes:580000, requestBytes:640000, timeoutSeconds:2400, safetyTokens:4096, reuseCachedPrefixes:true };
const requests = []; let behavior = 'success'; let disconnected = false;
const source = { sourceId:'S1', title:'Fixture source', url:'https://example.com/web-fixture', retrievedAt:'2026-11-10T13:00:00Z', evidenceKind:'page' };
const gateway = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  if (req.url === '/health') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ready:true, model:'qwen', settingsVersion:1, accountQuotaVersion:1, accountQuotasEnforced:true, limits, webSearchVersion:1, webSearchAvailable:true, webSearch:{models:[{useAdapter:false,available:true}]} })); return; }
  let raw=''; for await (const chunk of req) raw+=chunk; const body=JSON.parse(raw); requests.push(body);
  res.setHeader('Content-Type','text/event-stream'); if(body.webSearch)res.setHeader('X-Chat-Web-Search','1'); res.flushHeaders();
  const event=(name,sequence,extra)=>res.write(`event: ${name}\ndata: ${JSON.stringify({version:1,runId:'fixture_'+requests.length,sequence,...extra})}\n\n`);
  const delta=text=>res.write(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`);
  if (!body.webSearch) { delta('Ordinary fixture answer.'); res.end('data: [DONE]\n\n'); return; }
  event('web-status',1,{status:'searching'});
  if (behavior==='slow') { res.on('close',()=>{disconnected=true;}); return; }
  const timer=setTimeout(()=>{
    event('web-sources',2,{sources:[source]}); event('web-status',3,{status:'reading'});
    if (behavior==='failed') { event('web-complete',4,{outcome:'failed'}); res.end('data: [DONE]\n\n'); return; }
    delta('A sourced fixture answer [S1]. Unverified [S9].'); event('web-complete',4,{outcome:'completed'}); res.end('data: [DONE]\n\n');
  },400); res.on('close',()=>clearTimeout(timer));
});
let app,browser,logs=''; const auth=await startAuthFixture(18005);
try {
  await new Promise(r=>gateway.listen(18019,'127.0.0.1',r));
  app=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3002','--webpack'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',CHAT_TEST_DIST_DIR:'.next-integration',NEXT_PUBLIC_SUPABASE_URL:auth.url,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fixture-public-key',RUNPOD_CHAT_URL:'http://127.0.0.1:18019',RUNPOD_CHAT_TOKEN:token,RUNPOD_BF16_CHAT_URL:'',RUNPOD_BF16_CHAT_TOKEN:'',CHAT_PREVIEW_MODE:'false'}});
  app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}assert.ok(ready,logs);
  browser=await chromium.launch({headless:true,channel:'msedge'});const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/sign-in');await page.getByRole('button',{name:'Continue with Google',exact:true}).click();await page.getByRole('button',{name:'Kiddo home',exact:true}).waitFor();
  const toggle=page.getByRole('button',{name:'Search web',exact:true});await toggle.waitFor();await page.waitForFunction(()=>!document.querySelector('.web-search-toggle')?.disabled);
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');await page.getByRole('textbox',{name:'Message Kiddo',exact:true}).fill('Search fixture question');await toggle.click();await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByText('Searching the web…',{exact:true}).waitFor();await page.getByText('Answer with web sources',{exact:true}).waitFor();
  assert.deepEqual(requests[0].webSearch,{version:1,mode:'required'});assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  const citation=page.locator('.web-citation');assert.equal(await citation.getAttribute('href'),source.url);assert.equal(await page.locator('.message.assistant a[href*="S9"]').count(),0);
  await page.locator('.web-sources summary').click();assert.match(await page.locator('.web-sources').innerText(),/example.com/);
  await mkdir(screenshots,{recursive:true});
  for(const [label,width,height] of [['desktop',1440,1000],['mobile',390,844],['narrow',320,720]]){
    await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const box=await toggle.boundingBox();assert.ok(box && box.x>=0 && box.x+box.width<=width,`${label}: search control fits`);
    await page.screenshot({path:resolve(screenshots,label+'.png'),fullPage:true});
  }
  await page.getByRole('textbox',{name:'Message Kiddo',exact:true}).fill('Ordinary follow-up');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText('Ordinary fixture answer.',{exact:true}).waitFor();assert.equal(requests[1].webSearch,undefined);
  behavior='failed';await toggle.click();await page.getByRole('textbox',{name:'Message Kiddo',exact:true}).fill('Failure fixture');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText(/No complete web-backed answer was produced/).waitFor();
  const before=requests.length;await page.getByRole('button',{name:'Try again',exact:true}).last().click();await page.waitForFunction(n=>document.querySelectorAll('.message-note.error').length>0,before);await page.getByRole('button',{name:'Send message',exact:true}).waitFor();assert.equal(requests.at(-1).webSearch.mode,'required');
  behavior='slow';await toggle.click();await page.getByRole('textbox',{name:'Message Kiddo',exact:true}).fill('Stop fixture');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText('Searching the web…',{exact:true}).waitFor();await page.getByRole('button',{name:'Stop generation',exact:true}).click();await page.getByText('You stopped this reply.',{exact:true}).waitFor();
  for(let i=0;i<30&&!disconnected;i++)await new Promise(r=>setTimeout(r,50));assert.equal(disconnected,true);assert.deepEqual(errors,[]);
  console.log('PASS: browser required search, progress, registered citations, three layouts, ordinary follow-up, failed-search retry, and Stop cancellation.');
  console.log('Screenshots: '+screenshots);
} finally {await browser?.close();app?.kill();gateway.closeAllConnections();await new Promise(r=>gateway.close(r));auth.server.closeAllConnections();await new Promise(r=>auth.server.close(r));}
