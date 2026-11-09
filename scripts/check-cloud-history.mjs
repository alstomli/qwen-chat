// UI transport checks use the external auth/history HTTP fixture, never hosted Supabase.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function until(test, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function downloadText(page, name) {
  const result = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await result;
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function checkCloudHistory(base, fixture) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.CHAT_TEST_BROWSER_CHANNEL || 'msedge', headless: true });
  const first = await browser.newContext({ acceptDownloads: true });
  const second = await browser.newContext(); const other = await browser.newContext();
  const page = await first.newPage(), device = await second.newPage(), stranger = await other.newPage();
  const suffix = randomUUID().slice(0,8), email = `history-${suffix}@example.com`;
  const online = `Cloud QA ${suffix}`, offline = `Offline QA ${suffix}`, legacy = `Local QA ${suffix}`;
  const login = async (target, identity) => {
    fixture.setNextIdentity(identity); await target.goto(`${base}/sign-in`);
    await target.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await target.getByRole('button', { name: /New conversation/ }).waitFor();
    await target.locator('.history-sync').getByRole('status').filter({hasText:/Saved|unavailable/}).waitFor();
  };
  const send = async text => {
    await page.getByRole('button', { name: /New conversation/ }).click();
    await page.getByRole('textbox', { name: 'Message Kiddo', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('.message.assistant').getByText(/sample|integration fixture/).waitFor();
    await page.getByRole('button', { name: 'Stop generation', exact: true }).waitFor({ state: 'hidden' });
  };
  try {
    fixture.setRegistrationAvailable(true); fixture.setHistoryFailure(false); fixture.setHistoryPaused(false);
    await login(page, email);
    if (process.env.CHAT_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.CHAT_TEST_SCREENSHOT_DIR, { recursive: true });
      for (const [name,width,height] of [['desktop-short',900,600],['mobile-landscape',667,375]]) {
        await page.setViewportSize({width,height});
        const open=page.getByRole('button',{name:'Open sidebar',exact:true}); if(await open.isVisible()) { await open.click(); await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().left>=0); }
        const notice=page.getByRole('button',{name:'Got it',exact:true}); await notice.scrollIntoViewIfNeeded();
        const noticeBox=await notice.boundingBox(); assert.ok(noticeBox && noticeBox.y>=0 && noticeBox.y+noticeBox.height<=height,'First-use dismissal is unreachable');
        await page.screenshot({path:join(process.env.CHAT_TEST_SCREENSHOT_DIR,`qwen-cloud-first-use-${name}.png`),fullPage:true});
        const profile=page.getByRole('button',{name:/Your workspace/}); await profile.scrollIntoViewIfNeeded();
        const profileBox=await profile.boundingBox(); assert.ok(profileBox && profileBox.y>=0 && profileBox.y+profileBox.height<=height,'Account settings are unreachable');
        await page.screenshot({path:join(process.env.CHAT_TEST_SCREENSHOT_DIR,`qwen-cloud-sidebar-footer-${name}.png`),fullPage:true});
      }
      await page.setViewportSize({width:1280,height:900});
    }
    const userId = fixture.users.get(email).user.id, legacyId = randomUUID();
    const rows = () => fixture.history.get(userId) ?? new Map();
    await page.evaluate(({ userId, legacyId, legacy }) => {
      localStorage.setItem(`qwen-chat.conversations.v1:user:${userId}`, JSON.stringify([{
        id: legacyId, title: legacy, updatedAt: 1, messages: [{ id: 'legacy-user', role: 'user', content: 'Local text',
          imageName: 'legacy.png', image: 'BASE64_PRIVATE_IMAGE', diagnostics: { secret: 'PRIVATE_TOKEN' }, docsMode: true },
          { id: 'legacy-answer', role: 'assistant', content: 'Older source answer [1].', state: 'complete',
            docsSources: [{ id: 1, heading: 'Idle timeout', url: 'https://docs.runpod.io/serverless/endpoints/endpoint-configurations#idle-timeout' }] }],
      }]));
    }, { userId, legacyId, legacy });
    await page.reload(); await page.getByRole('button', { name: legacy, exact: true }).waitFor();
    await page.locator('.history-local-note').filter({ hasText: 'This older conversation stays on this browser, including new replies.' }).waitFor();
    await page.getByText('Older source answer [1].', { exact: true }).waitFor();
    assert.equal(await page.locator('.docs-citation').count(), 0, 'Retired source metadata enabled active citation UI');
    assert.equal(await page.getByRole('switch', { name: /Runpod Docs/ }).count(), 0);
    assert.equal(rows().has(legacyId), false);

    // The same Google account can enter while admission is full; a new identity cannot.
    fixture.setRegistrationAvailable(false);
    fixture.setNextIdentity(`rejected-${suffix}@example.com`); await stranger.goto(`${base}/sign-in`);
    await stranger.getByText('Registration is full. Existing users can still sign in.').waitFor();
    assert.equal(await stranger.getByRole('button', { name: 'Continue with Google', exact: true }).isEnabled(), true);
    await stranger.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await stranger.getByRole('alert').filter({ hasText: 'Registration is full' }).waitFor();
    assert.equal(fixture.users.has(`rejected-${suffix}@example.com`), false);
    await login(device, email); fixture.setRegistrationAvailable(true);

    const beforeSaves = fixture.historyCalls.filter(call => call.rpc === 'save_chat' && call.userId === userId).length;
    await send(online);
    await until(() => [...rows().values()].some(row => row.payload.title === online && row.payload.messages.some(message => message.role === 'assistant' && message.state === 'complete')), 'Terminal reply did not sync');
    const onlineRow = [...rows().values()].find(row => row.payload.title === online);
    const saveCount = fixture.historyCalls.filter(call => call.rpc === 'save_chat' && call.userId === userId).length - beforeSaves;
    assert.equal(saveCount, 2, 'A prompt and terminal answer should save twice; token chunks must not write history');
    assert.equal(rows().has(legacyId), false, 'Legacy browser data was uploaded');
    // Focus refresh discovers cloud chats in a second isolated browser profile.
    await device.evaluate(() => window.dispatchEvent(new Event('focus')));
    await device.getByRole('button', { name: online, exact: true }).waitFor();
    await device.getByRole('button', { name: online, exact: true }).click();
    await device.locator('.message.user').getByText(online, { exact: true }).waitFor();
    await device.locator('.message.assistant').getByText(/sample|integration fixture/).waitFor();
    assert.equal(await device.getByRole('button', { name: legacy, exact: true }).count(), 0);
    await login(stranger, `other-history-${suffix}@example.com`);
    assert.equal(await stranger.getByRole('button', { name: online, exact: true }).count(), 0);
    assert.equal(await stranger.getByRole('button', { name: legacy, exact: true }).count(), 0);

    // A history outage cannot block model inference; retry uploads the durable account-local outbox.
    fixture.setHistoryFailure(true); await send(offline);
    await page.getByText('Saved on this browser · Sync pending', { exact: true }).waitFor();
    assert.equal([...rows().values()].some(row => row.payload.title === offline), false);
    const cache = await page.evaluate(userId => localStorage.getItem(`qwen-chat.cloud-history.v1:user:${userId}`), userId);
    assert.ok(cache?.includes(offline), 'Offline conversation missing from durable outbox');
    fixture.setHistoryFailure(false); await page.getByRole('button', { name: 'Retry sync', exact: true }).click();
    await until(() => [...rows().values()].some(row => row.payload.title === offline && row.payload.messages.some(message => message.role === 'assistant' && message.state === 'complete')), 'Explicit sync retry did not recover');

    assert.equal(await page.locator('.history-heading').count(), 1, 'History remained split by storage location');
    assert.match(await page.locator('.history-heading').innerText(), /^HISTORY\s*3$/);
    assert.deepEqual(await page.locator('.history-list .history-item > button:first-child').allTextContents(), [offline, online, legacy]);
    await page.locator('.history-sync').getByText('Cloud history · 2 / 50 chats', { exact: true }).waitFor();
    const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
    await search.fill('QA ' + suffix);
    assert.equal(await page.locator('.history-list .history-item').count(), 3, 'Unified search omitted local or cloud history');
    await search.clear();
    if (process.env.CHAT_TEST_SCREENSHOT_DIR) {
      await page.screenshot({ path: join(process.env.CHAT_TEST_SCREENSHOT_DIR, 'qwen-unified-history.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left >= 0);
      await page.screenshot({ path: join(process.env.CHAT_TEST_SCREENSHOT_DIR, 'qwen-unified-history-mobile.png'), fullPage: true });
      await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    await page.getByRole('button', { name: /Your workspace/ }).click();
    const exported = JSON.parse(await downloadText(page, 'Export JSON'));
    assert.ok(exported.some(chat => chat.id === onlineRow.id && chat.messages.some(message => message.role === 'assistant')));
    assert.ok(exported.some(chat => chat.id === legacyId), 'Export omitted local legacy history');
    const exportedLegacy = exported.find(chat => chat.id === legacyId);
    assert.equal(exportedLegacy.messages[0].docsMode, true);
    assert.equal(exportedLegacy.messages[1].docsSources[0].heading, 'Idle timeout');
    assert.ok(!JSON.stringify(exported).includes('BASE64_PRIVATE_IMAGE')); assert.ok(!JSON.stringify(exported).includes('PRIVATE_TOKEN'));
    const markdown = await downloadText(page, 'Export Markdown');
    assert.ok(markdown.includes(`# ${online}`)); assert.ok(markdown.includes('Image filename: legacy.png; image not included'));
    assert.ok(markdown.includes('[1] Idle timeout: https://docs.runpod.io/'), 'Markdown export dropped historical sources');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: `Delete ${online}`, exact: true }).click();
    await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
    await until(() => !rows().has(onlineRow.id), 'Cloud deletion did not reach server');
    await device.evaluate(() => window.dispatchEvent(new Event('focus')));
    await device.getByRole('button', { name: online, exact: true }).waitFor({ state: 'hidden' });
    assert.equal(rows().has(legacyId), false);
    console.log('PASS: cloud history across browser profiles, prompt/terminal-only saves, local legacy isolation, full-capacity existing login, rejected new signup, cross-account isolation, offline inference/retry, private JSON/Markdown export, cloud deletion/focus refresh (HTTP fixtures; SQL verified separately)');
  } catch (error) {
    console.error('Cloud UI fixture state:', JSON.stringify([...fixture.history].map(([userId, rows]) => ({ userId, rows: [...rows.values()].map(row => ({ id: row.id, title: row.payload.title, revision: row.revision, states: row.payload.messages.map(message => message.state ?? message.role) })) }))));
    console.error('Cloud UI RPC calls:', JSON.stringify(fixture.historyCalls));
    console.error('Cloud UI status:', await page.locator('.history-sync').innerText().catch(() => 'Unavailable'));
    console.error('Cloud UI local entries:', await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('qwen-chat.cloud-history')).map(([key,value]) => ({key,entries:JSON.parse(value).map(entry => ({id:entry.chat.id,title:entry.chat.title,state:entry.state,revision:entry.revision,operation:entry.operation?.id}))}))).catch(() => []));
    throw error;
  } finally {
    fixture.setRegistrationAvailable(true); fixture.setHistoryFailure(false); fixture.setHistoryPaused(false);
    await browser.close();
  }
}
