'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.error(`environment variable ${name} must be an integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

module.exports = {
  port: int('PORT', 8080),
  databaseUrl: required('DATABASE_URL'),
  signingSecret: required('SIGNING_SECRET'),
  // Per-pod pool. The database allows 100 connections in total and that will
  // not change this quarter, so pool size x max pods must stay well under it.
  // See k8s/configmap.yaml for the budget.
  poolMax: int('PG_POOL_MAX', 8),
  archiveBucket: process.env.ARCHIVE_BUCKET || '',
  archiveTimeoutMs: int('ARCHIVE_TIMEOUT_MS', 2000),
  shutdownDelayMs: int('SHUTDOWN_DELAY_MS', 5000),
};
