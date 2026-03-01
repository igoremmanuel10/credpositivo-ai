const { Client } = require('pg');
async function main() {
  const client = new Client({ connectionString: 'postgresql://credpositivo:credpositivo@postgres:5432/credpositivo_agent' });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT 
        COUNT(*) as total_convs,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '9 days' THEN 1 END) as last_9d,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30d
      FROM conversations
    `);
    const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' LIMIT 20`);
    console.log('CONVS:', JSON.stringify(r.rows[0]));
    console.log('ORDER_COLS:', cols.rows.map(c => c.column_name).join(', '));
    await client.end();
  } catch(e) { console.log('err:', e.message); }
}
main();
