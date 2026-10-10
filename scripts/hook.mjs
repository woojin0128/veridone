#!/usr/bin/env node
// Veridone hook entry point. Enables V8's on-disk compile cache (Node >= 22.1)
// before loading the real dispatcher, which roughly halves hook start-up time.
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

try {
  if (typeof module.enableCompileCache === 'function' && !process.env.VERIDONE_NO_COMPILE_CACHE) {
    module.enableCompileCache(path.join(os.tmpdir(), 'veridone-v8-cache'));
  }
} catch { /* older Node: run uncached */ }

await import('./hook-main.mjs');
