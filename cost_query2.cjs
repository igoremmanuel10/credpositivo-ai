const { Client } = require('pg');
async function main() {
  const client = new Client({ connectionString: 'postgresql://credpositivo:credpositivo@postgres:5432/credpositivo_agent' });
  try {
    await client.connect();
    const r = await client.query(`
      SELECT model, 
             SUM(input_tokens)::int as input, 
             SUM(output_tokens)::int as output, 
             ROUND(SUM(cost_usd)::numeric, 4) as cost, 
             COUNT(*)::int as calls 
      FROM api_costs 
      WHERE created_at > NOW() - INTERVAL '30 days' 
      GROUP BY model ORDER BY cost DESC LIMIT 10
    `);
    const total = await client.query(`
      SELECT COUNT(DISTINCT DATE(created_at)) as days,
             SUM(input_tokens)::int as total_input,
             SUM(output_tokens)::int as total_output,
             ROUND(SUM(cost_usd)::numeric, 4) as total_cost,
             COUNT(*)::int as total_calls
      FROM api_costs WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    console.log('BY_MODEL:', JSON.stringify(r.rows));
    console.log('TOTAL:', JSON.stringify(total.rows[0]));
    await client.end();
  } catch(e) { console.log('err:', e.message); }
}
main();
