with open('/opt/credpositivo-agent/src/manager/funnel-watcher.js', 'r') as f:
    content = f.read()

# Fix 1: detectFollowupStall — adiciona check de horário comercial
old_stall = """async function detectFollowupStall() {
  try {
    const { rows: pending } = await db.query(`
      SELECT COUNT(*) as total
      FROM followups
      WHERE sent = false AND scheduled_at < NOW() - INTERVAL '2 hours'
    `);

    const { rows: recentSent } = await db.query(`
      SELECT COUNT(*) as total
      FROM followups
      WHERE sent = true AND created_at > NOW() - INTERVAL '2 hours'
    `);

    const pendingStale = parseInt(pending[0]?.total || 0);
    const recentSentCount = parseInt(recentSent[0]?.total || 0);

    if (pendingStale > 50 && recentSentCount === 0) {
      return {
        type: 'followup_stall',
        message: `⚠️ ALERTA: ${pendingStale} follow-ups travados há >2h sem nenhum enviado. Scheduler pode estar parado ou fora do horário comercial.`,
      };
    }
  } catch (err) {
    console.error('[FunnelWatcher] detectFollowupStall erro:', err.message);
  }
  return null;
}"""

new_stall = """async function detectFollowupStall() {
  // Fora do horário comercial: fila parada é esperado — não é erro
  if (!isBusinessHours()) return null;

  try {
    const { rows: pending } = await db.query(`
      SELECT COUNT(*) as total
      FROM followups
      WHERE sent = false AND scheduled_at < NOW() - INTERVAL '2 hours'
    `);

    const { rows: recentSent } = await db.query(`
      SELECT COUNT(*) as total
      FROM followups
      WHERE sent = true AND created_at > NOW() - INTERVAL '2 hours'
    `);

    const pendingStale = parseInt(pending[0]?.total || 0);
    const recentSentCount = parseInt(recentSent[0]?.total || 0);

    if (pendingStale > 50 && recentSentCount === 0) {
      return {
        type: 'followup_stall',
        message: `⚠️ ALERTA: ${pendingStale} follow-ups travados há >2h sem nenhum enviado durante horário comercial. Verifique o scheduler.`,
      };
    }
  } catch (err) {
    console.error('[FunnelWatcher] detectFollowupStall erro:', err.message);
  }
  return null;
}"""

# Fix 2: cooldown de 30min → 2h (resiste a restarts)
old_cooldown = "const ALERT_COOLDOWN_MS = 30 * 60 * 1000;"
new_cooldown = "const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h — resiste a restarts ocasionais"

content = content.replace(old_stall, new_stall, 1)
content = content.replace(old_cooldown, new_cooldown, 1)

with open('/opt/credpositivo-agent/src/manager/funnel-watcher.js', 'w') as f:
    f.write(content)

print("OK — stall check agora ignora fora do horário + cooldown 2h")
