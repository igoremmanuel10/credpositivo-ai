import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://credpositivo:credpositivo@localhost:5432/credpositivo_agent',
  });

  try {
    const migrationsDir = resolve(__dirname, 'migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      console.log(`Running migration: ${file}`);
      const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
      await pool.query(sql);
      console.log(`  ✓ ${file} completed`);
    }

    console.log('All migrations completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
