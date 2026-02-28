/**
 * index_patch_event_detector.js — Patches index.js to add event-detector.
 */
import { readFileSync, writeFileSync } from 'fs';

const filePath = '/opt/credpositivo-agent/src/index.js';
let content = readFileSync(filePath, 'utf8');

// 1. Add import
if (!content.includes('startEventDetector')) {
  const importAnchor = "import { startAgendaScheduler } from './agenda/manager.js';";
  if (content.includes(importAnchor)) {
    content = content.replace(
      importAnchor,
      importAnchor + "\nimport { startEventDetector } from './conversation/event-detector.js';"
    );
    console.log('[Patch] Added startEventDetector import');
  } else {
    console.error('[Patch] Could not find import anchor!');
    process.exit(1);
  }

  // 2. Add startEventDetector() call after startAgendaScheduler()
  const callAnchor = '    startAgendaScheduler();';
  if (content.includes(callAnchor)) {
    content = content.replace(
      callAnchor,
      callAnchor + '\n    startEventDetector();'
    );
    console.log('[Patch] Added startEventDetector() call');
  } else {
    console.error('[Patch] Could not find call anchor!');
    process.exit(1);
  }

  writeFileSync(filePath, content, 'utf8');
  console.log('[Patch] index.js patched (event-detector added)!');
} else {
  console.log('[Patch] startEventDetector already in index.js, skipping');
}
