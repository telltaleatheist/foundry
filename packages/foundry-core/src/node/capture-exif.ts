/**
 * capture-exif — when a photograph was taken, and the page order that follows from it.
 */
import type { CapturePage, CapturePhoto, CaptureSplit, CaptureTimeSource } from '../shared/types';
import { WHOLE_FRAME } from '../shared/capture';

// ─────────────────────────────────────────────────────────────────────────────
// When the photograph was taken
// ─────────────────────────────────────────────────────────────────────────────

/** `Exif\0\0` — the payload marker, and NOT the item declaration that shares it. */
export const EXIF_SIGNATURE = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/**
 * How far into the file the EXIF payload is allowed to be.
 *
 * Measured on the acceptance shoot: the payload begins between 31,653 and 35,731
 * bytes in, across all 27 files. 128 KiB is comfortably past that without
 * walking a 1.5 MiB file looking for a needle that is not there.
 */
export const EXIF_LIMIT = 128 * 1024;

export interface ExifTimes {
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
}

/**
 * Find the EXIF payload and read the two time tags out of it.
 *
 * ── THE FIRST MATCH IS A DECOY, IN EVERY FILE, AND THAT IS THE FINDING ──────
 *
 * Searching for `Exif\0\0` and trusting the first hit reads garbage: in ALL 27
 * files of the acceptance shoot the first occurrence is at offset 1554 (or 1864
 * in one), inside the `infe` box where the container DECLARES it holds an Exif
 * item, and the bytes after it are zeroes rather than a TIFF header. The real
 * payload is ~32 KiB further in, and it is the only one of the two that is
 * followed by a byte-order marker and the number 42.
 *
 * So this VALIDATES rather than trusts: every occurrence is examined, and the
 * first one that is actually a TIFF header wins. Measured across the shoot, that
 * rule finds exactly one candidate per file — the decoy never validates and the
 * payload always does.
 *
 * A BOUNDED SCAN AND NOT A BOX WALK, deliberately. A full ISOBMFF walk is the
 * more correct program and a much longer one, and its failure mode on a file
 * this scan cannot read is the same as this one's: no time, `mtime` recorded as
 * the source, nothing silent. The scan is what the acceptance shoot needed; the
 * walk is written the day a camera arrives that this refuses.
 */
export function readExifTimes(bytes: Buffer): ExifTimes {
  const none: ExifTimes = { dateTimeOriginal: null, offsetTimeOriginal: null };
  const hay = bytes.subarray(0, Math.min(bytes.length, EXIF_LIMIT));
  let tiff = -1;
  let bigEndian = false;
  for (let at = hay.indexOf(EXIF_SIGNATURE); at >= 0; at = hay.indexOf(EXIF_SIGNATURE, at + 1)) {
    const start = at + EXIF_SIGNATURE.length;
    if (start + 8 > bytes.length) break;
    const order = bytes.readUInt16BE(start);
    const be = order === 0x4d4d;
    if (!be && order !== 0x4949) continue;
    if ((be ? bytes.readUInt16BE(start + 2) : bytes.readUInt16LE(start + 2)) !== 42) continue;
    tiff = start;
    bigEndian = be;
    break;
  }
  if (tiff < 0) return none;

  const u16 = (at: number): number => (bigEndian ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at));
  const u32 = (at: number): number => (bigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at));

  /** The entries of one IFD, for the tags asked about and no others. */
  const readIfd = (at: number, wanted: readonly number[]): Map<number, string | number> => {
    const found = new Map<number, string | number>();
    if (at < 0 || at + 2 > bytes.length) return found;
    const entries = u16(at);
    for (let i = 0; i < entries; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      const tag = u16(entry);
      if (!wanted.includes(tag)) continue;
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      const width = type === 3 ? 2 : type === 4 ? 4 : 1;
      const size = width * count;
      if (size > 1024) continue; // a time is twenty bytes; anything else is not one
      const value = size <= 4 ? entry + 8 : tiff + u32(entry + 8);
      if (value < 0 || value + size > bytes.length) continue;
      found.set(tag, type === 2
        ? bytes.toString('latin1', value, value + count).replace(/\0[\s\S]*$/, '').trim()
        : u32(value));
    }
    return found;
  };

  const EXIF_IFD_POINTER = 0x8769;
  const DATE_TIME_ORIGINAL = 0x9003;
  const OFFSET_TIME_ORIGINAL = 0x9011;

  const subAt = readIfd(tiff + u32(tiff + 4), [EXIF_IFD_POINTER]).get(EXIF_IFD_POINTER);
  if (typeof subAt !== 'number') return none;
  const sub = readIfd(tiff + subAt, [DATE_TIME_ORIGINAL, OFFSET_TIME_ORIGINAL]);
  const taken = sub.get(DATE_TIME_ORIGINAL);
  const offset = sub.get(OFFSET_TIME_ORIGINAL);
  return {
    dateTimeOriginal: typeof taken === 'string' && taken.length > 0 ? taken : null,
    offsetTimeOriginal: typeof offset === 'string' && offset.length > 0 ? offset : null,
  };
}

export interface TakenAt {
  takenAt: string;
  takenAtSource: CaptureTimeSource;
}

/**
 * When this photograph was taken, as a UTC instant, and how sure we are.
 *
 * ── THE SORT IS THE CUSTOMER, AND IT IS WHY THE SOURCE IS RECORDED ──────────
 *
 * EXIF writes wall time with no zone: `2026:08:18 17:55:01` is what the clock in
 * the room said. The acceptance shoot also carries `OffsetTimeOriginal` (-04:00
 * on all 27), which turns that reading into an instant; a camera that omits it
 * leaves us interpreting the wall time in THIS machine's zone, which is right
 * for photographs taken here and wrong by hours for photographs that travelled.
 * Either way a single shoot sorts correctly, because every photograph in it is
 * wrong by the same amount.
 *
 * `takenAtSource` exists so that nothing downstream has to guess which of the
 * three answers it is holding, and so that a project whose order looks wrong can
 * be asked WHY rather than argued with. `mtime` is the honest last resort — a
 * file copied by a photo manager can carry a modification time that has nothing
 * to do with the shutter, and saying so is better than a confident wrong instant.
 */
export function takenAtFrom(times: ExifTimes, modifiedAt: Date): TakenAt {
  const stamp = times.dateTimeOriginal;
  const match = stamp === null
    ? null
    : /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (match === null) {
    return { takenAt: modifiedAt.toISOString(), takenAtSource: 'mtime' };
  }
  const [, year, month, day, hour, minute, second] = match;
  const offset = times.offsetTimeOriginal;
  if (offset !== null && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    const instant = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
    if (!Number.isNaN(instant.getTime())) {
      return { takenAt: instant.toISOString(), takenAtSource: 'exif-offset' };
    }
  }
  // No offset: the wall time is read in this machine's zone, and the record says
  // so rather than pretending the reading was UTC.
  const local = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  if (Number.isNaN(local.getTime())) {
    return { takenAt: modifiedAt.toISOString(), takenAtSource: 'mtime' };
  }
  return { takenAt: local.toISOString(), takenAtSource: 'exif-local' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Intake
// ─────────────────────────────────────────────────────────────────────────────

/*
 * THE WHOLE FRAME MOVED TO `shared/capture.ts`, where the editor can import it
 * too. It was spelled here and again in the editor as `wholeFrame()`, which is
 * the shape this feature keeps paying for — and the chord needed a third
 * spelling for "no pages at all", which is one more than anybody should have to
 * keep in agreement.
 */

export function pagesFor(photoId: string, from: CapturePhoto | null): {
  pages: CapturePage[];
  split: CaptureSplit | null;
  inherited: boolean;
} {
  // WHATEVER ITS SHAPE, since 2026-09-21: a late arrival takes the neighbour's
  // lines as every global now reaches every page (the ruling is under
  // `applyPopulations` in the renderer's service). The shape test that stood
  // here was a camera's rule, and a scan's pages are each their own size.
  if (from !== null && from.pages.length > 0) {
    return {
      pages: from.pages.map((page, index) => ({
        id: `${photoId}:${index}`,
        quad: page.quad,
        // A strike is a decision about a PAGE, never about a crop, so it is the
        // one thing a late arrival does not inherit: nobody has looked at this
        // photograph yet, and starting it struck would hide it in the grid.
        struck: false,
        // NOR THE HAND-SET MARK, for a sharper version of the same reason. It
        // says a person set THIS page themselves; a photograph that arrived
        // late and took its crop from a neighbour has been set by nobody. An
        // inherited mark would make the next global stamp skip the one
        // photograph on the table that has never been looked at, and name it
        // as work somebody would lose — which is the opposite of true.
      })),
      split: from.split,
      inherited: true,
    };
  }
  return {
    pages: [{ id: `${photoId}:0`, quad: WHOLE_FRAME, struck: false }],
    split: null,
    inherited: false,
  };
}
