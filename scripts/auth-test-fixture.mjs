// External HTTP fixture only. App code always uses the real Supabase SDK.
// Emulates the OAuth redirect/code boundary, including a one-use PKCE challenge.
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
export async function startAuthFixture(port = 18005) {
  const users = new Map(); const sessions = new Map(); const codes = new Map();
  const history = new Map(), deletedHistory = new Map(), historyCalls = [];
  let registrationAvailable = true, historyFailure = false, historyPaused = false;
  const rowsFor = id => { if (!history.has(id)) history.set(id, new Map()); return history.get(id); };
  const deletedFor = id => { if (!deletedHistory.has(id)) deletedHistory.set(id, new Set()); return deletedHistory.get(id); };
  const usageFor = id => ({ bytes: [...rowsFor(id).values()].reduce((sum, row) => sum + row.bytes, 0), count: rowsFor(id).size, maxBytes: 2_000_000, maxCount: 50, paused: historyPaused });
  const orderedFor = id => [...rowsFor(id).values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  let lastHistoryTime = 0;
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
    res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile, prefer');
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
      else if (!registrationAvailable && !users.has(nextEmail)) { redirect.searchParams.set('error', 'server_error'); }
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
    if (url.pathname === '/rest/v1/rpc/registration_capacity') return reply({ available: registrationAvailable });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const rpc = url.pathname.split('/').at(-1);
      historyCalls.push({ rpc, userId: session?.user.id ?? null });
      if (!session?.user.email_confirmed_at || !session.user.identities.some(identity => identity.provider === 'google')) return reply({ code: '42501', message: 'Authentication required' }, 403);
      if (historyFailure) return reply({ code: 'fixture_outage', message: 'History unavailable' }, 503);
      const id = session.user.id, rows = rowsFor(id), deleted = deletedFor(id);
      if (rpc === 'chat_history_usage') return reply(usageFor(id));
      if (rpc === 'list_chat_history') {
        const before = body.p_before ? Date.parse(body.p_before) : null;
        return reply(orderedFor(id).filter(row => before === null || row.updatedAt < before || (row.updatedAt === before && row.id < body.p_before_id))
          .slice(0, Math.max(1, Math.min(body.p_limit ?? 20, 50)))
          .map(row => ({ id: row.id, title: row.payload.title, updatedAt: row.updatedAt, cursor: new Date(row.updatedAt).toISOString(), revision: row.revision, bytes: row.bytes, model: row.payload.model, useAdapter: row.payload.useAdapter })));
      }
      if (rpc === 'get_chat_history') {
        const row = rows.get(body.p_id); if (!row) return reply(null);
        const offset = Math.max(0, body.p_offset ?? 0), limit = Math.max(1, Math.min(body.p_limit ?? 100, 100));
        return reply({ id: row.id, payload: { ...row.payload, messages: row.payload.messages.slice(offset, offset + limit) }, totalMessages: row.payload.messages.length, revision: row.revision, updatedAt: row.updatedAt });
      }
      if (rpc === 'delete_chat') {
        if (!rows.has(body.p_id) && !deleted.has(body.p_id) && deleted.size >= 1000) return reply({ message: 'Recent deletion limit reached. Retry later.' }, 400);
        rows.delete(body.p_id); deleted.add(body.p_id);
        return reply(usageFor(id));
      }
      if (rpc === 'save_chat') {
        const existing = rows.get(body.p_id);
        if (deleted.has(body.p_id) || (!existing && body.p_revision > 0)) return reply({ status: 'deleted' });
        const payload = { ...body.p_payload, id: body.p_id };
        if (!payload.title || !Array.isArray(payload.messages)) return reply({ message: 'Invalid conversation' }, 400);
        if (existing?.operation === body.p_operation) return reply(JSON.stringify(existing.payload) === JSON.stringify(payload)
          ? { status: 'saved', revision: existing.revision, evicted: [], usage: usageFor(id) } : { status: 'conflict', revision: existing.revision });
        if ((existing?.revision ?? 0) !== body.p_revision) return reply({ status: 'conflict', revision: existing?.revision });
        if (!existing && (!body.p_created_at || Date.parse(body.p_created_at) < Date.now() - 86400000)) return reply({ status: 'expired' });
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        if (bytes > 2_000_000) return reply({ status: 'oversized' });
        if (historyPaused) return reply({ status: 'paused' });
        const others = orderedFor(id).filter(row => row.id !== body.p_id).reverse();
        let total = others.reduce((sum, row) => sum + row.bytes, 0), count = others.length;
        const evicted = [];
        while (total + bytes > 2_000_000 || count + 1 > 50) {
          const victim = others.shift(); rows.delete(victim.id); deleted.add(victim.id); evicted.push(victim.id); total -= victim.bytes; count--;
        }
        lastHistoryTime = Math.max(Date.now(), lastHistoryTime + 1);
        const row = { id: body.p_id, payload, bytes, updatedAt: lastHistoryTime, revision: (existing?.revision ?? 0) + 1, operation: body.p_operation };
        rows.set(row.id, row);
        return reply({ status: 'saved', revision: row.revision, evicted, usage: usageFor(id) });
      }
    }
    return reply({ msg: `Unknown fixture path ${url.pathname}` }, 404);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${port}`, users, sessions, issue, addUser, history, historyCalls,
    setNextIdentity(email) { nextEmail = email; }, setNextError(error) { nextError = error; },
    setRegistrationAvailable(value) { registrationAvailable = value; },
    setHistoryFailure(value) { historyFailure = value; }, setHistoryPaused(value) { historyPaused = value; } };
}
