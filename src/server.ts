import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { openDatabase, closeDatabase } from './db/index.ts';
import { purgeExpiredSessions } from './lib/auth.ts';
import { createApp } from './app.ts';
import { checkStorage } from './lib/files.ts';
import { migrateProofBlobs } from './modules/proofs.ts';

try {
  await checkStorage();
} catch (err) {
  console.error(`\n*** Schottr startet nicht ***\n${(err as Error).message}\n`);
  process.exit(1);
}
await openDatabase(config.databaseUrl);
await migrateProofBlobs();
await purgeExpiredSessions();
setInterval(() => purgeExpiredSessions().catch(console.error), 6 * 3_600_000).unref();

const app = createApp();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Schottr läuft auf http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => closeDatabase().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
