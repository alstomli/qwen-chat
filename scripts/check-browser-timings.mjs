// Optional real-renderer assertions, called by integration.mjs when CHAT_TEST_PLAYWRIGHT is set.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkBrowserTimings(base, authFixture, admissionIs) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHAT_TEST_BROWSER_CHANNEL ? { channel: process.env.CHAT_TEST_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
    authFixture.setNextIdentity('timings@example.com');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await page.getByRole('button', { name: 'Model online' }).waitFor();
    await page.getByRole('button', { name: 'Your workspace' }).click();
    const settings = page.locator('details.model-settings-section').filter({ hasText: 'Qwen3.8-27B-4bit' });
    await settings.locator('summary').click();
    await settings.getByRole('switch', { name: 'Request diagnostics', exact: true }).check();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    const row = (record, label) => record.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
    const milliseconds = async (record, label) => {
      const text = await row(record, label).innerText();
      assert.match(text, /ms$/); return Number(text.replaceAll(',', '').replace(' ms', ''));
    };
    const prompt = page.getByRole('textbox', { name: /message/i });
    async function startSlowReply(waitForContent = true) {
      await prompt.fill('slow');
      await page.getByRole('button', { name: 'Send message' }).click();
      if (waitForContent) await page.locator('.message.assistant').getByText(/sample/).waitFor();
    }
    // A distinct verified account can use the second global slot while this
    // account's second conversation remains queued.
    const peerContext = await browser.newContext();
    const peerUser = authFixture.users.get('peer-timings@example.com')?.user ?? authFixture.addUser('peer-timings@example.com');
    const peerSession = authFixture.issue(peerUser);
    await peerContext.addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + Buffer.from(JSON.stringify(peerSession)).toString('base64url'), url: base }]);
    const peerPage = await peerContext.newPage();
    peerPage.on('pageerror', error => pageErrors.push(error.message));
    await peerPage.goto(base);
    await peerPage.getByRole('button', { name: 'Model online' }).waitFor();

    const inProgress = page.getByRole('button', { name: 'slow Reply in progress', exact: true });
    await startSlowReply();
    await page.getByRole('button', { name: /New conversation/ }).click();
    await inProgress.waitFor();
    await startSlowReply(false);
    await admissionIs(1, 1);
    assert.equal(await inProgress.count(), 2);

    await peerPage.getByRole('textbox', { name: /message/i }).fill('slow');
    await peerPage.getByRole('button', { name: 'Send message' }).click();
    await peerPage.locator('.message.assistant').getByText(/sample/).waitFor();
    await admissionIs(2, 1);
    await peerPage.getByRole('button', { name: 'Stop generation' }).click();
    await admissionIs(1, 1);
    await peerContext.close();

    await page.getByRole('button', { name: /New conversation/ }).click();
    await prompt.fill('capacity retry prompt');
    const rejection = page.waitForResponse(response => response.url().endsWith('/api/chat') && response.status() === 429);
    await page.getByRole('button', { name: 'Send message' }).click();
    assert.equal((await rejection).headers()['x-chat-rejection'], 'user_capacity');
    await page.getByText(/Your account already has requests in progress/).waitFor();
    await prompt.fill('Keep this new draft');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    assert.equal(await prompt.inputValue(), 'Keep this new draft');
    assert.equal(await page.locator('.message.user').getByText('capacity retry prompt', { exact: true }).count(), 1);
    await admissionIs(1, 1);

    // The oldest conversation is still active; stopping it must promote exactly
    // the queued conversation, without affecting either conversation's timings.
    await inProgress.nth(1).click();

    const stopped = page.locator('.request-diagnostics').last();
    await stopped.locator('summary').click();
    await row(stopped, 'first answer rendered').filter({ hasText: /ms$/ }).waitFor();
    await page.getByRole('button', { name: 'Stop generation' }).click();
    await page.getByText('Request diagnostics · stopped', { exact: true }).waitFor();
    assert.equal(await row(stopped, 'response completed').innerText(), 'Unavailable');
    assert.ok(await milliseconds(stopped, 'request ended') > 0);
    assert.ok(await milliseconds(stopped, 'first content received') > 0);
    assert.equal(await row(stopped, 'Gateway entry → stream end').innerText(), 'Unavailable');

    await admissionIs(1, 0);
    await inProgress.click();
    await page.getByRole('button', { name: 'Stop generation' }).waitFor();
    await page.getByText('Request diagnostics · completed', { exact: true }).waitFor();
    const completed = page.locator('.request-diagnostics').last();
    await completed.locator('summary').click();
    const received = await milliseconds(completed, 'first content received');
    const rendered = await milliseconds(completed, 'first answer rendered');
    const ended = await milliseconds(completed, 'response completed');
    assert.ok(rendered >= received, 'First paint must follow receipt');
    assert.ok(rendered < ended, 'First paint should occur while this fixture is still streaming');
    assert.ok(await milliseconds(completed, 'Gateway context fitting') >= 0);
    assert.ok(await milliseconds(completed, 'Upstream request') >= 0);
    await admissionIs(0, 0);
    assert.deepEqual(pageErrors, []);
    console.log('PASS: Same-account conversations serialize, a distinct account streams in parallel, quota rejection preserves a new draft, and Stop/timings stay with each reply');
  } finally { await browser.close(); }
}
