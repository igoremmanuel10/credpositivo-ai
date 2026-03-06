import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redis.url);

const CACHE_TTL = 3600; // 1 hour
const DAY_TTL = 86400;  // 24 hours

export const cache = {
  async getConversation(phone) {
    const data = await redis.get(`conv:${phone}`);
    return data ? JSON.parse(data) : null;
  },

  async setConversation(phone, conversation) {
    await redis.set(`conv:${phone}`, JSON.stringify(conversation), 'EX', CACHE_TTL);
  },

  async deleteConversation(phone) {
    await redis.del(`conv:${phone}`);
  },

  async setProcessingLock(phone) {
    const key = `lock:${phone}`;
    const acquired = await redis.set(key, '1', 'EX', 30, 'NX');
    return !!acquired;
  },

  async releaseProcessingLock(phone) {
    await redis.del(`lock:${phone}`);
  },

  async setLastResponseTime(phone) {
    const key = `cooldown:${phone}`;
    await redis.set(key, Date.now().toString(), 'EX', 120);
  },

  async isInCooldown(phone, seconds = 30) {
    const key = `cooldown:${phone}`;
    const lastTime = await redis.get(key);
    if (!lastTime) return false;
    const elapsed = (Date.now() - parseInt(lastTime, 10)) / 1000;
    return elapsed < seconds;
  },

  async incrementHourlyMessageCount(phone) {
    const key = `hourly_msgs:${phone}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 3600);
    }
    return count;
  },

  async getHourlyMessageCount(phone) {
    const key = `hourly_msgs:${phone}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  },

  async appendToDebounceBuffer(phone, text, ttl = 30) {
    const key = `debounce_buf:${phone}`;
    await redis.rpush(key, text);
    await redis.expire(key, ttl);
  },

  async flushDebounceBuffer(phone) {
    const key = `debounce_buf:${phone}`;
    const messages = await redis.lrange(key, 0, -1);
    await redis.del(key);
    return messages;
  },

  async setDebounceTimer(phone, seconds = 7) {
    const key = `debounce_timer:${phone}`;
    const set = await redis.set(key, '1', 'EX', seconds, 'NX');
    return !!set;
  },

  // --- Daily counters (follow-ups and audio) ---

  /**
   * Get daily follow-up count for a phone number.
   * Resets automatically at midnight (TTL-based).
   */
  async getDailyFollowupCount(phone) {
    const key = `daily_followup:${phone}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  },

  /**
   * Increment daily follow-up count.
   * First increment sets 24h TTL.
   */
  async incrementDailyFollowupCount(phone) {
    const key = `daily_followup:${phone}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, DAY_TTL);
    }
    return count;
  },

  /**
   * Get daily audio count for a phone number.
   * Max 2 audios per lead per day (config.tts.maxDailyPerLead).
   */
  async getDailyAudioCount(phone) {
    const key = `daily_audio:${phone}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  },

  /**
   * Increment daily audio count.
   * First increment sets 24h TTL.
   */
  async incrementDailyAudioCount(phone) {
    const key = `daily_audio:${phone}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, DAY_TTL);
    }
    return count;
  },

  // --- Vapi.ai Voice Call Methods ---

  async getVapiCallCount(phone) {
    const key = `vapi_calls:${phone}`;
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  },

  async incrementVapiCallCount(phone) {
    const key = `vapi_calls:${phone}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, DAY_TTL);
    }
    return count;
  },

  async scheduleVapiCall(phone, data) {
    const key = `vapi_scheduled:${phone}`;
    await redis.set(key, JSON.stringify(data), "EX", DAY_TTL);
  },

  async getScheduledVapiCall(phone) {
    const key = `vapi_scheduled:${phone}`;
    const data = await redis.get(key);
    if (!data) return null;
    await redis.del(key);
    return JSON.parse(data);
  },

  async getScheduledVapiCallKeys() {
    return redis.keys("vapi_scheduled:*");
  },

  /**
   * Get all pending nudge keys (nudge:*).
   * Returns array of full keys like ["nudge:5511999999999"].
   */
  async getNudgeKeys() {
    return redis.keys("nudge:*");
  },

  // --- Bot-to-bot loop detection ---

  /**
   * Track last N message hashes for a phone to detect duplicate spam.
   * Stores a list of normalized message hashes. Returns the count of
   * consecutive identical hashes at the tail (i.e., how many times
   * the same message was received in a row).
   */
  async trackMessageHash(phone, hash) {
    const key = `msg_hashes:${phone}`;
    await redis.rpush(key, hash);
    // Keep only the last 10 hashes
    await redis.ltrim(key, -10, -1);
    await redis.expire(key, 3600); // 1 hour TTL

    // Count consecutive identical hashes from the tail
    const hashes = await redis.lrange(key, 0, -1);
    let consecutiveCount = 0;
    for (let i = hashes.length - 1; i >= 0; i--) {
      if (hashes[i] === hash) {
        consecutiveCount++;
      } else {
        break;
      }
    }
    return consecutiveCount;
  },
};
