'use strict';

const crypto = require('node:crypto');
const express = require('express');

const config = require('./config');
const { pool } = require('./db');

// ---------------------------------------------------------------- logging

// Access logs go to stdout as JSON lines so the platform collects them.
// (They used to go to a file inside the container: invisible to
// `kubectl logs` and growing without bound on the node's disk.)
function logRequest(req, res, startedAt) {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      key: req.get('Idempotency-Key') || null,
    }) + '\n',
  );
}

function logError(msg, fields) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg, ...fields }) + '\n');
}

// ---------------------------------------------------------------- archive

let s3 = null;

async function archive(id, payload) {
  if (!config.archiveBucket) return;
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  // No explicit credentials: the SDK picks them up from the environment.
  // Bounded timeout so a slow S3 call cannot pin a request open.
  if (!s3) s3 = new S3Client({ requestHandler: { requestTimeout: config.archiveTimeoutMs } });
  await s3.send(
    new PutObjectCommand({
      Bucket: config.archiveBucket,
      Key: `events/${id}.json`,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
    }),
  );
}

// -------------------------------------------------------------------- app

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let shuttingDown = false;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  // While draining, tell keep-alive clients to reconnect elsewhere. Closing
  // their idle sockets instead races with requests already on the wire and
  // shows up as ECONNRESET (seen: 19 resets during a rollout at 400 rps).
  if (shuttingDown) res.set('Connection', 'close');
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));
  next();
});

// Liveness: is the process able to serve at all? Deliberately does NOT touch
// the database, so a database blip does not get every pod restarted at once.
app.get('/livez', (req, res) => res.json({ status: 'ok' }));

// Readiness: should this pod receive traffic? Fails while draining on shutdown
// and when the database is unreachable. /health is kept as an alias because
// the ALB target group health check uses it.
async function ready(req, res) {
  if (shuttingDown) return res.status(503).json({ status: 'shutting down' });
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
}
app.get('/readyz', ready);
app.get('/health', ready);

app.post('/events', async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }
  // Without this, a non-JSON body was silently stored as {} with a 201.
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  const payload = req.body;
  if (payload === null || typeof payload !== 'object') {
    return res.status(400).json({ error: 'body must be a JSON object or array' });
  }

  const id = crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', config.signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex');

  // Idempotency is enforced by the database's unique index, not by a
  // per-process memory map. The map only knew about keys this one pod had
  // seen, so with more than one pod (or after any restart) a replay hit the
  // unique index and returned 500 instead of 409. It also held every payload
  // forever, which is what OOM-killed the pod.
  let stored;
  try {
    const result = await pool.query(
      `INSERT INTO events (id, idempotency_key, payload, signature)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [id, key, payload, signature],
    );
    if (result.rowCount === 0) {
      const { rows } = await pool.query('SELECT id FROM events WHERE idempotency_key = $1', [key]);
      return res.status(409).json({ id: rows[0] ? rows[0].id : null, duplicate: true });
    }
    stored = true;
  } catch (err) {
    logError('failed to store event', { err: err.message, key });
    return res.status(500).json({ error: 'internal error' });
  }

  // The event is durably stored at this point. If the archive write fails we
  // still answer 201: answering 500 would make the client retry, the retry
  // would get 409, and the archive would never be written anyway. The error
  // is logged with the id so it can be backfilled. (Proper fix: outbox.)
  if (stored) {
    try {
      await archive(id, payload);
    } catch (err) {
      logError('archive failed', { err: err.message, id });
    }
  }
  res.status(201).json({ id, signature });
});

app.get('/events/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const { rows } = await pool.query(
      'SELECT id, idempotency_key, payload, signature, received_at FROM events WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    logError('failed to read event', { err: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

const server = app.listen(config.port, () => {
  console.log(`relay listening on :${config.port} (pool max ${config.poolMax})`);
});

// Keep idle connections open longer than the ALB's 60s idle timeout, or the
// ALB will occasionally reuse a socket Node has just closed and return a 502.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// ---------------------------------------------------------------- shutdown

// On SIGTERM: fail readiness, keep serving for a short drain window while
// endpoints/kube-proxy catch up, then stop accepting, finish in-flight
// requests and close the pool. Without this, Node died mid-request on every
// rollout and scale-in.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`relay: ${signal} received, draining for ${config.shutdownDelayMs}ms`);
  setTimeout(() => {
    server.close(async () => {
      await pool.end().catch(() => {});
      console.log('relay: shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  }, config.shutdownDelayMs);
  // Hard stop well inside terminationGracePeriodSeconds.
  setTimeout(() => process.exit(1), config.shutdownDelayMs + 15_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
