/**
 * Default conversation state for a new lead.
 */
export function createInitialState(phone, name) {
  return {
    phone,
    name: name || null,
    phase: 0,
    price_counter: 0,
    link_counter: 0,
    ebook_sent: false,
    user_profile: {},
    recommended_product: null,
  };
}

/**
 * Apply metadata updates from Claude's response to conversation state.
 */
export function applyMetadataUpdates(state, metadata) {
  const updates = {};

  if (metadata.phase !== undefined && metadata.phase !== state.phase) {
    updates.phase = metadata.phase;
  }

  if (metadata.price_mentioned && state.price_counter < 3) {
    updates.price_counter = state.price_counter + 1;
  }

  if (metadata.should_send_link && state.link_counter < 3) {
    updates.link_counter = state.link_counter + 1;
  }

  if (metadata.should_send_ebook && !state.ebook_sent) {
    updates.ebook_sent = true;
  }

  if (metadata.recommended_product) {
    updates.recommended_product = metadata.recommended_product;
  }

  if (metadata.user_profile_update && Object.keys(metadata.user_profile_update).length > 0) {
    updates.user_profile = { ...state.user_profile, ...metadata.user_profile_update };
  }

  return updates;
}
