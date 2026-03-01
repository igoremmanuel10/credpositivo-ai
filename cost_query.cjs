const { Client } = require('pg');
async function main() {
  const client = new Client({ connectionString: 'postgresql://credpositivo:Cr3dP0s1t1v0_2024@postgres:5432/credpositivo_agent' });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT model, 
             SUM(input_tokens) as input, 
             SUM(output_tokens) as output, 
             ROUND(SUM(cost_usd)::numeric, 4) as cost, 
             COUNT(*) as calls 
      FROM api_costs 
      WHERE created_at > NOW() - INTERVAL '30 days' 
      GROUP BY model ORDER BY cost DESC LIMIT 10
    `);
    console.log(JSON.stringify(r.rows));
    await client.end();
  } catch(e) { console.log('err:', e.message); }
}
main();
