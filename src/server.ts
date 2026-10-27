import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { openDatabase, closeDatabase } from './db/index.ts';
import { purgeExpiredSessions } from './lib/auth.ts';
import { createApp } from './app.ts';

await openDatabase(config.databaseUrl);
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
