/**
 * record-vendor-artifact — write a published Tesseract bundle into the pin.
 *
 *   node tools/record-vendor-artifact.mjs <platform> <url>
 *
 * The hash and the byte count are taken from the PUBLISHED bytes: this tool
 * downloads the URL and hashes what arrives. It never reads the local tarball
 * you happen to have just built.
 *
 * That is the whole reason it exists rather than a line in the scan script. A
 * hash recorded from the local file asserts something the release has not been
 * checked for — that the upload completed, that it landed on the tag you meant,
 * that nothing rewrote it — and every one of those failures then reads as a
 * checksum mismatch on a stranger's first run, which points at their network
 * instead of at the release. Publish, then record what is actually published.
 *
 * Same rule the model catalog states in src/models/catalog.ts: "upload, verify
 * the uploaded bytes, THEN add the entry with the real hash."
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'vendor', 'tesseract', 'manifest.json');

const [platform, url] = process.argv.slice(2);
if (!platform || !url) {
  console.error('usage: node tools/record-vendor-artifact.mjs <platform> <url>');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const pin = manifest.platforms?.[platform];
if (!pin) {
  console.error(
    `${MANIFEST} has no pin for ${platform}. Recorded: `
    + `${Object.keys(manifest.platforms ?? {}).join(', ') || '(none)'}. `
    + `Run tools/scan-vendor-tesseract.sh on that platform first — the artifact `
    + `describes a pin, so the pin has to exist before it can be described.`,
  );
  process.exit(1);
}

console.error(`fetching ${url}`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) {
  console.error(`HTTP ${response.status} ${response.statusText} fetching ${url}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length === 0) {
  console.error(`${url} returned no bytes.`);
  process.exit(1);
}
const sha256 = createHash('sha256').update(bytes).digest('hex');

pin.artifact = { name: path.basename(new URL(url).pathname), url, sha256, bytes: bytes.length };
manifest.platforms[platform] = pin;

// Sorted keys, matching what scan-vendor-tesseract.sh writes, so re-running
// either tool never produces a diff that is only key order.
fs.writeFileSync(MANIFEST, `${JSON.stringify(sortKeys(manifest), null, 2)}\n`);

console.error(`recorded ${platform}:`);
console.error(`  name   ${pin.artifact.name}`);
console.error(`  sha256 ${sha256}`);
console.error(`  bytes  ${bytes.length}`);
console.error(`wrote ${MANIFEST}`);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}
