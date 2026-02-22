import pg from 'pg';
import { config } from '../config.js';

const pool = new pg.Pool({ connectionString: config.database.url });

export const db = {
  pool,
  query: (text, params) => pool.query(text, params),

  async getConversation(phone) {
    const { rows } = await pool.query(
      'SELECT * FROM conversations WHERE phone = $1',
      [phone]
    );
    return rows[0] || null;
  },

  async createConversation(phone, name, persona = 'augusto', botPhone = null) {
    const { rows } = await pool.query(
      `INSERT INTO conversations (phone, name, persona, bot_phone, last_message_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [phone, name, persona, botPhone]
    );
    return rows[0];
  },

  async updateConversation(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${idx}`);
      values.push(key === 'user_profile' ? JSON.stringify(value) : value);
      idx++;
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    await pool.query(
      `UPDATE conversations SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  },

  async addMessage(conversationId, role, content, phase, evolutionIds = null) {
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, phase, evolution_ids)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, role, content, phase, evolutionIds ? JSON.stringify(evolutionIds) : null]
    );
    await pool.query(
      `UPDATE conversations SET last_message_at = NOW() WHERE id = $1`,
      [conversationId]
    );
  },

  async getMessages(conversationId, limit = 20) {
    const { rows } = await pool.query(
      `SELECT role, content, phase, created_at FROM (
         SELECT role, content, phase, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) sub ORDER BY created_at ASC`,
      [conversationId, limit]
    );
    return rows;
  },

  async getMessageCount(conversationId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int as count FROM messages WHERE conversation_id = $1',
      [conversationId]
    );
    return rows[0]?.count || 0;
  },

  async upsertMessageAck(evolutionMsgId, remoteJid, ack) {
    await pool.query(
      `INSERT INTO message_acks (evolution_msg_id, remote_jid, ack, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (evolution_msg_id)
       DO UPDATE SET ack = GREATEST(message_acks.ack, $3), updated_at = NOW()`,
      [evolutionMsgId, remoteJid, ack]
    );
  },

  async scheduleFollowup(conversationId, eventType, delayMinutes) {
    await pool.query(
      `INSERT INTO followups (conversation_id, event_type, scheduled_at)
       VALUES ($1, $2, NOW() + INTERVAL '${Math.floor(delayMinutes)} minutes')`,
      [conversationId, eventType]
    );
  },

  async getPendingFollowups() {
    const { rows } = await pool.query(
      `SELECT f.*, c.phone, c.name, c.phase, c.user_profile, c.remote_jid,
              c.persona, c.recommended_product, c.opted_out
       FROM followups f
       JOIN conversations c ON c.id = f.conversation_id
       WHERE f.sent = FALSE AND f.scheduled_at <= NOW()
       ORDER BY f.scheduled_at ASC
       LIMIT 20`
    );
    return rows;
  },

  async markFollowupSent(id) {
    await pool.query('UPDATE followups SET sent = TRUE WHERE id = $1', [id]);
  },

  async cancelFollowups(conversationId, eventType = null) {
    if (eventType) {
      await pool.query(
        'UPDATE followups SET sent = TRUE WHERE conversation_id = $1 AND event_type = $2 AND sent = FALSE',
        [conversationId, eventType]
      );
    } else {
      await pool.query(
        'UPDATE followups SET sent = TRUE WHERE conversation_id = $1 AND sent = FALSE',
        [conversationId]
      );
    }
  },

  async getTimedOutConversations(timeoutMinutes) {
    const { rows } = await pool.query(
      `SELECT c.*
       FROM conversations c
       WHERE c.last_message_at < NOW() - INTERVAL '${Math.floor(timeoutMinutes)} minutes'
         AND c.phase BETWEEN 1 AND 4
         AND c.opted_out IS NOT TRUE
         AND NOT EXISTS (
           SELECT 1 FROM followups f
           WHERE f.conversation_id = c.id
             AND f.event_type = 'consultation_timeout'
             AND f.sent = FALSE
         )
         AND NOT EXISTS (
           SELECT 1 FROM followups f
           WHERE f.conversation_id = c.id
             AND f.event_type = 'consultation_timeout'
             AND f.sent = TRUE
             AND f.created_at > NOW() - INTERVAL '24 hours'
         )`
    );
    return rows;
  },
};
