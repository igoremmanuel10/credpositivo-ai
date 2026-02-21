/**
 * One-time migration: Hash existing plaintext passwords in managers table with bcrypt.
 * Run inside the agent container: node src/db/migrate-passwords.js
 */
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migratePasswords() {
  console.log('[Migration] Starting password hash migration for managers...');

  const { rows: managers } = await pool.query('SELECT id, email, senha FROM managers');
  console.log(`[Migration] Found ${managers.length} managers`);

  let migrated = 0;
  let skipped = 0;

  for (const manager of managers) {
    // Skip if already hashed (bcrypt hashes start with $2a$ or $2b$)
    if (manager.senha && manager.senha.startsWith('$2')) {
      console.log(`[Migration] Skipping ${manager.email} — already hashed`);
      skipped++;
      continue;
    }

    const hashed = await bcrypt.hash(manager.senha, 10);
    await pool.query('UPDATE managers SET senha = $1 WHERE id = $2', [hashed, manager.id]);
    console.log(`[Migration] Hashed password for ${manager.email}`);
    migrated++;
  }

  console.log(`[Migration] Done. Migrated: ${migrated}, Skipped: ${skipped}`);
  await pool.end();
  process.exit(0);
}

migratePasswords().catch(err => {
  console.error('[Migration] Fatal error:', err);
  process.exit(1);
});
