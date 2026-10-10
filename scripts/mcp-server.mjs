#!/usr/bin/env node
// Veridone MCP server entry point (enables V8 compile cache on Node >= 22.1).
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

try {
  if (typeof module.enableCompileCache === 'function' && !process.env.VERIDONE_NO_COMPILE_CACHE) {
    module.enableCompileCache(path.join(os.tmpdir(), 'veridone-v8-cache'));
  }
} catch { /* older Node */ }

await import('./mcp-main.mjs');
