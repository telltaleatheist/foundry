#!/usr/bin/env node
// stamp-esm — say which module system each half of dist/ is.
//
// The package is `"type": "module"` because its engine sources and tools are
// ES modules, and esbuild bundles an ES module in NODE mode only when its
// package says so (that is how they were bundled when they lived under the
// repo root's `"type": "module"`; FOUNDRY-CORE-PLAN step 3). tsc's CommonJS
// half (dist/node, dist/shared) therefore needs its own `"type": "commonjs"`,
// and the ES half (dist/esm) keeps `"type": "module"` under it. Same job as
// @owen/tool-loop's stamp-module-type.mjs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
for (const [dir, type] of [[dist, 'commonjs'], [path.join(dist, 'esm'), 'module']]) {
  if (!fs.existsSync(dir)) throw new Error(`stamp-esm: ${dir} does not exist — build with tsc first`);
  fs.writeFileSync(path.join(dir, 'package.json'), `{\n  "type": "${type}"\n}\n`);
}
