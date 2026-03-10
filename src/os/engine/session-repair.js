/**
 * @file session-repair.js
 * @description Repairs corrupted conversation history arrays for Claude/OpenAI
 * message formats.
 *
 * Problems addressed:
 *   1. Orphaned tool_result blocks — a tool_result with no preceding tool_use
 *   2. Empty messages — messages with null/empty content
 *   3. Consecutive same-role messages — merged into a single message
 *   4. Invalid alternating user/assistant pattern — extra messages removed to
 *      restore a valid sequence starting with "user"
 *   5. Dangling assistant tool_use — tool_use with no following tool_result
 */

/**
 * Repair a conversation history array in place, returning a clean copy.
 *
 * This function is intentionally pure (no side effects, no I/O).
 *
 * @param {Array<Object>} conversationHistory - Raw message array
 * @returns {Array<Object>} Repaired message array
 */
export function repair(conversationHistory) {
  if (!Array.isArray(conversationHistory)) {
    console.warn('[SessionRepair] Input is not an array, returning empty history');
    return [];
  }

  let messages = conversationHistory.map(cloneMessage);

  // Pass 1: Remove completely empty messages
  messages = removeEmptyMessages(messages);

  // Pass 2: Merge consecutive same-role messages
  messages = mergeConsecutiveSameRole(messages);

  // Pass 3: Remove orphaned tool_result blocks (no preceding tool_use)
  messages = removeOrphanedToolResults(messages);

  // Pass 4: Remove dangling tool_use blocks (no following tool_result)
  messages = removeDanglingToolUse(messages);

  // Pass 5: Enforce alternating user/assistant pattern
  messages = enforceAlternatingPattern(messages);

  return messages;
}

// ─── Passes ─────────────────────────────────────────────────────────────────

/**
 * Remove messages that have no meaningful content.
 *
 * @param {Object[]} messages
 * @returns {Object[]}
 */
function removeEmptyMessages(messages) {
  return messages.filter((msg) => {
    if (!msg || !msg.role) return false;

    const content = msg.content;

    if (content === null || content === undefined) return false;
    if (typeof content === 'string' && content.trim() === '') return false;
    if (Array.isArray(content) && content.length === 0) return false;

    // Filter out messages whose content array contains only empty text blocks
    if (Array.isArray(content)) {
      const meaningful = content.filter((block) => {
        if (!block || !block.type) return false;
        if (block.type === 'text') return typeof block.text === 'string' && block.text.trim() !== '';
        return true; // tool_use, tool_result, image etc. are always meaningful
      });
      if (meaningful.length === 0) return false;
    }

    return true;
  });
}

/**
 * Merge consecutive messages with the same role into one message.
 * Content arrays are concatenated; string content is joined with a newline.
 *
 * @param {Object[]} messages
 * @returns {Object[]}
 */
function mergeConsecutiveSameRole(messages) {
  if (messages.length === 0) return [];

  const merged = [cloneMessage(messages[0])];

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (prev.role !== curr.role) {
      merged.push(cloneMessage(curr));
      continue;
    }

    // Merge content
    const prevContent = normalizeToArray(prev.content);
    const currContent = normalizeToArray(curr.content);
    prev.content = [...prevContent, ...currContent];
  }

  return merged;
}

/**
 * Remove tool_result content blocks that have no matching tool_use.
 *
 * Claude's API requires that every tool_result in a user message corresponds to
 * a tool_use block in the immediately preceding assistant message.
 *
 * @param {Object[]} messages
 * @returns {Object[]}
 */
function removeOrphanedToolResults(messages) {
  const result = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    // Gather all tool_use IDs from the preceding assistant message
    const prevAssistant = findPrecedingAssistant(result);
    const toolUseIds = new Set(extractToolUseIds(prevAssistant));

    const cleanedContent = msg.content.filter((block) => {
      if (block.type !== 'tool_result') return true;
      const hasMatch = toolUseIds.has(block.tool_use_id);
      if (!hasMatch) {
        console.warn(
          `[SessionRepair] Removing orphaned tool_result for tool_use_id="${block.tool_use_id}"`
        );
      }
      return hasMatch;
    });

    if (cleanedContent.length === 0) {
      console.warn('[SessionRepair] User message became empty after removing orphaned tool_results, dropping message');
      continue;
    }

    result.push({ ...msg, content: cleanedContent });
  }

  return result;
}

/**
 * Remove tool_use blocks from assistant messages that have no corresponding
 * tool_result in the following user message.
 *
 * @param {Object[]} messages
 * @returns {Object[]}
 */
function removeDanglingToolUse(messages) {
  const result = [...messages];

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseBlocks = msg.content.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) continue;

    // Check the next user message for matching tool_results
    const nextUser = result[i + 1];
    const resultIds = new Set(
      nextUser && Array.isArray(nextUser.content)
        ? nextUser.content
            .filter((b) => b.type === 'tool_result')
            .map((b) => b.tool_use_id)
        : []
    );

    const cleanedContent = msg.content.filter((block) => {
      if (block.type !== 'tool_use') return true;
      const hasResult = resultIds.has(block.id);
      if (!hasResult) {
        console.warn(
          `[SessionRepair] Removing dangling tool_use id="${block.id}" (no tool_result)`
        );
      }
      return hasResult;
    });

    if (cleanedContent.length === 0) {
      // Replace with a simple text placeholder to avoid empty content
      result[i] = {
        ...msg,
        content: [{ type: 'text', text: '[Tool call result unavailable]' }],
      };
    } else {
      result[i] = { ...msg, content: cleanedContent };
    }
  }

  return result;
}

/**
 * Enforce a strict alternating user → assistant → user → ... pattern.
 * The sequence must start with a user message. Extra consecutive same-role
 * messages are dropped (they should have been merged already, but this acts
 * as a safety net).
 *
 * @param {Object[]} messages
 * @returns {Object[]}
 */
function enforceAlternatingPattern(messages) {
  if (messages.length === 0) return [];

  // Ensure first message is from user
  let start = 0;
  while (start < messages.length && messages[start].role !== 'user') {
    console.warn(`[SessionRepair] Dropping leading non-user message (role="${messages[start].role}")`);
    start++;
  }

  if (start >= messages.length) return [];

  const result = [messages[start]];
  const expectedRoles = ['assistant', 'user'];
  let expectedIdx = 0;

  for (let i = start + 1; i < messages.length; i++) {
    const expected = expectedRoles[expectedIdx % 2];
    const actual = messages[i].role;

    if (actual === expected) {
      result.push(messages[i]);
      expectedIdx++;
    } else {
      console.warn(
        `[SessionRepair] Dropping out-of-order message: expected role="${expected}" got "${actual}"`
      );
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deep-clone a message object (shallow is enough for our purposes since we
 * don't mutate nested blocks).
 *
 * @param {Object} msg
 * @returns {Object}
 */
function cloneMessage(msg) {
  if (!msg) return msg;
  return {
    ...msg,
    content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
  };
}

/**
 * Normalize message content to an array of blocks.
 *
 * @param {string|Array} content
 * @returns {Array}
 */
function normalizeToArray(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * Find the last assistant message in the result array built so far.
 *
 * @param {Object[]} messages
 * @returns {Object | null}
 */
function findPrecedingAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
  return null;
}

/**
 * Extract all tool_use IDs from a message's content array.
 *
 * @param {Object | null} msg
 * @returns {string[]}
 */
function extractToolUseIds(msg) {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b) => b.type === 'tool_use' && b.id)
    .map((b) => b.id);
}
