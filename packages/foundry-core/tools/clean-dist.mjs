#!/usr/bin/env node
// clean-dist — remove this package's build output (dist/) before a build, so a
// module deleted from src/ cannot survive in the tarball as a stale .js.
// Only dist/: the engine bundle (engine/) is committed and owned by build-engine.mjs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
