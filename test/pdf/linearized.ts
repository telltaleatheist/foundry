/**
 * A linearized PDF, hand-built.
 *
 * There is no linearizer in this repository and neither real fixture is
 * linearized, so the spike's linearization case is constructed byte by byte.
 * What it reproduces is the property that matters to an incremental update: a
 * linearized file DECLARES its own total length in the first object's
 * `/Linearized` dictionary (`/L`), and a reader uses that declaration to decide
 * whether the fast-web-view layout can be trusted. Append one byte and the
 * declaration is false.
 *
 * It is not a complete linearization — there is no hint stream and no
 * first-page cross-reference section — and the doc comment in
 * docs/PDF_SPIKE.md says so. The fixture is honest about what it proves: the
 * `/L` invariant, and that a full rewrite through pdf-lib removes the whole
 * dictionary.
 */

/** Ten digits, zero-padded: a PDF integer whose WIDTH is fixed, so it can be patched. */
const pad = (n: number): string => String(n).padStart(10, '0');

const PLACEHOLDER = '0000000000';

export function linearizedPdf(): Uint8Array {
  const objects: string[] = [
    // 1: the linearization parameter dictionary, first in the file by definition.
    `<< /Linearized 1 /L ${PLACEHOLDER} /H [ 0000000000 0000000000 ] /O 4 /E 0000000000 /N 1 /T ${PLACEHOLDER} >>`,
    `<< /Type /Catalog /Pages 3 0 R >>`,
    `<< /Type /Pages /Kids [ 4 0 R ] /Count 1 >>`,
    `<< /Type /Page /Parent 3 0 R /MediaBox [ 0 0 612 792 ] /Contents 5 0 R /Resources << >> >>`,
    null as unknown as string, // 5 is the stream, built below
  ];
  const content = 'BT /F1 12 Tf 72 720 Td (linearized) Tj ET\n';
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;

  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${pad(offset)} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 2 0 R >>\nstartxref\n${pad(xrefAt)}\n%%EOF\n`;

  let file = body + xref;
  // The two declarations that make the file claim to be linearized: its own
  // total length, and where the cross-reference table it points at begins.
  file = replaceFirst(file, `/L ${PLACEHOLDER}`, `/L ${pad(file.length)}`);
  file = replaceFirst(file, `/T ${PLACEHOLDER}`, `/T ${pad(xrefAt)}`);

  return latin1(file);
}

function replaceFirst(text: string, find: string, put: string): string {
  const at = text.indexOf(find);
  if (at === -1) throw new Error(`linearized fixture: "${find}" is not in the file`);
  if (find.length !== put.length) {
    throw new Error('linearized fixture: a patch must not change the file\'s length');
  }
  return text.slice(0, at) + put + text.slice(at + find.length);
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Bytes as characters, one for one. Not `TextDecoder`: a PDF's structure is
 * bytes, and a decoder that folded a stray 0x80 into U+FFFD would shift every
 * offset after it.
 */
export function decodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)));
  }
  return out;
}

/** The `/L` a file declares, or null when it declares no linearization. */
export function declaredLength(bytes: Uint8Array): number | null {
  const head = decodeBytes(bytes.subarray(0, 2048));
  if (!head.includes('/Linearized')) return null;
  const match = /\/L\s+(\d+)/.exec(head);
  return match ? Number(match[1]) : null;
}

/**
 * Does this document declare linearization at all?
 *
 * The whole file, not just its head: the point of the check after a full
 * rewrite is that the parameter dictionary is GONE, and an orphaned copy of it
 * further down the file is exactly the thing that turned out to happen.
 */
export function isLinearized(bytes: Uint8Array): boolean {
  return decodeBytes(bytes).includes('/Linearized');
}
