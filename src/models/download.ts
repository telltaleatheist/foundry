/**
 * download — fetch a weight file and prove it is the right one.
 *
 * Ported from BookForge's `electron/components/downloader.ts`, stripped of the
 * component system it lived inside: no install phases, no IPC progress events,
 * no archive extraction (a GGUF is not an archive). What is left is the part
 * that matters — a streamed HTTPS GET with redirects, a sha256 computed as the
 * bytes arrive, and an atomic rename that only happens after the hash matches.
 *
 * Plain HTTP, deliberately. No `huggingface_hub`, no Python, no SDK. A single
 * file from a direct resolve URL needs none of it, and a download that can fail
 * because a Python environment is missing is a download that fails for reasons
 * having nothing to do with the network.
 *
 * The three properties this file exists to guarantee (ARCHITECTURE §6, §8):
 *
 *  - **Never a partial file at the real path.** Bytes land in `<dest>.part` and
 *    are renamed into place only on success. An interrupted download cannot be
 *    mistaken for an installed model, because it is not at the model's name.
 *  - **A hash mismatch is deleted and named.** Not warned about, not kept "just
 *    in case", not used. There is no probably-fine path: a GGUF that is one bit
 *    wrong either fails to load with a message about the file format, or loads
 *    and produces subtly worse output.
 *  - **No resume.** A partial from a previous run is discarded rather than
 *    appended to. Range-resume against a redirecting CDN, with no way to prove
 *    the remote file is the same one, is how you assemble a file out of two
 *    different revisions and get a checksum mismatch you cannot explain.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

/** How many redirects to follow. HuggingFace resolve URLs take one or two. */
const MAX_REDIRECTS = 10;

/**
 * How long a transfer may go without a single byte arriving before it is
 * abandoned.
 *
 * Not a total time limit — a 4 GB base model over a slow link legitimately
 * takes a long while, and a deadline on the whole transfer would punish exactly
 * the users who can least afford to restart it. This is an INACTIVITY timeout,
 * and it exists because a stalled connection is otherwise indistinguishable
 * from a slow one: a server that sends its headers and then nothing at all
 * leaves the client waiting forever, with no error and no output. Observed
 * while writing the tests for this file.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface DownloadProgress {
  /** 0–100, or 0 when the server sent no content-length. */
  pct: number;
  receivedBytes: number;
  /** 0 when unknown. */
  totalBytes: number;
}

export interface DownloadOptions {
  url: string;
  /** Final path. Written only after the hash verifies. */
  destPath: string;
  /** Expected sha256, lowercase hex. */
  sha256: string;
  /**
   * Expected size. Checked before the hash, purely so the error can say "the
   * transfer was cut short" instead of "checksum mismatch" — the same failure,
   * but one of them tells you where to look.
   */
  bytes?: number;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Abandon the transfer after this long with no bytes arriving. */
  idleTimeoutMs?: number;
}

/** sha256 of a file on disk, lowercase hex. Streamed — these files are large. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Download `url` to `destPath`, verifying sha256 before the file is put in
 * place. Throws on any failure, leaving nothing behind.
 *
 * The hash is computed on the stream rather than by re-reading the finished
 * file: a multi-gigabyte re-read is a minute of disk for a number we already
 * had every byte of.
 */
export async function downloadVerified(opts: DownloadOptions): Promise<void> {
  const { url, destPath, sha256, bytes, onProgress, signal, idleTimeoutMs } = opts;

  const expected = sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(
      `Refusing to download ${url}: the expected sha256 is not 64 hex characters `
      + `(got '${sha256}'). An unverifiable download is not a download we take.`,
    );
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;

  // A stale partial from a previous run: start clean rather than append. See
  // the "no resume" note in the file header.
  try {
    fs.unlinkSync(partPath);
  } catch {
    /* not there, which is the normal case */
  }

  let received: number;
  let actual: string;
  try {
    const result = await streamToFile(url, partPath, onProgress, signal, idleTimeoutMs);
    received = result.receivedBytes;
    actual = result.sha256;
  } catch (err) {
    unlinkQuietly(partPath);
    throw err;
  }

  if (bytes !== undefined && received !== bytes) {
    unlinkQuietly(partPath);
    throw new Error(
      `Download of ${url} is incomplete: got ${received} bytes, expected ${bytes}. `
      + `The partial file was deleted; re-run the pull.`,
    );
  }

  if (actual !== expected) {
    unlinkQuietly(partPath);
    throw new Error(
      `Checksum mismatch for ${url}\n`
      + `  expected sha256 ${expected}\n`
      + `  actual   sha256 ${actual}\n`
      + `The downloaded file was deleted and NOT installed at ${destPath}. `
      + `Either the transfer was corrupted, or the file at that URL is not the `
      + `one this build's catalog describes.`,
    );
  }

  // Same directory, so this is an atomic rename: no reader ever observes the
  // model's real path holding anything but a fully verified file.
  fs.renameSync(partPath, destPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function unlinkQuietly(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone, or never created */
  }
}

interface StreamResult {
  receivedBytes: number;
  sha256: string;
}

/**
 * Streamed GET with redirect following, progress, abort, and an on-the-fly
 * sha256.
 *
 * Structured as a callback promise rather than async/await because it is
 * driven by node's stream events, and because the redirect loop has to be able
 * to re-enter itself without unwinding.
 */
function streamToFile(
  url: string,
  destPath: string,
  onProgress: ((p: DownloadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number | undefined,
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Download of ${url} was cancelled before it started.`));
      return;
    }

    const hash = crypto.createHash('sha256');
    const file = fs.createWriteStream(destPath);
    let request: http.ClientRequest | null = null;
    let settled = false;
    let receivedBytes = 0;
    let bodyStarted = false;
    let bodyEnded = false;

    const idleMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Re-arm the inactivity timer. Called when the request goes out and again
     * on every chunk, so the clock measures the gap between bytes.
     *
     * Hand-rolled rather than `request.setTimeout()`, which Bun's node:http
     * accepts and never fires — a stalled download simply hung forever, and the
     * test for it hung with it.
     */
    const armIdle = (): void => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          request?.destroy();
        } catch {
          /* ignore */
        }
        fail(new Error(
          `Download of ${url} stalled: no data for ${Math.round(idleMs / 1000)}s `
          + `after ${receivedBytes} bytes. The partial file was deleted.`,
        ));
      }, idleMs);
      idleTimer.unref?.();
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const fail = (err: Error): void => {
      finish(() => {
        try {
          file.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      });
    };

    /**
     * A transport error once bytes were already flowing is a dropped transfer,
     * and saying so is worth the branch.
     *
     * The raw socket error for this is "The socket connection was closed
     * unexpectedly", which is true and useless: it does not say which download,
     * how far it got, or that the partial file was cleaned up. Reported as an
     * incomplete transfer it points at the network, which is where the problem
     * is — as opposed to a checksum mismatch, which points at the catalog.
     */
    const failTransport = (err: Error): void => {
      if (bodyStarted && !bodyEnded) {
        fail(new Error(
          `Download of ${url} is incomplete: the connection dropped after `
          + `${receivedBytes} bytes (${err.message}). The partial file was deleted.`,
        ));
        return;
      }
      fail(err);
    };

    function onAbort(): void {
      try {
        request?.destroy();
      } catch {
        /* ignore */
      }
      fail(new Error(`Download of ${url} was cancelled.`));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    file.on('error', (err) => fail(err));

    const get = (currentUrl: string, redirectsLeft: number): void => {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        fail(new Error(`Invalid download URL: ${currentUrl}`));
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        fail(new Error(`Unsupported protocol '${parsed.protocol}' in ${currentUrl}`));
        return;
      }

      const transport = parsed.protocol === 'https:' ? https : http;

      request = transport.get(currentUrl, (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            fail(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          get(new URL(response.headers.location, currentUrl).toString(), redirectsLeft - 1);
          return;
        }

        if (status !== 200) {
          response.resume();
          fail(new Error(`HTTP ${status} fetching ${currentUrl}`));
          return;
        }

        const totalBytes = Number.parseInt(response.headers['content-length'] ?? '0', 10) || 0;
        let lastPct = -1;
        bodyStarted = true;

        /**
         * A response that dies mid-body must reject, not hang.
         *
         * `pipe` only calls `end()` on the write stream when the source emits
         * 'end', so a socket that closes early leaves the file stream open and
         * 'finish' never fires — the download would wait forever on a
         * connection that is already gone. Usually a transport error fires too,
         * but 'close' without a preceding 'end' is the signal that is always
         * there.
         */
        response.on('end', () => {
          bodyEnded = true;
        });
        response.on('close', () => {
          if (bodyEnded) return;
          failTransport(new Error('the connection closed before the response body ended'));
        });

        response.on('data', (chunk: Buffer) => {
          armIdle();
          hash.update(chunk);
          receivedBytes += chunk.length;
          if (!onProgress) return;
          // Only on a whole-percent change: a 4 GB file is a hundred thousand
          // chunks, and a callback per chunk is a callback per 40 KB.
          const pct = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress({ pct, receivedBytes, totalBytes });
          }
        });

        response.on('error', (err) => failTransport(err));

        response.pipe(file);

        file.on('finish', () => {
          file.close((closeErr) => {
            if (closeErr) {
              fail(closeErr);
              return;
            }
            onProgress?.({
              pct: 100,
              receivedBytes,
              totalBytes: totalBytes || receivedBytes,
            });
            finish(() => resolve({ receivedBytes, sha256: hash.digest('hex') }));
          });
        });
      });

      request.on('error', (err) => failTransport(err));

      // Inactivity, not total duration — see DEFAULT_IDLE_TIMEOUT_MS.
      armIdle();
    };

    get(url, MAX_REDIRECTS);
  });
}
