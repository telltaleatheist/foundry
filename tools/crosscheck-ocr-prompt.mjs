/**
 * Prove `src/ocr/prompt.ts` carries the trained-against system prompt
 * byte-for-byte — against the file the training data was actually built with,
 * BookForgeApp `tools/galley/build-dataset.py` (the SYSTEM constant).
 *
 * Machine-local by nature: it needs both repos. Run with:
 *
 *   bun tools/crosscheck-ocr-prompt.mjs [path-to-build-dataset.py]
 *
 * The result of the last run is recorded in test/ocr/CROSSCHECK.md. This is
 * the same discipline as tools/crosscheck-ocr.mjs (the edit contract) and the
 * boxes replay: a moved artifact is verified against its source once, loudly,
 * rather than trusted because the move looked careful.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { OCR_SYSTEM_PROMPT } from '../src/ocr/prompt.ts';

const source = process.argv[2]
  ?? '/Volumes/Callisto/Projects/BookForgeApp/tools/galley/build-dataset.py';

if (!existsSync(source)) {
  console.error(`crosscheck: source file not found: ${source}`);
  console.error('Pass the path to build-dataset.py explicitly.');
  process.exit(2);
}

// Extract the SYSTEM assignment by parsing the Python, not by regex: the value
// is `'\n'.join([...])`, and evaluating exactly that assignment's expression in
// an empty namespace yields the string the dataset builder used.
const py = `
import ast, sys
tree = ast.parse(open(sys.argv[1], encoding='utf-8').read())
found = []
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'SYSTEM' for t in node.targets):
        found.append(node)
if len(found) != 1:
    sys.exit(f'expected exactly one SYSTEM assignment, found {len(found)}')
value = eval(compile(ast.Expression(found[0].value), sys.argv[1], 'eval'), {}, {})
sys.stdout.write(value)
`;

const res = spawnSync('python3', ['-c', py, source], { encoding: 'utf-8' });
if (res.status !== 0) {
  console.error(`crosscheck: python extraction failed:\n${res.stderr}`);
  process.exit(2);
}
const theirs = res.stdout;

const sha = (s) => createHash('sha256').update(s, 'utf-8').digest('hex');

if (theirs === OCR_SYSTEM_PROMPT) {
  console.log('OK — byte-identical.');
  console.log(`  sha256 ${sha(theirs)}`);
  console.log(`  length ${theirs.length} chars, ${theirs.split('\n').length} lines`);
  process.exit(0);
}

console.error('MISMATCH — src/ocr/prompt.ts does not equal the training SYSTEM prompt.');
console.error(`  theirs: sha256 ${sha(theirs)} length ${theirs.length}`);
console.error(`  ours:   sha256 ${sha(OCR_SYSTEM_PROMPT)} length ${OCR_SYSTEM_PROMPT.length}`);
const a = theirs.split('\n'), b = OCR_SYSTEM_PROMPT.split('\n');
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    console.error(`  first differing line ${i + 1}:`);
    console.error(`    theirs: ${JSON.stringify(a[i])}`);
    console.error(`    ours:   ${JSON.stringify(b[i])}`);
    break;
  }
}
process.exit(1);
