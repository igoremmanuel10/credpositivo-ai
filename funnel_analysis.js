const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://credpositivo:credpositivo@localhost:5432/credpositivo_agent" });

async function getData() {
  try {
    console.log("=== CONVERSAS MORTAS FASE 0 AUGUSTO (recentes) ===");
    const dead0 = await pool.query(`SELECT c.id, c.phone, m.role, LEFT(m.content, 200) as txt FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.persona = 'augusto' AND c.phase = 0 AND c.last_message_at > NOW() - INTERVAL '3 days' ORDER BY c.id DESC, m.created_at ASC LIMIT 40`);
    let cur = null;
    dead0.rows.forEach(r => {
      if (r.id !== cur) { cur = r.id; console.log("\n--- Conv #" + r.id + " ---"); }
      console.log("[" + r.role + "] " + r.txt);
    });

    console.log("\n\n=== CONVERSAS PAULO (recentes) ===");
    const paulo = await pool.query(`SELECT c.id, c.phone, c.phase, m.role, LEFT(m.content, 200) as txt FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.persona = 'paulo' AND c.last_message_at > NOW() - INTERVAL '7 days' ORDER BY c.id DESC, m.created_at ASC LIMIT 40`);
    cur = null;
    paulo.rows.forEach(r => {
      if (r.id !== cur) { cur = r.id; console.log("\n--- Conv #" + r.id + " fase=" + r.phase + " ---"); }
      console.log("[" + r.role + "] " + r.txt);
    });

    console.log("\n\n=== AUGUSTO FASE 3+ SEM CONVERSAO (ultimas msgs) ===");
    const aug3 = await pool.query(`SELECT c.id, c.phase, c.recommended_product, m.role, LEFT(m.content, 200) as txt FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.persona = 'augusto' AND c.phase >= 3 AND c.conversion_event_at IS NULL AND c.last_message_at > NOW() - INTERVAL '5 days' ORDER BY c.last_message_at DESC, m.created_at DESC LIMIT 30`);
    cur = null;
    aug3.rows.forEach(r => {
      if (r.id !== cur) { cur = r.id; console.log("\n--- Conv #" + r.id + " fase=" + r.phase + " prod=" + r.recommended_product + " ---"); }
      console.log("[" + r.role + "] " + r.txt);
    });

    pool.end();
  } catch(e) { console.error("ERRO: " + e.message); pool.end(); }
}
getData();
