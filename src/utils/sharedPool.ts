import pg from 'pg';
const { Pool } = pg;

export const sharedPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});
