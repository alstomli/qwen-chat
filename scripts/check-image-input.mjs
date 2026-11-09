import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIr+0AAAKLAV1gTX3oAAAAAElFTkSuQmCC', 'base64');
const imageData = 'data:image/png;base64,' + imageBytes.toString('base64');
const imageHeader = 'X-Chat-Image-Accepted';
const imagePrompt = 'Describe the attached fixture image.';
const imageReply = 'Fixture received the image using qwen-bf16-base.';

async function readStream(response) {
  assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: '));
  assert.equal(events.pop()?.trim(), 'data: [DONE]');
  return events.map(line => JSON.parse(line.slice(6)));
}

export async function checkImageInput({ base, gateway, token, headers, authFixture }) {
  const get = path => fetch(base + path, { headers, signal: AbortSignal.timeout(10_000) });
  const post = (url, body, requestHeaders) => fetch(url, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const request = { model: 'bf16', useAdapter: false, messages: [{ role: 'user', content: imagePrompt }], max_tokens: 128 };
  const ask = (body, extraHeaders = {}) => post(base + '/api/chat', body, { ...headers, ...extraHeaders });

  const capabilities = await (await get('/api/status?model=bf16')).json();
  assert.equal(capabilities.ready, true);
  assert.equal(capabilities.imageInputVersion, 1);
  assert.equal(capabilities.imageInput.maxBytes, 262144);
  assert.equal(capabilities.imageInput.maxDimension, 2048);
  assert.equal((await (await get('/api/status?model=4bit')).json()).imageInput, undefined);
  const oldExchange = [{ role: 'user', content: 'An older question.' }, { role: 'assistant', content: 'An older answer.' }];
  const imageResponse = await ask({ ...request, messages: [...oldExchange, ...request.messages], image: imageData }, { 'X-Chat-Diagnostics': '1' });
  const imageEvents = await readStream(imageResponse);
  assert.equal(imageResponse.headers.get(imageHeader), 'true');
  const diagnostic = JSON.parse(imageResponse.headers.get('X-Chat-Diagnostics'));
  assert.equal(diagnostic.gatewayTrimmedMessages, 2);
  assert.equal(diagnostic.inputTokensAfter, 900);
  assert.equal(imageEvents.find(event => event.usage)?.usage.prompt_tokens, diagnostic.inputTokensAfter);
  assert.equal(imageEvents.map(event => event.choices?.[0]?.delta?.content ?? '').join(''), imageReply);

  const textResponse = await ask({ ...request, useAdapter: true });
  const textEvents = await readStream(textResponse);
  assert.equal(textResponse.headers.get(imageHeader), null);
  assert.ok(textEvents.some(event => event.choices?.[0]?.delta?.content === 'Fixture response using qwen-bf16. '));

  for (const input of [
    { ...request, image: 'https://example.invalid/image.png' },
    { ...request, image: [imageData] },
    { ...request, model: '4bit', useAdapter: undefined, image: imageData },
    { ...request, useAdapter: true, image: imageData },
  ]) {
    const rejected = await ask(input);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.get(imageHeader), null);
  }
  const gatewayRejection = await post(gateway + '/v1/chat/completions', {
    ...request, stream: true, image: 'data:image/png;base64,' + imageBytes.subarray(0, 24).toString('base64'),
  }, { Authorization: 'Bearer ' + token, 'X-Chat-User-Id': '33333333-3333-4333-8333-333333333333', 'Content-Type': 'application/json' });
  assert.equal(gatewayRejection.status, 400);
  assert.equal(gatewayRejection.headers.get('X-Chat-Rejection'), 'image_invalid');
  assert.equal(gatewayRejection.headers.get(imageHeader), null);
  console.log('PASS: BF16 vision capability, multimodal tokenizer/generation parity, SSE confirmation, text-only adapter path, and invalid image rejection');

  if (process.env.CHAT_TEST_PLAYWRIGHT) await checkBrowser(base, authFixture);
}

async function checkBrowser(base, authFixture) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true, channel: process.env.CHAT_TEST_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(base);
    authFixture.setNextIdentity('test@example.com');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('bf16');
    assert.equal(await page.getByRole('switch', { name: 'Use trained adapter', exact: true }).count(), 0, 'Adapter toggle remained in the main workspace');
    assert.equal(await page.getByText('Runpod Docs', { exact: true }).count(), 0);
    await page.getByRole('button', { name: /Your workspace/ }).click();
    const bf16Settings = page.locator('details.model-settings-section').filter({ hasText: 'Qwen3.8-27B-bf16' });
    await bf16Settings.locator('summary').focus();
    await page.keyboard.press('Enter');
    const adapter = bf16Settings.getByRole('switch', { name: 'Use trained adapter', exact: true });
    assert.equal(await adapter.isChecked(), true);
    await adapter.focus(); await page.keyboard.press('Space');
    assert.equal(await adapter.isChecked(), false, 'Keyboard did not change the adapter setting');
    if (process.env.CHAT_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.CHAT_TEST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.CHAT_TEST_SCREENSHOT_DIR, 'qwen-bf16-adapter-settings.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.screenshot({ path: join(process.env.CHAT_TEST_SCREENSHOT_DIR, 'qwen-bf16-adapter-settings-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Attach image', exact: true }).waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: imageBytes });
    await page.locator('.composer-attachment').waitFor();
    const prompt = page.getByRole('textbox', { name: 'Message Qwen' });
    const send = page.getByRole('button', { name: 'Send message' });
    const nextChatRequest = () => page.waitForRequest(request => request.url() === base + '/api/chat' && request.method() === 'POST');
    await prompt.fill(imagePrompt);
    const imageRequest = nextChatRequest();
    await send.click();
    const imagePayload = (await imageRequest).postDataJSON();
    assert.equal(imagePayload.model, 'bf16');
    assert.equal(imagePayload.useAdapter, false);
    assert.equal(Object.hasOwn(imagePayload, 'docsMode'), false);
    assert.equal(Object.hasOwn(imagePayload, 'docsPassages'), false);
    assert.match(imagePayload.image, /^data:image\/(?:jpeg|png|webp);base64,/);
    assert.equal(imagePayload.messages.at(-1).content, imagePrompt);
    await page.getByText(imageReply, { exact: true }).waitFor();
    await send.waitFor();

    await page.getByRole('button', { name: /Your workspace/ }).click();
    await bf16Settings.locator('summary').click();
    assert.equal(await adapter.isChecked(), false, 'Settings toggle did not retain the conversation preference');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

    await page.reload();
    await page.getByRole('button', { name: imagePrompt, exact: true }).click();
    await page.getByText(imageReply, { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => !JSON.stringify(localStorage).includes('data:image/')));
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByText('Reattach the original image to retry this message.').waitFor();
    assert.equal(await send.isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel retry', exact: true }).click();

    await prompt.fill('Continue the conversation in text.');
    const textRequest = nextChatRequest();
    await send.click();
    const textPayload = (await textRequest).postDataJSON();
    assert.equal(textPayload.image, undefined);
    assert.ok(textPayload.messages.every(message => typeof message.content === 'string' && !message.content.includes('data:image/')));
    await page.getByText(/Fixture response using qwen-bf16-base/).waitFor();
    await send.waitFor();
    await page.route(`${base}/api/chat`, route => route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"choices":[{"delta":{"content":"Unconfirmed text reply"}}]}\n\ndata: [DONE]\n\n',
    }), { times: 1 });
    await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: imageBytes });
    await page.locator('.composer-attachment').waitFor();
    await prompt.fill('Confirm this attachment reached Qwen.');
    await send.click();
    await page.getByRole('alert').filter({ hasText: 'The model did not confirm receipt of the attached image.' }).waitFor();
    assert.equal(await page.getByText('Unconfirmed text reply', { exact: true }).count(), 0);
    console.log('PASS: Browser image attachment, streamed text, reload and reattach, text-only follow-up, and rollback protection');
  } finally {
    await browser.close();
  }
}
