const env = process.env;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * MariaDB-Verbindung: entweder komplett als DATABASE_URL
 * (mysql://benutzer:passwort@host:3306/datenbank) oder einzeln über DB_HOST, DB_PORT,
 * DB_NAME, DB_USER, DB_PASSWORD – dann dürfen im Passwort auch Sonderzeichen stehen.
 */
function databaseUrl(): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const user = encodeURIComponent(env.DB_USER ?? 'schottr');
  const password = encodeURIComponent(env.DB_PASSWORD ?? 'schottr');
  return `mysql://${user}:${password}@${env.DB_HOST ?? '127.0.0.1'}:${env.DB_PORT ?? '3306'}/${encodeURIComponent(env.DB_NAME ?? 'schottr')}`;
}

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: databaseUrl(),
  /** Registrierung offen lassen? Ohne Benutzer ist die Ersteinrichtung immer möglich. */
  allowRegistration: bool(env.SCHOTTR_ALLOW_REGISTRATION, false),
  /** Cookies nur über HTTPS senden. "auto" = anhand X-Forwarded-Proto bzw. URL. */
  secureCookies: (env.SCHOTTR_SECURE_COOKIES ?? 'auto') as 'auto' | 'true' | 'false',
  sessionDays: Number(env.SCHOTTR_SESSION_DAYS ?? 14),
  /** Hinter einem Reverse-Proxy (z. B. Nginx Proxy Manager) X-Forwarded-For auswerten. */
  trustProxy: bool(env.SCHOTTR_TRUST_PROXY, true),
};
