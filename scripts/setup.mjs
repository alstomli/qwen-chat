import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (existsSync('.env.local')) {
  console.log('Existing .env.local retained. Your credentials have not changed.');
} else {
  const password = randomBytes(18).toString('base64url');
  const session = randomBytes(32).toString('hex');
  const gatewayToken = randomBytes(32).toString('hex');
  writeFileSync('.env.local', `CHAT_PASSWORD=${password}\nSESSION_SECRET=${session}\nRUNPOD_CHAT_URL=\nRUNPOD_CHAT_TOKEN=${gatewayToken}\nMODEL_NAME=qwen\nCHAT_PREVIEW_MODE=true\n`, { flag: 'wx', mode: 0o600 });
  mkdirSync('.local', { recursive: true });
  writeFileSync('.local/login.txt', `Local URL: http://127.0.0.1:3001\nWorkspace password: ${password}\n\nLocal preview is enabled. Sample replies do not call Runpod.\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local and .local/login.txt. Credentials were not printed.');
}
