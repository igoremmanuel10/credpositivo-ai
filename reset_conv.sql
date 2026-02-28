DELETE FROM messages WHERE conversation_id = 1;
DELETE FROM followups WHERE conversation_id = 1;
UPDATE conversations SET phase = 0, price_counter = 0, link_counter = 0, ebook_sent = false, recommended_product = NULL, user_profile = '{}', opted_out = false WHERE id = 1;
