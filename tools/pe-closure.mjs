/**
 * pe-closure — which DLLs beside a Windows executable does it actually load?
 *
 * Used by tools/scan-vendor-tesseract.sh to decide what a vendored Tesseract
 * bundle has to contain. The scoop / UB-Mangoes install directory holds 56 DLLs,
 * but only 34 of them are reachable from tesseract.exe: the rest are pango,
 * cairo, glib and ICU, which text2image and the training tools need and a scan
 * never touches. Shipping all of them would be 44 MB of dead weight in every
 * download; guessing at the list would be a bundle that fails to start on
 * somebody else's machine with a dialog box and no log line.
 *
 * So the list is READ OUT OF THE BINARY: walk the PE import table, follow every
 * import that resolves to a file in the same directory, and repeat. Anything not
 * in that directory is a system DLL (kernel32, user32, …) and is reported
 * separately rather than assumed — an unexpected name there is worth seeing.
 *
 * Prints one DLL filename per line on stdout, so the shell can read it directly.
 * Everything else goes to stderr.
 *
 *   node tools/pe-closure.mjs <path-to-exe>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function imports(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not a PE (no MZ)`);
  const peOff = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(peOff) !== 0x00004550) throw new Error(`${file}: no PE signature`);
  const coff = peOff + 4;
  const numSections = b.readUInt16LE(coff + 2);
  const optSize = b.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = b.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  // Data directories start after the fixed optional-header part.
  const ddOff = opt + (pe32plus ? 112 : 96);
  const importRva = b.readUInt32LE(ddOff + 8); // directory index 1
  if (importRva === 0) return [];

  const sections = [];
  const secOff = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    sections.push({
      va: b.readUInt32LE(s + 12),
      vsize: b.readUInt32LE(s + 8),
      raw: b.readUInt32LE(s + 20),
      rawSize: b.readUInt32LE(s + 16),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + size) return s.raw + (rva - s.va);
    }
    return -1;
  };
  const cstr = (off) => {
    let end = off;
    while (end < b.length && b[end] !== 0) end++;
    return b.toString('latin1', off, end);
  };

  const out = [];
  let d = toOffset(importRva);
  if (d < 0) return [];
  for (;;) {
    // IMAGE_IMPORT_DESCRIPTOR is 20 bytes; a zeroed one terminates the array.
    const nameRva = b.readUInt32LE(d + 12);
    const firstThunk = b.readUInt32LE(d + 16);
    if (nameRva === 0 && firstThunk === 0) break;
    const nOff = toOffset(nameRva);
    if (nOff >= 0) out.push(cstr(nOff));
    d += 20;
    if (d + 20 > b.length) break;
  }
  return out;
}

const root = process.argv[2];
const dir = path.dirname(root);
const local = new Map(
  fs.readdirSync(dir).filter((f) => /\.dll$/i.test(f)).map((f) => [f.toLowerCase(), f]),
);

const needLocal = new Set();
const system = new Set();
const seen = new Set();
const queue = [root];
while (queue.length) {
  const f = queue.shift();
  const key = path.basename(f).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  let deps;
  try {
    deps = imports(f);
  } catch (e) {
    console.error(`  ! ${f}: ${e.message}`);
    continue;
  }
  for (const d of deps) {
    const lower = d.toLowerCase();
    if (local.has(lower)) {
      needLocal.add(local.get(lower));
      queue.push(path.join(dir, local.get(lower)));
    } else {
      system.add(d);
    }
  }
}

const sorted = [...needLocal].sort();
if (sorted.length === 0) {
  console.error(`pe-closure: ${root} imports no DLL from its own directory.`);
  process.exit(1);
}

let total = 0;
for (const d of sorted) total += fs.statSync(path.join(dir, d)).size;
console.error(
  `pe-closure: ${sorted.length} local DLLs, ${(total / 1048576).toFixed(1)} MiB`
  + ` (system: ${[...system].sort().join(', ')})`,
);
const unused = [...local.values()].filter((d) => !needLocal.has(d)).sort();
if (unused.length) {
  console.error(`pe-closure: ${unused.length} DLLs in the directory are NOT loaded by this binary`);
}

process.stdout.write(`${sorted.join('\n')}${'\n'}`);
