// Optional real-renderer assertions, called by integration.mjs when CHAT_TEST_PLAYWRIGHT is set.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkBrowserTimings(base, password, admissionIs) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHAT_TEST_BROWSER_CHANNEL ? { channel: process.env.CHAT_TEST_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
    await page.getByLabel('Workspace password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Enter workspace' }).click();
    await page.getByRole('button', { name: 'Model online' }).waitFor();
    await page.getByRole('button', { name: 'Your workspace' }).click();
    await page.locator('.model-settings-section summary').filter({ hasText: 'Qwen3.8-27B-4bit' }).click();
    await page.getByRole('switch', { name: 'Request diagnostics', exact: true }).check();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    const row = (record, label) => record.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
    const milliseconds = async (record, label) => {
      const text = await row(record, label).innerText();
      assert.match(text, /ms$/); return Number(text.replaceAll(',', '').replace(' ms', ''));
    };
    const prompt = page.getByRole('textbox', { name: /message/i });
    async function startSlowReply() {
      await prompt.fill('slow');
      await page.getByRole('button', { name: 'Send message' }).click();
      await page.locator('.message.assistant').getByText(/sample/).waitFor();
    }
    const inProgress = page.getByRole('button', { name: 'slow Reply in progress', exact: true });
    await startSlowReply();
    await page.getByRole('button', { name: /New conversation/ }).click();
    await inProgress.waitFor();
    await startSlowReply();
    await admissionIs(2, 0);
    assert.equal(await inProgress.count(), 2);

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
    console.log('PASS: Two conversations stream in one tab, Stop cancels only the selected reply, and timings stay with each reply');
  } finally { await browser.close(); }
}
