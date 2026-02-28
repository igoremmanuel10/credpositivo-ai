// Migration script: sync existing leads to Krayin CRM
// Run inside agent container: node /tmp/migrate-krayin.js

import 'dotenv/config';

const KRAYIN_URL = process.env.KRAYIN_API_URL || 'http://krayin:80';
const KRAYIN_TOKEN = process.env.KRAYIN_API_TOKEN;
const DB_URL = process.env.DATABASE_URL;

import pg from 'pg';
const pool = new pg.Pool({ connectionString: DB_URL });

const PHASE_TO_STAGE = { 0: 1, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
const PRODUCT_VALUES = { diagnostico: 97, limpa_nome: 600, rating: 1200 };

async function krayinPost(path, data) {
  const res = await fetch(`${KRAYIN_URL}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${KRAYIN_TOKEN}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status}: ${body.substring(0, 200)}`);
  }
  return (await res.json()).data;
}

async function main() {
  console.log('Starting Krayin migration...');
  console.log(`DB: ${DB_URL?.substring(0, 40)}...`);
  console.log(`Krayin: ${KRAYIN_URL}`);

  // Get leads that aren't synced yet, prioritize by phase (highest first)
  const { rows } = await pool.query(`
    SELECT id, phone, name, phase, recommended_product, persona, created_at
    FROM conversations
    WHERE krayin_lead_id IS NULL
      AND phase >= 1
    ORDER BY phase DESC, created_at DESC
    LIMIT 300
  `);

  console.log(`Found ${rows.length} leads to migrate (phase >= 1)`);

  let success = 0, errors = 0;

  for (const row of rows) {
    try {
      const name = row.name || row.phone;

      // Create person
      const person = await krayinPost('/contacts/persons', {
        name,
        contact_numbers: [{ value: row.phone, label: 'whatsapp' }],
      });

      // Create lead
      const stageId = PHASE_TO_STAGE[row.phase] || 1;
      const lead = await krayinPost('/leads', {
        title: `${name} — WhatsApp`,
        description: `Lead via WhatsApp (${row.persona || 'augusto'}) — migrado`,
        lead_pipeline_id: 1,
        lead_pipeline_stage_id: stageId,
        person: { id: person.id },
        lead_value: PRODUCT_VALUES[row.recommended_product] || 0,
        status: 1,
        lead_source_id: 1,
        lead_type_id: 1,
      });

      // Store IDs
      await pool.query(
        'UPDATE conversations SET krayin_person_id = $1, krayin_lead_id = $2 WHERE id = $3',
        [person.id, lead.id, row.id]
      );

      success++;
      if (success % 10 === 0) {
        console.log(`  Migrated ${success}/${rows.length}...`);
      }
    } catch (err) {
      errors++;
      console.error(`  Error migrating ${row.phone}: ${err.message}`);
    }

    // Small delay to not overwhelm the API
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nMigration complete: ${success} success, ${errors} errors out of ${rows.length}`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
