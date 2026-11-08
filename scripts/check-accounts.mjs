import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
export async function checkAccounts(base, password, fixture, admissionIs) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.CHAT_TEST_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext(); const page = await context.newPage();
  const login = async email => {
    await page.goto(base + '/sign-in');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New conversation' }).waitFor();
  };
  try {
    await page.goto(base + '/create-account');
    if (process.env.CHAT_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.CHAT_TEST_SCREENSHOT_DIR, { recursive: true });
      for (const mode of ['create-account', 'sign-in']) {
        await page.goto(base + '/' + mode);
        for (const [layout, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
          await page.setViewportSize({ width, height });
          await page.screenshot({ path: join(process.env.CHAT_TEST_SCREENSHOT_DIR, `qwen-${mode}-${layout}.png`), fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(base + '/create-account');
    }
    await page.getByLabel('Name', { exact: true }).fill('New user');
    await page.getByLabel('Email', { exact: true }).fill('new@example.com');
    await page.getByLabel('New password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Check your email' }).waitFor();
    assert.equal(fixture.users.get('new@example.com').user.email_confirmed_at, null);
    assert.equal((await context.request.get(base + '/api/status')).status(), 401);
    await page.goto(base + '/sign-in');
    await page.getByLabel('Email', { exact: true }).fill('new@example.com');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: "Couldn't sign in" }).waitFor();
    await page.goto(base + '/auth/confirm?code=new%40example.com');
    await page.getByRole('button', { name: 'New conversation' }).waitFor();
    assert.ok(fixture.users.get('new@example.com').user.email_confirmed_at);
    // Anonymous legacy histories stay unclaimed; seed an account history and
    // switch identity to prove the second account never sees it.
    const id = fixture.users.get('new@example.com').user.id;
    await page.evaluate(({ id }) => {
      localStorage.setItem('qwen-chat.conversations.v1', JSON.stringify([{ id: 'legacy', title: 'Legacy private history', updatedAt: 1, messages: [] }]));
      localStorage.setItem(`qwen-chat.conversations.v1:user:${id}`, JSON.stringify([{ id: 'private', title: 'First account private history', updatedAt: 2, messages: [] }]));
    }, { id });
    await page.reload();
    await page.getByRole('button', { name: 'First account private history', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Legacy private history', exact: true }).count(), 0);
    const otherTab = await context.newPage(); await otherTab.goto(base);
    await otherTab.getByRole('button', { name: 'First account private history', exact: true }).waitFor();
    await otherTab.getByRole('textbox', { name: /message/i }).fill('slow');
    await otherTab.getByRole('button', { name: 'Send message' }).click();
    await otherTab.locator('.message.assistant').getByText(/sample/).waitFor();
    await admissionIs(1, 0);
    await page.getByRole('button', { name: /Your workspace/ }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/sign-in'); await otherTab.waitForURL('**/sign-in');
    await admissionIs(0, 0);
    await login('second@example.com');
    assert.equal(await page.getByRole('button', { name: 'First account private history', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Legacy private history', exact: true }).count(), 0);
    await page.goto(base + '/forgot-password');
    await page.getByLabel('Email', { exact: true }).fill('second@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await page.getByRole('status').filter({ hasText: "If an account exists" }).waitFor();
    await page.goto(base + '/auth/confirm?code=second%40example.com&next=/reset-password');
    await page.getByLabel('New password', { exact: true }).fill(password + '-changed');
    await page.getByLabel('Confirm password', { exact: true }).fill(password + '-changed');
    await page.getByRole('button', { name: 'Save password' }).click();
    await page.waitForURL('**/sign-in');
    assert.equal(fixture.users.get('second@example.com').password, password + '-changed');
    const malicious = await context.request.get(base + '/auth/confirm?code=invalid&next=https://evil.example', { maxRedirects: 0 });
    assert.equal(new URL(malicious.headers().location).origin, base);
    console.log('PASS: Public signup, unverified denial, email callback, account/legacy isolation, cross-tab logout, recovery, and safe callback redirects (HTTP auth fixture)');
  } finally { await browser.close(); }
}
