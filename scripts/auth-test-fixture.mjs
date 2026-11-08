// External HTTP fixture only. App code always uses the real Supabase SDK and
// authenticated requests; this emulates Supabase, not a production auth bypass.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
export async function startAuthFixture(password, port = 18005) {
  const users = new Map(); const sessions = new Map();
  const addUser = (email, confirmed = true, secret = password) => {
    const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: confirmed ? new Date().toISOString() : null, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    users.set(email, { user, password: secret }); return user;
  };
  addUser('test@example.com'); addUser('second@example.com');
  const issue = user => {
    const sessionId = randomUUID();
    const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, session_id: sessionId })).toString('base64url'), 'fixture-signature'].join('.');
    const session = { access_token: token, refresh_token: randomUUID(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, user };
    sessions.set(token, session); return session;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info, x-supabase-api-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const reply = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://localhost');
    const session = sessions.get(req.headers.authorization?.replace('Bearer ', ''));
    if (url.pathname === '/auth/v1/token') {
      if (body.auth_code) {
        const account = users.get(body.auth_code);
        if (!account) return reply({ msg: 'Invalid code' }, 400);
        account.user.email_confirmed_at = new Date().toISOString();
        return reply(issue(account.user));
      }
      const account = users.get(body.email);
      if (!account || account.password !== body.password || !account.user.email_confirmed_at) return reply({ msg: 'Invalid credentials', code: 'invalid_credentials' }, 400);
      return reply(issue(account.user));
    }
    if (url.pathname === '/auth/v1/signup') {
      const user = users.get(body.email)?.user ?? addUser(body.email, false, body.password);
      return reply(user);
    }
    if (url.pathname === '/auth/v1/resend' || url.pathname === '/auth/v1/recover') return reply({});
    if (url.pathname === '/auth/v1/user') {
      if (!session) return reply({ msg: 'Invalid token' }, 401);
      if (req.method === 'PUT' && body.password) users.get(session.user.email).password = body.password;
      return reply(session.user);
    }
    if (url.pathname === '/auth/v1/logout') {
      if (url.searchParams.get('scope') === 'global' && session) { for (const [token, other] of sessions) { if (other.user.id === session.user.id) sessions.delete(token); } }
      else sessions.delete(req.headers.authorization?.replace('Bearer ', ''));
      return reply({});
    }
    if (url.pathname === '/rest/v1/rpc/chat_session_active') return reply(!!session?.user.email_confirmed_at);
    return reply({ msg: `Unknown fixture path ${url.pathname}` }, 404);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${port}`, users, sessions };
}
