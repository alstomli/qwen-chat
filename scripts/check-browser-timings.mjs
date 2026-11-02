// Optional real-renderer assertions, called by integration.mjs when CHAT_TEST_PLAYWRIGHT is set.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkBrowserTimings(base, password) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHAT_TEST_BROWSER_CHANNEL ? { channel: process.env.CHAT_TEST_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByLabel('Workspace password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Enter workspace' }).click();
    await page.getByRole('button', { name: 'Your workspace' }).click();
    await page.getByRole('switch', { name: 'Request diagnostics', exact: true }).check();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    const row = (record, label) => record.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd');
    const milliseconds = async (record, label) => {
      const text = await row(record, label).innerText();
      assert.match(text, /ms$/); return Number(text.replaceAll(',', '').replace(' ms', ''));
    };
    const prompt = page.getByRole('textbox', { name: /message/i });
    await prompt.fill('Hello');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Request diagnostics · completed', { exact: true }).waitFor();
    const completed = page.locator('.request-diagnostics').last();
    await completed.locator('summary').click();
    await row(completed, 'first answer rendered').filter({ hasText: /ms$/ }).waitFor();
    const received = await milliseconds(completed, 'first content received');
    const rendered = await milliseconds(completed, 'first answer rendered');
    const ended = await milliseconds(completed, 'response completed');
    assert.ok(rendered >= received, 'First paint must follow receipt');
    assert.ok(rendered < ended, 'First paint should occur while this fixture is still streaming');
    assert.ok(await milliseconds(completed, 'Gateway context fitting') >= 0);
    assert.ok(await milliseconds(completed, 'Upstream request') >= 0);
    await prompt.fill('slow');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Request diagnostics · streaming', { exact: true }).waitFor();
    const stopped = page.locator('.request-diagnostics').last();
    await stopped.locator('summary').click();
    await row(stopped, 'first answer rendered').filter({ hasText: /ms$/ }).waitFor();
    await page.getByRole('button', { name: 'Stop generation' }).click();
    await page.getByText('Request diagnostics · stopped', { exact: true }).waitFor();
    assert.equal(await row(stopped, 'response completed').innerText(), 'Unavailable');
    assert.ok(await milliseconds(stopped, 'request ended') > 0);
    assert.ok(await milliseconds(stopped, 'first content received') > 0);
    assert.equal(await row(stopped, 'Gateway entry → stream end').innerText(), 'Unavailable');
    console.log('PASS: Real browser receives content, paints before completion, and preserves partial timing on Stop');
  } finally { await browser.close(); }
}
