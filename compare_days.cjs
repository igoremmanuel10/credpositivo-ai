const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://credpositivo:credpositivo@localhost:5432/credpositivo_agent" });

async function getData() {
  try {
    // Define time ranges
    const yesterday = "2026-02-27";
    const today = "2026-02-28";

    console.log("========================================");
    console.log("  COMPARATIVO: 27/02 vs 28/02");
    console.log("========================================");

    // 1. New conversations per day
    const newConvs = await pool.query(`
      SELECT
        DATE(created_at) as dia,
        persona,
        COUNT(*) as total
      FROM conversations
      WHERE created_at >= '${yesterday}'
      GROUP BY DATE(created_at), persona
      ORDER BY dia, persona
    `);
    console.log("\n=== NOVAS CONVERSAS POR DIA ===");
    newConvs.rows.forEach(r => console.log(r.dia.toISOString().split('T')[0] + " | " + r.persona + ": " + r.total));

    // 2. Messages per day by agent
    const msgs = await pool.query(`
      SELECT
        DATE(m.created_at) as dia,
        c.persona,
        m.role,
        COUNT(*) as total
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at >= '${yesterday}'
      GROUP BY DATE(m.created_at), c.persona, m.role
      ORDER BY dia, c.persona, m.role
    `);
    console.log("\n=== MENSAGENS POR DIA ===");
    msgs.rows.forEach(r => console.log(r.dia.toISOString().split('T')[0] + " | " + r.persona + " [" + r.role + "]: " + r.total));

    // 3. Phase transitions (conversations that changed phase)
    const phaseChanges = await pool.query(`
      SELECT
        DATE(updated_at) as dia,
        persona,
        phase,
        COUNT(*) as total
      FROM conversations
      WHERE updated_at >= '${yesterday}' AND updated_at != created_at
      GROUP BY DATE(updated_at), persona, phase
      ORDER BY dia, persona, phase
    `);
    console.log("\n=== MUDANCAS DE FASE ===");
    phaseChanges.rows.forEach(r => console.log(r.dia.toISOString().split('T')[0] + " | " + r.persona + " → fase " + r.phase + ": " + r.total));

    // 4. Orders per day
    const orders = await pool.query(`
      SELECT
        DATE(created_at) as dia,
        service,
        status,
        COUNT(*) as total,
        SUM(price) as valor
      FROM orders
      WHERE created_at >= '${yesterday}'
      GROUP BY DATE(created_at), service, status
      ORDER BY dia
    `);
    console.log("\n=== ORDERS POR DIA ===");
    orders.rows.forEach(r => console.log(r.dia.toISOString().split('T')[0] + " | " + r.service + " [" + r.status + "]: " + r.total + " (R$" + r.valor + ")"));

    // 5. Follow-ups per day
    const fups = await pool.query(`
      SELECT
        DATE(created_at) as dia,
        event_type,
        sent,
        COUNT(*) as total
      FROM followups
      WHERE created_at >= '${yesterday}'
      GROUP BY DATE(created_at), event_type, sent
      ORDER BY dia, event_type
    `);
    console.log("\n=== FOLLOW-UPS POR DIA ===");
    fups.rows.forEach(r => console.log(r.dia.toISOString().split('T')[0] + " | " + r.event_type + " (sent=" + r.sent + "): " + r.total));

    // 6. All conversations with activity today/yesterday - detailed
    console.log("\n=== TODAS CONVERSAS COM ATIVIDADE ONTEM/HOJE ===");
    const active = await pool.query(`
      SELECT
        c.id, c.phone, c.persona, c.phase, c.recommended_product,
        c.created_at, c.last_message_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as total_msgs,
        (SELECT LEFT(content, 150) FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_msg
      FROM conversations c
      WHERE c.last_message_at >= '${yesterday}'
      ORDER BY c.last_message_at DESC
      LIMIT 50
    `);
    active.rows.forEach(r => {
      console.log("\n[#" + r.id + "] " + r.phone + " | " + r.persona + " | fase=" + r.phase + " | prod=" + r.recommended_product + " | msgs=" + r.total_msgs);
      console.log("  criado: " + r.created_at.toISOString().split('T')[0] + " | ultima: " + r.last_message_at.toISOString());
      console.log("  ultima msg: " + r.last_msg);
    });

    // 7. Error patterns - conversations with repeated "Não entendi"
    const errorPatterns = await pool.query(`
      SELECT c.id, c.phone, c.persona, COUNT(*) as repeats
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content LIKE '%Não entendi%' AND m.created_at >= '${yesterday}'
      GROUP BY c.id, c.phone, c.persona
      HAVING COUNT(*) > 1
      ORDER BY repeats DESC
    `);
    console.log("\n\n=== LOOPS 'NAO ENTENDI' (ontem/hoje) ===");
    errorPatterns.rows.forEach(r => console.log("#" + r.id + " " + r.phone + " (" + r.persona + "): " + r.repeats + "x"));

    // 8. Alex logs (errors)
    const alexLogs = await pool.query(`
      SELECT id, LEFT(alex_logs::text, 300) as log_txt, created_at
      FROM alex_logs
      WHERE created_at >= '${yesterday}'
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.log("\n=== ALEX LOGS (erros sistema) ===");
    alexLogs.rows.forEach(r => console.log("[" + r.created_at.toISOString() + "] " + r.log_txt));

    // 9. Recent docker/app errors from manager_reports
    const reports = await pool.query(`
      SELECT report_type, pipeline_health, LEFT(recommendations, 500) as recs, created_at
      FROM manager_reports
      WHERE created_at >= '${yesterday}'
      ORDER BY created_at DESC
    `);
    console.log("\n=== RELATORIOS LUAN (ontem/hoje) ===");
    reports.rows.forEach(r => {
      console.log("\n[" + r.created_at.toISOString() + "] tipo=" + r.report_type + " health=" + r.pipeline_health);
      console.log(r.recs);
    });

    // 10. Conversation content samples from today
    console.log("\n\n=== AMOSTRA CONVERSAS DE HOJE (28/02) ===");
    const todayConvs = await pool.query(`
      SELECT c.id, c.phone, c.persona, c.phase, m.role, LEFT(m.content, 200) as txt, m.created_at
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE m.created_at >= '${today}'
      ORDER BY c.id, m.created_at ASC
      LIMIT 60
    `);
    let cur = null;
    todayConvs.rows.forEach(r => {
      if (r.id !== cur) { cur = r.id; console.log("\n--- Conv #" + r.id + " (" + r.persona + " fase=" + r.phase + ") ---"); }
      console.log("[" + r.role + " " + r.created_at.toISOString().substring(11,16) + "] " + r.txt);
    });

    pool.end();
  } catch(e) {
    console.error("ERRO: " + e.message);
    console.error(e.stack);
    pool.end();
  }
}
getData();
