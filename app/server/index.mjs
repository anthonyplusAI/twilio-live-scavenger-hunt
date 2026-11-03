import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, resolveDatabasePath } from './db.mjs';
import { GameEngine } from './engine.mjs';
import { AuthService } from './auth.mjs';
import { MediaService } from './media.mjs';
import { OpenAIVision } from './openai-vision.mjs';
import { JudgeService } from './judge.mjs';
import { Integrations } from './integrations.mjs';
import { createHttpServer } from './http.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const envPath = resolve(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const port = Number(process.env.PORT || 65111);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
const host = process.env.HOST || '127.0.0.1';
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const databasePath = resolveDatabasePath(root);

const store = openDatabase(databasePath);
const firstEvent = store.seedDefault();
const auth = new AuthService({ store, publicBaseUrl });
auth.bootstrap();
const media = new MediaService({ publicBaseUrl });
const engine = new GameEngine({ store, mediaMode: () => media.mode() });
const vision = new OpenAIVision();
const judge = new JudgeService({ engine, vision });
const integrations = new Integrations({ store, engine, media, publicBaseUrl });
engine.telemetry = integrations;
store.pruneLeads();
store.enqueuePreviouslyUnsentGuides();
const server = createHttpServer({ store, engine, auth, media, judge, integrations,
  publicBaseUrl, defaultSlug: firstEvent.slug });

const retention = setInterval(() => {
  try { store.pruneLeads(); media.pruneFrames(); }
  catch (error) { console.error(`Retention sweep: ${error.message}`); }
}, 60 * 60_000);
retention.unref?.();
const deliveries = setInterval(() => {
  void integrations.processDueDeliveryJobs().catch(error => console.error(`Guide queue: ${error.message}`));
}, 15_000);
deliveries.unref?.();
void integrations.processDueDeliveryJobs().catch(error => console.error(`Guide queue startup: ${error.message}`));
engine.startTicker();

server.listen(port, host, () => {
  console.log(`Live Scavenger Hunt: ${publicBaseUrl}/e/${firstEvent.slug}/arena`);
  console.log(`Operator: ${publicBaseUrl}/e/${firstEvent.slug}/operator`);
  console.log(`Media mode: ${media.mode()}`);
  if (host === '0.0.0.0' && !process.env.PUBLIC_BASE_URL) console.log('Set PUBLIC_BASE_URL so QR codes use a reachable HTTPS address.');
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(retention);
  clearInterval(deliveries);
  engine.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  try { await integrations.close(); } catch (error) { console.error(`Analytics shutdown: ${error.message}`); }
  store.close();
}
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
