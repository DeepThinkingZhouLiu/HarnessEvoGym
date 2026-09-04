#!/usr/bin/env node

process.env.RSI_COWORK_SUITE_PROFILE ??= 'main16-in-sample26'
await import('./run-cowork-formal32-five-mode.mjs')
