import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : false,
  // Opening a connection to the Supabase pooler costs ~4 s (TLS + auth) vs ~0.4 s per query. The default 10 s idle
  // timeout closed connections during every song, so the score submit at the end paid that again. Keep them open.
  idleTimeoutMillis: 0,
  keepAlive: true,
});

// A pooled connection dropped by the server while idle is removed by pg-pool; without a listener it would crash the process.
pool.on('error', (err) => console.warn('[db] idle client error:', err.message));

export const db = drizzle(pool, { schema });

export type DB = typeof db;
