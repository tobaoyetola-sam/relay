'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 30000,
  // Shows up in pg_stat_activity so the data team can see who holds connections.
  application_name: 'relay',
  // A stuck query must not hold a pool slot forever.
  statement_timeout: 5000,
});

pool.on('error', (err) => {
  console.error('idle database client error:', err.message);
});

module.exports = { pool };
