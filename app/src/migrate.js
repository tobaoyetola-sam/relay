'use strict';

const { Client } = require('pg');
const config = require('./config');

const migrations = [
  {
    version: 1,
    name: 'create events',
    sql: `
      CREATE TABLE events (
        id              uuid PRIMARY KEY,
        idempotency_key text NOT NULL,
        payload         jsonb NOT NULL,
        received_at     timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    version: 2,
    name: 'add signature and backfill',
    // The backfill takes a few seconds against production-sized data.
    // pg_sleep stands in for that here so local runs behave the same way.
    sql: `
      SELECT pg_sleep(2);
      ALTER TABLE events ADD COLUMN signature text;
      UPDATE events SET signature = '' WHERE signature IS NULL`,
  },
  {
    version: 3,
    name: 'unique idempotency key',
    sql: `CREATE UNIQUE INDEX events_idempotency_key ON events (idempotency_key)`,
  },
];

// Arbitrary constant; every relay migrator takes the same lock.
const LOCK_ID = 727_001;

async function main() {
  const client = new Client({
    connectionString: config.databaseUrl,
    application_name: 'relay-migrate',
  });
  await client.connect();

  // Several pods can start at once (rollout surge, HPA scale-out). Without a
  // lock they all raced to apply the same migrations and the losers crashed
  // with "relation already exists". Only one migrator runs at a time; the
  // others wait, then find nothing left to do.
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      console.log(`migrate: applying ${m.version} (${m.name})`);
      // Each migration and its bookkeeping row commit together, so a crash
      // half way through cannot leave a migration applied but unrecorded.
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
    console.log('migrate: up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error('migrate: failed:', err.message);
  process.exit(1);
});
