import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env.local')) {
  console.log('Existing .env.local retained. Configure Supabase using docs/accounts.md.');
} else {
  writeFileSync('.env.local', readFileSync('.env.example'), { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local. Add your Supabase public settings and apply docs/accounts.md before signing in.');
}
