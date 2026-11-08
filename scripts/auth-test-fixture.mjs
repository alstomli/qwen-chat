// External HTTP fixture only. App code always uses the real Supabase SDK.
// Emulates the OAuth redirect/code boundary, including a one-use PKCE challenge.
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
export async function startAuthFixture(port = 18005) {
  const users = new Map(); const sessions = new Map(); const codes = new Map();
  let nextEmail = 'test@example.com', nextError = '';
  const addUser = (email, confirmed = true, google = true) => {
    const id = randomUUID(), now = new Date().toISOString();
    const user = { id, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: confirmed ? now : null,
      identities: google ? [{ id: randomUUID(), identity_id: randomUUID(), user_id: id, provider: 'google', identity_data: { email, email_verified: confirmed }, created_at: now, updated_at: now }] : [],
      app_metadata: {}, user_metadata: { full_name: 'Fixture user' }, created_at: now };
    users.set(email, { user }); return user;
  };
  addUser('test@example.com'); addUser('second@example.com');
  addUser('unverified@example.com', false); addUser('email-only@example.com', true, false);
  const issue = user => {
    const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, session_id: randomUUID() })).toString('base64url'), 'fixture-signature'].join('.');
    const session = { access_token: token, refresh_token: randomUUID(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, user };
    sessions.set(token, session); return session;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info, x-supabase-api-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const reply = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://localhost');
    const session = sessions.get(req.headers.authorization?.replace('Bearer ', ''));
    if (url.pathname === '/auth/v1/authorize') {
      if (url.searchParams.get('provider') !== 'google' || url.searchParams.get('code_challenge_method') !== 's256') return reply({ msg: 'Google PKCE required' }, 400);
      const scopes = new Set((url.searchParams.get('scopes') ?? '').split(' '));
      if (scopes.size !== 3 || !['openid', 'email', 'profile'].every(scope => scopes.has(scope))) return reply({ msg: 'Unexpected OAuth scopes' }, 400);
      const redirect = new URL(url.searchParams.get('redirect_to'));
      if (redirect.origin !== 'http://127.0.0.1:3002' || redirect.pathname !== '/auth/callback') return reply({ msg: 'Redirect rejected' }, 400);
      if (nextError) { redirect.searchParams.set('error', nextError); nextError = ''; }
      else {
        const user = users.get(nextEmail)?.user ?? addUser(nextEmail);
        const code = randomUUID(); codes.set(code, { user, challenge: url.searchParams.get('code_challenge') });
        redirect.searchParams.set('code', code);
      }
      res.statusCode = 302; res.setHeader('Location', redirect.href); res.end(); return;
    }
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') !== 'pkce') return reply({ msg: 'Password auth disabled' }, 400);
      const exchange = codes.get(body.auth_code); codes.delete(body.auth_code);
      const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (!exchange || !body.code_verifier || exchange.challenge !== challenge) return reply({ msg: 'Invalid code or verifier' }, 400);
      return reply(issue(exchange.user));
    }
    if (url.pathname === '/auth/v1/user') return session ? reply(session.user) : reply({ msg: 'Invalid token' }, 401);
    if (url.pathname === '/auth/v1/logout') { sessions.delete(req.headers.authorization?.replace('Bearer ', '')); return reply({}); }
    if (url.pathname === '/rest/v1/rpc/chat_session_active') return reply(!!session?.user.email_confirmed_at && session.user.identities.some(identity => identity.provider === 'google'));
    return reply({ msg: `Unknown fixture path ${url.pathname}` }, 404);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${port}`, users, sessions, issue, setNextIdentity(email) { nextEmail = email; }, setNextError(error) { nextError = error; } };
}
