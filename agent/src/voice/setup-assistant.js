/**
 * Vapi.ai Assistant Setup Script
 *
 * Run once to create the voice assistant in Vapi.ai.
 * After running, copy the assistant ID to .env as VAPI_ASSISTANT_ID.
 *
 * Usage: node src/voice/setup-assistant.js
 *
 * Fernando Dev - CredPositivo
 */

import 'dotenv/config';
import { createAssistant } from './vapi-client.js';

async function setup() {
  console.log('=== Vapi.ai Assistant Setup ===\n');

  if (!process.env.VAPI_PRIVATE_KEY) {
    console.error('ERROR: VAPI_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  try {
    const assistant = await createAssistant();

    console.log('\n=== Assistant Created Successfully ===');
    console.log(`ID:   ${assistant.id}`);
    console.log(`Name: ${assistant.name}`);
    console.log(`\nAdd this to your .env file:`);
    console.log(`VAPI_ASSISTANT_ID=${assistant.id}`);
    console.log('\nDone!');
  } catch (err) {
    console.error('Failed to create assistant:', err.message);
    process.exit(1);
  }
}

setup();
