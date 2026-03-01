const { Client } = require('pg');
async function main() {
  const client = new Client({ connectionString: 'postgresql://credpositivo:credpositivo@postgres:5432/credpositivo_agent' });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT 
        COUNT(*) as total_convs,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '9 days' THEN 1 END) as last_9d,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30d,
        COUNT(CASE WHEN phase >= 3 THEN 1 END) as reached_offer,
        COUNT(CASE WHEN phase >= 4 THEN 1 END) as reached_closing
      FROM conversations WHERE opted_out = false OR opted_out IS NULL
    `);
    const orders = await client.query(`
      SELECT COUNT(*) as total_orders,
             COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30d_orders,
             ROUND(AVG(amount)::numeric, 2) as avg_ticket
      FROM orders WHERE status = 'paid'
    `);
    console.log('CONVS:', JSON.stringify(r.rows[0]));
    console.log('ORDERS:', JSON.stringify(orders.rows[0]));
    await client.end();
  } catch(e) { console.log('err:', e.message); }
}
main();
