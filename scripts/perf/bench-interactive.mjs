#!/usr/bin/env node
// npm run bench:interactive -- [options]   (docs/performance-benchmark.md)
// Interactive end-to-end benchmark with Lightroom-grade budgets (#229, #230).
import { main } from './lib/runner.mjs';

process.exit(await main(process.argv.slice(2)));
