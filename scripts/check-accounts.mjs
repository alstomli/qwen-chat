import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
export async function checkAccounts(base, fixture, admissionIs) {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.CHAT_TEST_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext(); const page = await context.newPage();
  const login = async email => {
    fixture.setNextIdentity(email);
    await page.goto(base + '/sign-in');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await page.getByRole('button', { name: 'New conversation' }).waitFor();
  };
  try {
    for (const old of ['/create-account', '/forgot-password', '/reset-password', '/auth/confirm?token_hash=old&type=recovery']) {
      await page.goto(base + old); assert.equal(new URL(page.url()).pathname, '/sign-in');
      assert.equal(await page.locator('input').count(), 0);
    }
    await page.getByRole('link', { name: 'Privacy policy' }).click();
    await page.getByRole('heading', { name: 'How this workspace uses data.' }).waitFor();
    assert.equal((await context.request.get(base + '/api/status')).status(), 401);
    if (process.env.CHAT_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.CHAT_TEST_SCREENSHOT_DIR, { recursive: true });
      for (const mode of ['sign-in', 'privacy']) {
        await page.goto(base + '/' + mode);
        for (const [layout, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 568]]) {
          await page.setViewportSize({ width, height });
          await page.screenshot({ path: join(process.env.CHAT_TEST_SCREENSHOT_DIR, `qwen-google-${mode}-${layout}.png`), fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    fixture.setNextError('access_denied'); await page.goto(base + '/sign-in');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.getByRole('status').filter({ hasText: 'Sign-in was canceled' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue with Google' }).isEnabled(), true);
    for (const email of ['unverified@example.com', 'email-only@example.com']) {
      fixture.setNextIdentity(email); await page.goto(base + '/sign-in');
      await page.getByRole('button', { name: 'Continue with Google' }).click();
      await page.getByRole('alert').filter({ hasText: 'We couldn’t sign you in' }).waitFor();
      assert.equal((await context.request.get(base + '/api/status')).status(), 401);
      await page.goto(base); assert.equal(new URL(page.url()).pathname, '/sign-in');
    }
    // A new Google identity creates an account; the external fixture validates PKCE.
    await login('new@example.com');
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
    for (const query of ['code=invalid&next=https://evil.example', 'next=//evil.example', 'error=server_error&error_description=private-provider-text', 'code=invalid']) {
      const response = await context.request.get(base + '/auth/callback?' + query, { maxRedirects: 0 });
      const location = new URL(response.headers().location);
      assert.equal(location.origin, base); assert.equal(location.pathname, '/sign-in');
      assert.equal(location.searchParams.get('error'), 'google');
      assert.match(response.headers()['cache-control'], /(?:^|,)\s*no-store(?:,|$)/);
    }
    console.log('PASS: Google PKCE signup/sign-in, cancellation, unverified/non-Google denial, account/legacy isolation, cross-tab logout, privacy, retired email routes, safe callback redirects (HTTP fixture)');
  } finally { await browser.close(); }
}
