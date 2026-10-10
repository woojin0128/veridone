#!/usr/bin/env node
// Veridone CLI entry point.
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

try {
  if (typeof module.enableCompileCache === 'function' && !process.env.VERIDONE_NO_COMPILE_CACHE) {
    module.enableCompileCache(path.join(os.tmpdir(), 'veridone-v8-cache'));
  }
} catch { /* older Node */ }

const { main } = await import('./cli-main.mjs');
try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`veridone: ${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 1;
}
