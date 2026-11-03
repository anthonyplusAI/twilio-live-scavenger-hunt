#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, resolveDatabasePath } from '../app/server/db.mjs';
import { AuthService } from '../app/server/auth.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const databasePath = resolveDatabasePath(repoRoot);
const usage = 'Usage: node scripts/create-user.mjs --username NAME [--role admin|operator] [--password-stdin]';
let username = '';
let role = 'operator';
let passwordFromStdin = false;

for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--help' || arg === '-h') {
    console.log(usage + '\nA secure one-time password is generated unless --password-stdin is supplied.');
    process.exit(0);
  }
  if (arg === '--username' && process.argv[index + 1]) username = process.argv[++index];
  else if (arg === '--role' && process.argv[index + 1]) role = process.argv[++index];
  else if (arg === '--password-stdin') passwordFromStdin = true;
  else {
    console.error('Unknown or incomplete argument: ' + arg + '\n' + usage);
    process.exit(1);
  }
}

if (!username) {
  console.error(usage);
  process.exit(1);
}

const generatedPassword = passwordFromStdin ? null : randomBytes(24).toString('base64url');
const password = passwordFromStdin ? readFileSync(0, 'utf8').replace(/\r?\n$/, '') : generatedPassword;
const store = new Store(databasePath);
try {
  const count = store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (!count && role !== 'admin') throw new Error('Create an admin first, or start the server for its one-time initial admin.');
  const auth = new AuthService({ store });
  const user = auth.createUser(username, password, role);
  console.log('Created ' + user.role + ' user: ' + user.username);
  console.log('Database: ' + databasePath);
  if (generatedPassword) {
    console.log('One-time password: ' + generatedPassword);
    console.log('Save this password now. It will not be printed again.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
