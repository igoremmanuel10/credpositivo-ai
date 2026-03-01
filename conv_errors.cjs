const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://credpositivo:credpositivo@localhost:5432/credpositivo_agent" });

async function getData() {
  try {
    // Get ALL conversations with activity in last 2 days, FULL message history
    console.log("=== CONVERSAS COMPLETAS (27-28/02) ===\n");

    const convs = await pool.query(`
      SELECT c.id, c.phone, c.persona, c.phase, c.recommended_product,
             c.created_at, c.last_message_at,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as total_msgs
      FROM conversations c
      WHERE c.last_message_at >= '2026-02-27'
        AND (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) >= 3
      ORDER BY c.last_message_at DESC
      LIMIT 25
    `);

    for (const conv of convs.rows) {
      console.log("\n" + "=".repeat(70));
      console.log("CONV #" + conv.id + " | " + conv.persona + " | fase=" + conv.phase + " | prod=" + conv.recommended_product + " | msgs=" + conv.total_msgs);
      console.log("criado: " + conv.created_at.toISOString().substring(0,10) + " | ultima: " + conv.last_message_at.toISOString().substring(0,16));
      console.log("-".repeat(70));

      const msgs = await pool.query(`
        SELECT role, LEFT(content, 500) as content, created_at, phase
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
      `, [conv.id]);

      for (const m of msgs.rows) {
        const time = m.created_at.toISOString().substring(11,16);
        const day = m.created_at.toISOString().substring(8,10);
        const prefix = m.role === 'user' ? '  USER' : '  BOT ';
        console.log("[" + day + " " + time + "] " + prefix + " (fase " + m.phase + "): " + (m.content || "(vazio)"));
      }
    }

    pool.end();
  } catch(e) {
    console.error("ERRO: " + e.message);
    pool.end();
  }
}
getData();
