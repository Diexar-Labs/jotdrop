#!/usr/bin/env node
// The jotdrop-mcp program: see cli.mjs.
import { main } from './cli.mjs';

process.exitCode = await main(process.argv.slice(2));
