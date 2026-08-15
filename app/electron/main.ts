/**
 * main — the window, the protocol that shows a PDF, and the IPC surface.
 *
 * Everything with a lifetime lives in main: the job queue (electron/job-queue.ts)
 * because a renderer reload must not be able to kill an hour of GPU, and the
 * engine's identity (electron/engine.ts) because the renderer is not allowed to
 * name a program to run.
 *
 * The renderer has no Node: `nodeIntegration: false`, `contextIsolation: true`,
 * and one contextBridge API (electron/preload.ts).
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';

import { readAppSettings, writeAppSettings } from './app-settings';
import { cancelSetup, setupWslEnv } from './backend-setup';
import { injectReporter, REPORTER_ID, REPORTER_MEMBER, REPORTER_SOURCE, sanitizeChapter } from './click-reporter';
import {
  engineInfo,
  finalizeEpub,
  readEpubMetadata,
  readPdfBlocks,
  readPdfMetadata,
  runDoctor,
  writeEpubMetadata,
  writePdfMetadata,
} from './engine';
import { catalogForThisMachine, onEnvInstallProgress } from './env-install';
import { planProvisioning } from './env-provision';
import {
  closeAllEpubs,
  closeEpub,
  exportWorkingCopy,
  isFoundryBook,
  navEchoForBlock,
  openBookIn,
  openEpub,
  projectOf,
  readEpubMember,
  renameEpubHeading,
  renameEpubPageHeading,
  repackEpub,
  resolveEpubMember,
  restoreBlockHtml,
  setBlockCategories,
  setBlockCuts,
  setBlockHtml,
  setNoteCut,
  stampBook,
  workingTreeOf,
  writeEpubMember,
} from './epub-reader';
import { loadLedger, saveLedger } from './history';
import * as queue from './job-queue';
import {
  commitOverlay,
  loadOverlayFile,
  loadOverlayLedger,
  locateOverlay,
  saveOverlayFile,
  saveOverlayLedger,
  uncommittedIn,
} from './overlays';
import {
  adoptLegacyLayout,
  deletableStep,
  deleteDocument,
  deleteProject,
  deleteStep,
  describeStepDelete,
  documentAssets,
  documentAtPosition,
  finalDir,
  goToStep,
  importDocument,
  inspectProject,
  type ProjectInventory,
  isArchived,
  isManaged,
  ledgerOf,
  listProjects,
  noteProjectTitle,
  onProjectsChanged,
  positionStepId,
  projectDirOf,
  promoteStrandedReprints,
  readManifest,
  readStepLedger,
  readingIsComplete,
  recordFinal,
  standForDocument,
} from './projects';
import {
  clearRecents,
  forgetRecent,
  forgetRecentsUnder,
  listRecents,
  rememberRecent,
} from './recents';
import { readSettings, writeSettings } from './settings';
import * as vllm from './vllm-server';
import { planConversion, planExport, planReading, planTranslation } from './workspace';
import { detectEnvTooling, listDistros } from './wsl';
import { fold, isBook } from '../shared/original';
import { OverlayError, type OverlayFile } from '../shared/overlay';
import { positionView } from '../shared/ledger';
import type { ReadAsk } from '../shared/ledger';
import { RE_READ_CANCEL, RE_READ_PROCEED } from '../shared/reread';
import type { ReReadPrompt } from '../shared/reread';
import type { MenuAction } from '../shared/api';
import type {
  AppQuestion,
  Asked,
  BackendSettingsPatch,
  CloseAnswer,
  CloseWarning,
  ConversionKind,
  DeletionPrompt,
  DocumentDeletion,
  EchoAnswer,
  EchoStanding,
  EnvInstallRequest,
  HeadingEcho,
  JobRequest,
  LedgerStacks,
  NavEcho,
  OverlayFileWire,
  ProjectDocument,
  ProjectSummary,
  RecentKind,
  ReReadAnswer,
  SetupRequest,
  TranslateRequest,
  UncommittedCuration,
  UnlinkedNote,
  UnlinkedNoteAnswer,
  UnlinkedNoteStanding,
} from '../shared/types';

const isDev = process.argv.includes('--dev');
const DEV_SERVER = 'http://localhost:4260';

let mainWindow: BrowserWindow | null = null;

/**
 * The closing question's buttons — the words, beside the answers they mean.
 *
 * ── The lookup table that used to be here, and why it is gone ───────────────
 *
 * A NATIVE BOX ANSWERED WITH AN INDEX, and an index was the wrong thing for this
 * dialog to hold in its head: the box had two buttons for a file copy and three
 * for a set of corrections, so `response === 0` meant "close it" in one shape and
 * "save first" in the other. Two shapes, two meanings, one number — and the way
 * that went wrong was silent, because both were valid answers and neither threw.
 * The defence was to look the answer up by its own LABEL, through a `Record` that
 * lived right here.
 *
 * The card answers with the KEY of the button that was pressed, and the key is a
 * `CloseAnswer` — so the label is now nothing but the words on a button, the
 * table has nobody left to serve, and the compiler checks what a `Record` keyed
 * by prose used to check at runtime. The labels stay written once because two
 * spellings of one button is still two spellings.
 */
const SAVE = 'Save these corrections, then close';
const CLOSE = 'Close it';
const KEEP = 'Keep it open';

// ─────────────────────────────────────────────────────────────────────────────
// foundry-file:// — how a book's chapters reach an <iframe>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The renderer is a page on http://localhost:4260 (dev) or file:// (packaged),
 * and neither may point an <iframe> at an arbitrary `file://` URL. So the app
 * serves the bytes itself, on a scheme of its own.
 *
 * ONE HOST: `foundry-file://epub/<book id>/<path inside the book>` — a chapter
 * out of an unpacked EPUB. PATH-shaped and not query-shaped because an XHTML
 * document resolves `style.css` and `img/plate-3.png` RELATIVELY: served from a
 * query string, every one of those would resolve to a URL with no `?p=` at all
 * and the book would render unstyled and pictureless.
 *
 * There USED to be a second host — `foundry-file://open/?p=<abs path>`, a whole
 * PDF for Chromium's built-in viewer — and it is gone with the viewer: PDFs go
 * to the app's own pdf.js component through `document:read-bytes` now, and a
 * serving route with no consumer is a door into files on disk kept open for
 * nobody. Members are ALLOW-LISTED, not path-checked: servable only if in the
 * set of files that unpack actually wrote (epub-reader.ts). A renderer that was
 * talked into asking for `C:\Users\…\id_rsa` gets a 403, rather than a cleverer
 * path check that has to stay right forever.
 */
const openable = new Set<string>();

/**
 * The allow-list question, asked in ONE place — today for one caller,
 * `document:read-bytes`, which hands an opened document to the app's own pdf.js
 * viewer. Kept as a named function rather than inlined so the next door that
 * needs the answer asks HERE: a second copy of `openable.has(path.resolve(…))`
 * is a second authorization path, and the day one copy learns a new rule is the
 * day the other one is a hole. Null means no.
 */
/**
 * Whether a path sits inside a directory, on Windows' terms.
 *
 * Case-insensitively and separator-blind, because one folder is spelled three
 * ways here, and with the separator APPENDED to the folder first — so a project
 * called `Kershaw-a1b2c3d4` cannot claim a job writing into
 * `Kershaw-a1b2c3d4-notes` beside it and block a delete that has nothing to do
 * with it.
 *
 * Note what this is NOT: it is not the check that decides what may be erased.
 * That is `deletableProjectDir`, which proves a path is a direct child of the
 * projects directory. This one only answers "is that run writing in here".
 */
function within(dir: string, filePath: string): boolean {
  const fold = (target: string): string => path.resolve(target).replace(/\\/g, '/').toLowerCase();
  return fold(filePath).startsWith(`${fold(dir).replace(/\/+$/, '')}/`);
}

/**
 * Where each open book may be saved. See `epub:open` for the two ways in.
 *
 * AT MODULE SCOPE rather than inside `registerIpc`, because a grant now has to be
 * REVOKED from outside the IPC surface: when a document opened from the user's
 * own disk is relocated onto the project's copy of it, the grant that named their
 * file has to go with it, or Save would go on writing to a path this app no
 * longer claims to be showing. See `revokeSaveGrants`.
 */
const saveGrants = new Map<string, Set<string>>();
const grantKey = (destination: string): string => path.resolve(destination).toLowerCase();

/**
 * Take back every grant naming this destination.
 *
 * ── THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY ──────────────────────
 *
 * A book opened from somewhere else grants plain Save to THAT file, deliberately:
 * it is a copy the user chose, and updating it is what they mean by Save. Then
 * the import lands and the tab moves onto the project's copy — and the grant
 * stayed behind, pointing at a path the tab no longer shows. Save would have
 * repacked the working tree over the user's own EPUB while every label on screen
 * said the document was the library's.
 *
 * So the grant is revoked at the move. The book keeps its edits, its tree and its
 * history; what it loses is a silent write target, and Save As — main's own
 * dialog, which grants what the user picks — is the door out.
 */
function revokeSaveGrants(destination: string): void {
  const key = grantKey(destination);
  for (const grants of saveGrants.values()) grants.delete(key);
}

function admitted(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  return openable.has(resolved) ? resolved : null;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'foundry-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * Extension -> content type, for the handful of things a foundry EPUB contains.
 *
 * Chromium decides what to DO with a response from this header and nothing else
 * — an XHTML chapter served as octet-stream downloads instead of rendering, and
 * a stylesheet served as text/plain is dropped by the strict MIME check. There
 * is no sniffing fallback on purpose: an unknown extension is served as a
 * download rather than guessed into being executable.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.opf': 'application/oebps-package+xml',
  '.ncx': 'application/x-dtbncx+xml',
  '.xml': 'application/xml',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The policy imposed on a BOOK's own documents — not on the app's page.
 *
 * The chapters come out of a file the user handed us. They are foundry's own
 * markup in every expected case, but "expected" is not a guarantee, and the
 * viewer's <iframe> also carries `sandbox="allow-scripts"` (opaque origin, no
 * same-origin power). This is the second lock: nothing loads but the book's own
 * files on this scheme, and `default-src 'none'` means an omitted directive is
 * a refusal rather than a hole. `'self'` is deliberately NOT used — a sandboxed
 * frame has an opaque origin that `'self'` can never match, and the stylesheet
 * would silently fail.
 *
 * A caveat this file must not lie about: response-header CSP is MEASURABLY NOT
 * ENFORCED for documents on this custom scheme (eval ran in a frame carrying
 * `script-src 'nonce-…'`), and neither is MIME blocking. What actually keeps a
 * book's own scripts dead is `sanitizeChapter` (electron/click-reporter.ts) —
 * chapters are stripped of active content at serve time and exactly one
 * app-owned script is injected after. The policy below is still sent, nonce
 * and all, because it costs nothing and starts working the day Electron
 * enforces it here.
 */
const EPUB_CSP = [
  "default-src 'none'",
  'style-src foundry-file: \'unsafe-inline\'',
  'img-src foundry-file: data:',
  'font-src foundry-file: data:',
  'media-src foundry-file: data:',
  "object-src 'none'",
  "form-action 'none'",
].join('; ');

/** Every epub-host response carries these; see the CSP note above. */
const EPUB_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': EPUB_CSP,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Stream a file as a response, or say why not. Shared by both hosts. */
async function serveFile(
  resolved: string,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<Response> {
  try {
    const stat = await fsp.stat(resolved);
    // Streamed rather than buffered: a scanned book is hundreds of megabytes
    // and the whole point of handing it to Chromium's viewer is not holding it.
    const body = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
    return new Response(body, {
      headers: {
        'content-type': contentTypeFor(resolved),
        'content-length': String(stat.size),
        'content-disposition': `inline; filename="${path.basename(resolved)}"`,
        ...extraHeaders,
      },
    });
  } catch (err) {
    // The one case worth a second opinion: a file that vanished between the
    // open and the read. net.fetch reports it in file:// terms.
    try {
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response(`Could not read ${resolved}: ${(err as Error).message}`, { status: 404 });
    }
  }
}

function registerFileProtocol(): void {
  protocol.handle('foundry-file', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('That is not a URL this app serves.', { status: 400 });
    }

    if (url.host === 'epub') {
      // `/<book id>/<member path>`. The member path keeps its slashes and is
      // decoded segment by segment, because a chapter called `Ch 1.xhtml` was
      // encoded that way and `decodeURIComponent` on the whole path would also
      // decode an encoded slash into a path separator.
      const segments = url.pathname.split('/').filter((part) => part.length > 0);
      const id = segments.shift();
      if (id === undefined || segments.length === 0) {
        return new Response('No book and member were named.', { status: 400 });
      }
      const member = segments.map(decodeURIComponent).join('/');

      // The app's own support files, on an id no book can have (ids are UUIDs).
      // The one script the CSP-and-MIME chain lets execute — click-reporter.ts.
      if (id === REPORTER_ID) {
        if (member !== REPORTER_MEMBER) return new Response('Not a support file.', { status: 404 });
        return new Response(REPORTER_SOURCE, {
          headers: {
            'content-type': 'text/javascript',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      const resolved = resolveEpubMember(id, member);
      if (resolved === null) {
        return new Response('That book is not open in this app.', { status: 403 });
      }
      // `no-store` (in EPUB_HEADERS) because these bytes CHANGE: the HTML editor
      // writes a chapter and the pane reloads it, and a cached 200 would show
      // the version from before the edit. The `?v=` on the URL already defeats
      // the memory cache; this defeats anything else tempted to keep a copy.

      // A chapter document gets the click reporter spliced in ON THE WAY OUT —
      // buffered rather than streamed, which a few hundred kilobytes of XHTML
      // can afford. The disk copy, read-member and every repack stay untouched;
      // everything that is not a chapter still streams.
      const extension = path.extname(resolved).toLowerCase();
      if (extension === '.xhtml' || extension === '.html' || extension === '.htm') {
        try {
          const nonce = randomUUID().replace(/-/g, '');
          // Sanitize FIRST, then inject: the reporter must be the one script
          // the stripping pass never saw. click-reporter.ts owns the argument
          // for why stripping — not CSP, not MIME — is the enforcement here.
          const markup = injectReporter(sanitizeChapter(await fsp.readFile(resolved, 'utf8')), nonce);
          return new Response(markup, {
            headers: {
              'content-type': contentTypeFor(resolved),
              ...EPUB_HEADERS,
              // The chapter's own policy REPLACES the shared one: same
              // directives plus the nonce that authorizes exactly one script.
              'content-security-policy': `${EPUB_CSP}; script-src 'nonce-${nonce}'`,
            },
          });
        } catch (err) {
          return new Response(`Could not read ${resolved}: ${(err as Error).message}`, { status: 404 });
        }
      }
      return serveFile(resolved, EPUB_HEADERS);
    }

    // The old `open` host served whole PDFs to Chromium's viewer; the viewer is
    // gone and so is the route. 404 rather than silence, so a stale URL says
    // what happened to it.
    return new Response('This app no longer serves whole files; books only.', { status: 404 });
  });
}

/**
 * The renderer's Content-Security-Policy, on the DOCUMENT only.
 *
 * `frame-src foundry-file:` is the whole reason this is written by hand: the
 * viewer's <iframe> is the one cross-scheme thing the page is allowed to load.
 * `'unsafe-inline'` is on styles alone — Angular emits component styles inline —
 * and never on scripts.
 *
 * Not applied to the PDF's own response: Chromium's PDF viewer is an extension
 * frame with its own requirements, and a policy written for the app's page has
 * no business being imposed on it. Not applied in dev either, where the page is
 * served by ng serve over a websocket the policy would have to name.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  'frame-src foundry-file:',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function applyContentSecurityPolicy(): void {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith('file://')) {
      callback({});
      return;
    }
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening a document
// ─────────────────────────────────────────────────────────────────────────────

/** The two extensions this app opens, and the only two the allow-list admits. */
const OPENABLE_EXTENSIONS: Readonly<Record<string, RecentKind>> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
};

/**
 * Admit a path and tell every window about it. The single door: the menu, the
 * dialog, a drop, argv and a finished conversion all come through here, so the
 * allow-list and the tabs can never disagree about which files are open.
 *
 * EPUBs join PDFs here because the app now produces them and opens what it
 * produces. The renderer decides which of the two viewers a tab gets; main only
 * decides whether the file is one this app will read at all.
 */
async function openDocument(candidate: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  const kind = OPENABLE_EXTENSIONS[path.extname(resolved).toLowerCase()];
  if (kind === undefined) return null;
  try {
    await fsp.access(resolved);
  } catch {
    return null;
  }
  openable.add(resolved);
  // Recorded here and only here, for the same reason the allow-list is: this is
  // the one function every open passes through. A document already inside a
  // project is remembered too, and flagged, because a tab closed by accident has
  // to be findable again from Home.
  rememberRecent(resolved, kind, path.basename(resolved), isManaged(resolved));
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('document:opened', resolved);
  }
  /*
   * A file from outside the library becomes a PROJECT — hashed, given a folder,
   * copied into `archive/` as the untouched original and again into the layer
   * the user actually works with. Never moved and never written: their file
   * stays exactly where they put it.
   *
   * AFTER the tab has been told to open, and not awaited, deliberately. Keying a
   * project is a full sha256 of the document and importing it is two copies; on
   * a 400 MB scan that is seconds, and a window that sat still for seconds after
   * a drop would read as an app that had missed the file. Nothing downstream
   * waits on this — `epub:open` imports for itself, and the two calls land on
   * the same project because the work is serialised per folder (projects.ts).
   *
   * A failure is a console line naming the file rather than a dialog: the
   * document IS open and readable, and what has been lost is a folder to put its
   * conversions in — which the next conversion would make anyway.
   */
  void importDocument(resolved, kind).then(async (imported) => {
    // A stamping refusal is a NOTICE, not a failure, and this call is the
    // background one — the tab's own `epub:open` import carries the same
    // sentence to the notice strip, where somebody will read it.
    if (imported.notice !== null) console.warn(`[projects] ${imported.notice}`);
    /*
     * ── AND THE TAB MOVES ONTO THE WORKING COPY ────────────────────────────
     *
     * THE BUG THIS EXISTS FOR COST A USER THEIR WHOLE PIPELINE, and it was
     * invisible because everything about it looked right. They opened their own
     * scan off `E:\Shared\…\archive\Working Towards The Fuhrer…pdf`; the import
     * made the project, the OCR read landed, the bank and its completion marker
     * were on the disk and the catalogue recorded them. Then Generate said "this
     * book has not been read yet" — because the TAB was still pointed at the
     * `E:\` file, `projectFor()` on that path answers null, and every question
     * this app asks about "the document in front of you" is asked of the tab's
     * path. Restarting did not help: it was never staleness, it was identity.
     *
     * THE WORKING-COPY MODEL IS THE ANSWER AND IT WAS ALREADY THE MODEL. A file
     * from outside the library is imported, and what the user then holds is the
     * PROJECT's copy — "the PDF" — with their own file untouched where they put
     * it. The one place that was not true was the tab, which kept the path the
     * open came in on because that is what the fast path had in its hand.
     *
     * So the fast open stays exactly as it is — a 400 MB sha256 must not sit
     * between somebody and their document — and the tab is MOVED when the import
     * lands. `imported.entry` is the live layer's own file (`working/<stem>.pdf`,
     * `generated/<stem>.epub`), which is the same answer `epub:open` reaches by
     * its own route, so both kinds end up naming what this app actually works on.
     *
     * MAIN OPENS IT, SO MAIN ADMITS IT: the renderer is about to name this path
     * to the viewer, the metadata dialog and the block editor, and every one of
     * those doors asks the allow-list.
     */
    const working = path.join(imported.dir, ...imported.entry.split('/'));
    if (working.toLowerCase() !== resolved.toLowerCase() && await stillThere(working)) {
      openable.add(working);
      /*
       * AND RECENTS FOLLOWS IT. The row is what Home and the reopen path use, so
       * a row naming the outside original would send somebody straight back into
       * the state this fixes. The outside row is forgotten rather than left
       * beside the new one: they are one book, and two rows for it is a list
       * that asks a question with no right answer.
       */
      forgetRecent(resolved);
      rememberRecent(working, kind, path.basename(working), true);
      // And the write grant their own file carried goes with it. See
      // `revokeSaveGrants`: the tab is about to stop showing that path, and a
      // Save that still wrote to it would be this app editing a document it is
      // no longer displaying.
      revokeSaveGrants(resolved);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('document:relocated', { from: resolved, to: working });
      }
    }
    /*
     * The PDF's own idea of its title, noted the way a cast EPUB's `dc:title`
     * is when it is first opened (epub-reader.ts) — because for a project that
     * is only ever a PDF, this import is the ONLY moment anything asks. Behind
     * the same not-awaited import, for the same reason: it is a spawn, and a
     * display name is not worth making a drop feel missed over. Scans mostly
     * answer with nothing, and nothing is noted — the row keeps its spoken
     * stem until a conversion produces a book that knows its own name.
     */
    if (kind === 'pdf') {
      const meta = await readPdfMetadata(resolved);
      if (meta.ok && meta.metadata.kind === 'pdf' && meta.metadata.fields.title !== null) {
        await noteProjectTitle(imported.dir, meta.metadata.fields.title);
      }
    }
  }).catch((err: Error) => {
    console.error(`[projects] ${resolved} could not be imported into a project: ${err.message}`);
  });
  return resolved;
}

/** Is it on the disk? A missing working copy is a swap that must not happen. */
async function stillThere(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A document named on the command line — `foundry-app book.pdf`, and what
 * Windows hands the app when a .pdf is opened with it. Options are skipped, so
 * `electron . --dev book.pdf` finds the book and not the flag.
 */
function documentFromArgv(argv: readonly string[]): string | null {
  return argv.slice(1).find((arg) => {
    if (arg.startsWith('-')) return false;
    return OPENABLE_EXTENSIONS[path.extname(arg).toLowerCase()] !== undefined;
  }) ?? null;
}

async function promptForDocument(): Promise<string | null> {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: 'Open a document',
    properties: ['openFile' as const],
    filters: [
      { name: 'Books and scans', extensions: ['pdf', 'epub'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'EPUB', extensions: ['epub'] },
    ],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;
  return openDocument(chosen);
}

// ─────────────────────────────────────────────────────────────────────────────
// Window + menu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The window is allowed to go — every open document has been asked what closing
 * it costs, and answered.
 *
 * ── Why quitting needs a flag at all ────────────────────────────────────────
 *
 * Quit used to bypass per-tab closing entirely: the window was destroyed, the
 * tabs went with it, and none of them was ever asked the question the ✕ on a tab
 * asks. That was survivable while the only thing at stake was a file copy, and it
 * is not now — closing a scan is the moment a session's undo history stops
 * existing, so a quit was a silent conversion of "undoable" into "permanent" for
 * every book in the window at once.
 *
 * The ask has to happen BEFORE `before-quit`'s own body, not after it, and that
 * is the reason this is one flag consulted in two places rather than a guard in
 * the window's `close` alone. `before-quit` aborts every running job and stops the
 * reading server; a person who answered "keep it open" to a dialog raised after
 * all that would have kept their window and lost the three-hour run in it.
 */
let letGo = false;

/**
 * The renderer's promised answer to `window:closing`, held while the dialogs are
 * up — or null when nothing has been asked.
 *
 * ONE AT A TIME, because a second ✕ pressed while the first question is on screen
 * is the same question, and answering it twice would resolve a promise that has
 * already decided the window's fate.
 */
let letGoAnswer: ((go: boolean) => void) | null = null;

/**
 * Whether there is a renderer to ask. Set when the window has actually loaded.
 *
 * WITHOUT THIS THE APP CANNOT BE QUIT after a renderer that failed to load. The
 * question goes out over `webContents.send`, and a page that never ran subscribes
 * to nothing and answers nothing — so the quit would be prevented forever by a
 * dialog nobody could see. A window with no renderer has no open documents, and
 * therefore nothing to ask about.
 */
let rendererLoaded = false;

/**
 * Ask the window's documents, then do the thing that was interrupted.
 *
 * The renderer runs the per-document question — it is the side that knows what is
 * open — and answers once through `window:let-go`. False is the user saying keep
 * it open, and then nothing happens at all: no close, no quit, and whatever
 * `before-quit` was about to shut down is still running.
 */
function letTheWindowGo(then: () => void): void {
  const contents = mainWindow?.webContents;
  const answer = !rendererLoaded || contents === undefined || contents.isDestroyed()
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
      if (letGoAnswer !== null) {
        // Already asking. The second press is the same question, and it waits for
        // the first one's answer rather than raising a second stack of dialogs.
        resolve(false);
        return;
      }
      letGoAnswer = resolve;
      contents.send('window:closing');
    });
  void answer.then((go) => {
    if (!go) return;
    letGo = true;
    then();
  });
}

function createWindow(): void {
  // A window built after the last one was closed starts owing the question again.
  letGo = false;
  rendererLoaded = false;
  letGoAnswer = null;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    // --bg-base in app/src/styles.scss. A mismatch here is the colour the
    // window flashes for the frame before the renderer paints.
    backgroundColor: '#181715',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  /*
   * The APP does not zoom. Chromium persists page zoom per origin across
   * launches, so one accidental Ctrl+- used to leave the whole interface at a
   * fraction of itself forever — toolbar, tabs, everything — with nothing in
   * the app able to explain why. The zoom roles are gone from the View menu
   * (below) so it cannot happen again; this line clears whatever zoom a
   * previous launch already recorded. Pinch is pinned too: the PDF viewer
   * turns pinch and Ctrl+wheel into DOCUMENT zoom, which is the one kind of
   * bigger this app means.
   */
  mainWindow.webContents.on('did-finish-load', () => {
    rendererLoaded = true;
    mainWindow?.webContents.setZoomFactor(1);
    void mainWindow?.webContents.setVisualZoomLevelLimits(1, 1);
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER);
  } else {
    // dist/electron -> dist -> app; the renderer build lands in dist/renderer.
    const index = path.join(__dirname, '..', 'renderer', 'browser', 'index.html');
    mainWindow.loadFile(index).catch((err: Error) => {
      void mainWindow?.loadURL(
        'data:text/html,'
        + encodeURIComponent(
          `<body style="background:#181715;color:#faf9f7;font:13px 'Segoe UI',system-ui;padding:40px">
           <h1>The renderer did not load</h1><p>${err.message}</p><p>${index}</p>
           <p>Run <code>npm run build</code> first, or <code>npm start</code> for the dev server.</p>
           </body>`,
        ),
      );
    });
  }

  // A document named on the command line, handed over once there is a renderer
  // listening. `document:opened` is a push, so sending it earlier sends it to
  // nobody.
  mainWindow.webContents.once('did-finish-load', () => {
    const named = documentFromArgv(process.argv);
    if (named) void openDocument(named);
    // The environments this machine is missing, as shelf rows. Not awaited: the
    // window is already usable, and a doctor run is seconds.
    void provision();
  });

  // A dropped file must not NAVIGATE the window to itself — the drop is handled
  // in the renderer and answered over IPC.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(DEV_SERVER) && !url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // A run from source forwards the renderer's console and its title to the
  // terminal that started it. Not a debug flag: without it, a renderer that
  // threw during bootstrap is a black window and a silent terminal, and the
  // title line is the one signal that says Angular actually ran.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.on('page-title-updated', (_event, title) => {
      console.log(`[renderer] title: ${title}`);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
    });
  }

  /**
   * The ✕ on the window, and the OS asking it to go.
   *
   * Prevented ONCE, so that the documents in it can be asked what closing them
   * costs, and then let through on the second pass. On Windows and Linux this is
   * also the front half of a quit: closing the last window fires
   * `window-all-closed`, which quits — so the question reaches a person who never
   * touched a tab's ✕ and never opened the File menu.
   */
  mainWindow.on('close', (event) => {
    if (letGo) return;
    event.preventDefault();
    letTheWindowGo(() => mainWindow?.close());
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * A menu item the RENDERER has to carry out, because the thing it acts on is a
 * tab and tabs are renderer state.
 *
 * On the menu rather than as a `keydown` in the renderer: both would fire for
 * one keypress, and only one of the two is discoverable by a person who has
 * never used this app. Ctrl+Tab is the exception and stays in the renderer — a
 * menu item labelled "Next tab" is noise, and cycling is not a File operation.
 */
function sendMenuAction(action: MenuAction): void {
  mainWindow?.webContents.send('menu:action', action);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void promptForDocument(); },
        },
        {
          /**
           * ── ONE MATERIALISING VERB, WHERE THERE WERE TWO SAVES ──────────────
           *
           * This was Save and Save As. Save wrote the book back to the file the
           * user had already chosen and Save As asked for a new one — the pair
           * every editor has, and the right pair for an app whose document IS a
           * file. It is not that app any more. What a pane shows is a projection of
           * a bank, and there is no version of "write this back" that means
           * anything about a projection: the durable thing is the bank and the
           * ledger, both of which are written the moment anything changes.
           *
           * So the gesture people actually want from here is the one they always
           * meant by Save — GIVE ME THE FINISHED THING — and the user ruled where
           * it lives: "there will be no 'save a copy' or 'save' buttons along the
           * top of panels. those buttons are reserved for the export modal that
           * pops up when you click the export button on the nav rail." One item,
           * one modal, and it asks the only question that is left: which format.
           *
           * IT KEEPS CTRL+S, deliberately. The chord is where a person's hand goes
           * when they want their work out of an app, it is now free, and pointing
           * it anywhere else would leave the most-pressed shortcut in software
           * doing nothing in a document application.
           *
           * MAIN CANNOT OPEN THE MODAL — which pane, which project and which step
           * are renderer state — so it says `export` and the renderer routes it,
           * exactly as `save` was routed before it.
           */
          label: 'Export…',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('export'),
        },
        {
          label: 'Close tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendMenuAction('close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('navigate', '/settings'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      /**
       * THE EDIT MENU IS OURS NOW, and only because of Undo.
       *
       * It was `{ role: 'editMenu' }` — the platform's own, whose Undo is
       * `webContents.undo()`, which means the focused text field's undo and
       * nothing else. There is a DOCUMENT history now (TabsService), and
       * Ctrl/Cmd+Z has to be able to reach it, so the two items are ours and
       * the renderer decides which of the two things the chord meant: a caret
       * in a text box gets the box's own undo, a caret in a block gets the
       * frame's, and anything else gets the book's.
       *
       * ON THE MENU RATHER THAN AS A RENDERER `keydown`, for the reason every
       * other chord in this file is: a menu item with the accelerator on it and
       * a keydown listener for the same chord BOTH fire, and only the menu is
       * discoverable by somebody who has never used this app. The label is also
       * the only place "undo" is promised, which matters more here than for
       * Save — an editor whose undo does nothing is worse than one with none.
       *
       * The clipboard roles below are kept verbatim from the role menu, because
       * they are the platform's and there is no reason for this app to have an
       * opinion about Copy.
       */
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendMenuAction('undo'),
        },
        {
          label: 'Redo',
          // Ctrl+Shift+Z on both, rather than the Ctrl+Y some Windows apps use:
          // one chord, said one way, and it is the one the editors this app
          // sits beside all take.
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => sendMenuAction('redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      // No zoom roles, on purpose: they scale the APPLICATION — every button
      // and tab, persisted by Chromium across launches — which is never what
      // anybody meant in a document app. Zooming a DOCUMENT is the PDF
      // viewer's own Ctrl+wheel/pinch and +/− buttons.
      submenu: [
        {
          /**
           * The one place the split is DISCOVERABLE.
           *
           * A single-pane workspace is meant to look exactly like the app that
           * had no panes at all — no divider, no split button, nothing hinting
           * at a second column — so a person who has never used the feature
           * would never find it on screen. They find it here. (Ctrl+\ is VS
           * Code's chord for the same operation.) It opens an EMPTY column
           * beside the focused one, which the user then fills from the document
           * list; main owns none of that and only says "split".
           */
          label: 'Split right',
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendMenuAction('split-right'),
        },
        {
          /**
           * The open-documents panel, hidden and brought back.
           *
           * NOT A CHECKBOX ITEM, though it toggles: whether the panel is up is
           * renderer state (it also depends on whether anything is open at all),
           * and a menu that drew its own tick from a value main is guessing at
           * would be wrong the first time the two disagreed. Ctrl+B is the chord
           * every editor with a side panel uses.
           */
          label: 'Documents',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-documents'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A byte count as a person reads it — for the delete dialog, which has to say
 * how much of the disk is about to be handed back.
 *
 * Binary units, one decimal, and no `Intl` unit formatting: this goes into a
 * sentence that already reads plainly, and "1.4 GB" is the whole of what is
 * being communicated.
 */
function sizeOnDisk(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The projects a fallback has already sent to the caster in this run of the app.
 *
 * ONE ASK PER PROJECT, and it is a stop rather than an optimisation. Everything
 * downstream converges — `enqueue` joins a duplicate row, `ensureCast` covers the
 * window before it, and a landed cast makes the fallback stop firing because the
 * position resolves to the book instead — but the shape underneath is a cycle: a
 * landing announces the projects, the renderer re-asks which document is at the
 * position, and this handler answers. If a cast ever landed WITHOUT the position
 * coming to resolve to it, that cycle would spawn the engine once per repaint,
 * forever, for a project this app has already demonstrated it cannot cast. So the
 * app tries once, says so in the terminal if it fails, and leaves the person with
 * their scan and an Export button rather than with a machine that will not stop.
 *
 * A reading that lands casts its own book (`job-queue.ts`) and is not gated by
 * this — that path is the one that is SUPPOSED to run again for a new reading.
 */
const castAsked = new Set<string>();

/**
 * THE POSITION SHOULD ALWAYS BE MOVING TOWARD THE FLOWING BOOK.
 *
 * ── The ruling, and what the fallback was quietly doing instead ─────────────
 *
 * User, 2026-08-15: *"if i click the ocr/read step, it should show the reflowed
 * html. it should always move toward the html, since thats a format we can work
 * with."* `documentAtPosition` (electron/projects.ts) answers a read or curate
 * row with the cast book and falls back to the working PDF when there is none —
 * which is correct as an ANSWER (a pane must show something that exists) and is
 * the wrong place to stop. The projects that take the fallback are the ones that
 * were read before casting was automatic, and the ones whose cast was rotated or
 * deleted; for all of them the bank is on disk, complete, and a book out of it is
 * seconds of arithmetic. Settling for the photograph is the app declining to make
 * the one format everything after this step works on.
 *
 * ── What identifies a fallback, without re-deriving main's own resolution ───
 *
 * Two facts, both read off the same catalogue the resolution read: the position
 * is NOT a row that shows its own payload (so it is a read or a curate, not the
 * import and not a translation), and what came back is a PDF. The flowing book is
 * never a PDF, so those two together are the fallback and nothing else is. The
 * bank has to be marked complete as well — the same test every Generate asks
 * (`readingIsComplete`) — because a resume is a reading, and a reading is hours
 * of a model spent by a click on a history row.
 */
async function towardTheFlowingBook(resolved: string): Promise<void> {
  if (path.extname(resolved).toLowerCase() !== '.pdf') return;
  // The document came out of `documentAtPosition`, so its project is already
  // proven; this only names the folder it was proven in.
  const dir = projectDirOf(resolved);
  if (dir === null || castAsked.has(dir.toLowerCase())) return;
  try {
    const manifest = await readManifest(dir);
    const view = positionView(ledgerOf(manifest));
    if (view.step === null || view.own || view.reading === null) return;
    if (!await readingIsComplete(dir, manifest)) return;
    castAsked.add(dir.toLowerCase());
    await queue.ensureCast(resolved);
  } catch (err) {
    // Never thrown at the caller: it asked which document is at the position and
    // it has a correct answer. This is the app trying to improve on that answer,
    // and a catalogue it could not read is a line in the terminal.
    console.error(
      `[ledger] the flowing book for ${path.basename(dir)} could not be asked for: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function registerIpc(): void {
  ipcMain.handle('dialog:open-document', () => promptForDocument());

  // A drop hands the renderer a path (webUtils, in the preload); main decides
  // whether it is openable. The renderer never gets to assert that a file is.
  ipcMain.handle('document:open-path', (_event, candidate: string) => openDocument(candidate));

  /**
   * A whole open document's bytes, for the app's own PDF viewer.
   *
   * IPC RATHER THAN `fetch` ON `foundry-file://`, and it is the renderer's own
   * policy that decides it: the page is served under `connect-src 'self'`, which
   * refuses a fetch to any other scheme — and widening the document's policy so
   * it may connect to a scheme that serves whole files off disk is a bigger
   * hole than this handler is, for a viewer that has to hold the file in memory
   * anyway. (The scheme once had a whole-file route for Chromium's viewer; it
   * went with the viewer.) The gate is `admitted`, the same one everything that
   * serves a document asks — a second DOOR, not a second rule.
   *
   * BUFFERED, WHOLE, deliberately: pdf.js is handed a buffer and searches every
   * page of it, so the scan is resident regardless and streaming would only add
   * a second copy.
   */
  ipcMain.handle('document:read-bytes', async (_event, target: string) => {
    const resolved = admitted(target);
    if (resolved === null) {
      throw new Error(`${target} was never opened in this app.`);
    }
    return fsp.readFile(resolved);
  });

  /**
   * Save a copy of an open document where the user says — the PDF tab's Save.
   *
   * DIALOG AND COPY IN ONE HANDLER, where the EPUB flow splits them. A book is
   * repacked from a working copy that can still be changing, so its grant and
   * its write are separate steps with a grant list between them; a PDF is one
   * finished file this app never edits, and the dialog's answer can be spent on
   * the spot. The source is still gated by `admitted` — the dialog authorizes
   * the DESTINATION, and only the user's own choice of one, but what may be
   * read out of the workspace remains the allow-list's question.
   */
  ipcMain.handle('document:save-copy', async (_event, source: string, suggestedName: string) => {
    const resolved = admitted(source);
    if (resolved === null) {
      throw new Error(`${source} was never opened in this app.`);
    }
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    // The library, same as the book pickers: the folder the user pointed this
    // app at is where its outputs go unless they steer elsewhere.
    const library = readAppSettings().libraryDir;
    await fsp.mkdir(library, { recursive: true });
    const options = {
      title: 'Save a copy of this PDF',
      defaultPath: path.join(library, suggestedName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) === resolved) {
      // Copying a file onto itself truncates it before it can be read. The
      // dialog makes this easy to do by accident — it opens on the library —
      // and the answer is a refusal, not a clever in-place no-op.
      throw new Error('That is the file itself. Pick somewhere else to put the copy.');
    }
    await fsp.copyFile(resolved, result.filePath);
    return result.filePath;
  });

  /**
   * The renderer's answer to `window:closing` — the one reply, spent once.
   *
   * `handle` rather than `on` so the renderer knows the answer arrived: without
   * it, a reply sent into a main process that had already given up waiting would
   * be indistinguishable from one that landed, and the renderer's own "the window
   * is going" state would never clear.
   */
  ipcMain.handle('window:let-go', (_event, go: boolean) => {
    const answer = letGoAnswer;
    letGoAnswer = null;
    answer?.(go === true);
  });

  /**
   * The warning before a tab with something to lose closes.
   *
   * Worded around what is ACTUALLY at risk, which is never the book itself:
   * every edit lands in the project's own working copy as it is made
   * (electron/epub-reader.ts) and closing a tab deletes nothing at all, so this
   * loses track of a book and never loses one. Telling a user their work is
   * about to be destroyed when it is not would teach them to distrust the next
   * warning that matters.
   *
   * ── TWO REASONS, ONE QUESTION ───────────────────────────────────────────────
   *
   * A book's filed copy can be out of date, and a scan's corrections can have no
   * save to come back to. They are two different losses and this app has already
   * ruled that a closing document is asked about once (`closeShowing`,
   * tabs.service.ts): a second card on top of the first is the app arguing with
   * an answer it already has. So the sentences are composed from whichever of the
   * two are true, and a tab can owe both.
   *
   * IT WAS THREE, and the third — "no copy of this exists anywhere you chose" —
   * is not asked any more at all. See `CloseWarning`: the flag was true from
   * birth for every book opened out of a project, so it interrupted people who
   * had lost nothing, and the ruling that retired it is the user's own: *"only
   * pop up a confirmation alert if changes have been made."*
   *
   * The corrections lead when they are there, because they are the only one whose
   * subject is the user's own judgement about four hundred blocks rather than a
   * file's whereabouts.
   */
  ipcMain.handle(
    'document:confirm-close',
    (_event, warning: CloseWarning): Asked<CloseAnswer> => ({
      kind: 'ask',
      question: warning.corrections === null
        ? aboutTheCopy(warning)
        : aboutTheCorrections(warning, warning.corrections),
    }),
  );

  /**
   * The filed copy is older than the book in front of you — the one thing left
   * for this half of the question to say.
   *
   * ── The sentence that died here, and why it could not stay ──────────────────
   *
   * This function used to fork on `warning.unsaved` and say, for a book with no
   * copy anywhere the user chose, that nothing else on the machine knew about it.
   * `questionBefore` (tabs.service.ts) no longer asks anything for a bare
   * `unsaved`, so that branch became unreachable the moment the ruling landed —
   * and it was also, by then, untrue: the book is in its project, Home lists it,
   * and the way a copy leaves this app is the export modal (docs/WORKBENCH.md
   * §6). A branch that can never run, phrased as advice about a gesture that no
   * longer exists, is worse than no branch at all, so both went.
   *
   * What is left is a real state with a real remedy: a copy the person themselves
   * put somewhere, which this book has moved on from.
   */
  function aboutTheCopy(warning: CloseWarning): AppQuestion {
    return {
      title: 'Close with edits unsaved?',
      message: `“${warning.title}” has been edited since you saved it.`,
      detail: [
        'Every edit went straight into Foundry\'s working copy of the book as you made it, so '
        + 'nothing here is lost — the project keeps it and Home will still list it.',
        'The copy you filed for yourself is the older version, and closing does not bring it up '
        + 'to date. Export the book again to replace it.',
      ],
      // The safe answer is FOCUSED and the ending one is LAST, which is this
      // app's rule for every card that can destroy something: Enter cannot
      // reach the button that ends the session's way back.
      choices: [
        { key: 'keep', label: KEEP },
        { key: 'close', label: CLOSE, danger: true },
      ],
      preferred: 'keep',
      dismissed: 'keep',
      checkbox: null,
    };
  }

  /**
   * THE SENTENCE THAT MUST NOT LIE.
   *
   * "You have unsaved changes that will be lost" is what every editor says here
   * and it is false in this app, twice over. The block editor has no unsaved
   * state: a strike is written whole into the live curation the instant it is
   * made, so closing discards nothing and every correction is exactly where it was
   * left when the book is opened again. Saying otherwise would be frightening
   * somebody about work that is not in danger, which is how a person learns to
   * dismiss the next warning without reading it.
   *
   * What is actually at stake is a RESTORE POINT. Foundry's step-by-step undo
   * lasts only as long as the document is open, so closing is the moment
   * "undoable" quietly becomes "permanent" — the corrections survive, and the
   * ability to walk back through them does not. A save is the only thing that
   * replaces it, which is why the offer to make one is a button rather than
   * advice: a dialog whose only route to keeping the work is *cancel, hunt for
   * Save, close again* has made the user do the app's job.
   *
   * SO THE THREE STATEMENTS ARE: nothing is lost; what ends is the way back to
   * this state; here is the one gesture that keeps it. In that order, because the
   * reassurance has to come before the cost or the cost reads as a threat.
   *
   * The count is named as a DIFFERENCE from the save when there is one ("stand
   * differently now than they do in …"), because "you have 23 corrections" is true
   * of a book that was saved with all 23 of them and is the wrong thing to say
   * about it. See `UncommittedCuration.blocks`.
   */
  function aboutTheCorrections(
    warning: CloseWarning,
    at: UncommittedCuration,
  ): AppQuestion {
    /*
     * THE SAVE IS NAMED ONCE AND THEN REFERRED TO. With both a block count and a
     * spine to report, naming the row twice in one sentence reads as two different
     * saves; with only one of them, "that save" refers to nothing the reader has
     * been told about yet. So whichever clause comes first carries the name.
     */
    const blocks = at.blocks === 1 ? '1 block' : `${at.blocks} blocks`;
    const drift = at.since === null
      ? `${blocks} corrected and no save of them`
      : `${blocks} that stand differently now than they do in “${at.since}”`;
    const spine = !at.chapters
      ? null
      : at.since === null
        ? 'a chapter list no save of this book holds'
        : at.blocks === 0
          ? `a chapter list that differs from “${at.since}”`
          : 'a chapter list that differs from that save';
    const message = at.blocks === 0 && spine !== null
      ? `“${warning.title}” has ${spine}.`
      : `“${warning.title}” has ${drift}${spine === null ? '' : `, and ${spine}`}.`;

    /*
     * The filed-copy warning, when this tab owes that one as well. Kept to a
     * sentence and put last: it is a second, smaller loss, and the corrections
     * are what the buttons are about.
     *
     * ONE BRANCH NOW, not two. The other one said "this book has also not been
     * saved anywhere you chose", and it went with the ruling that stopped a bare
     * `unsaved` asking anything at all (`CloseWarning`): a book living in its own
     * project is not a book somebody has mislaid, and a warning that is untrue in
     * a card about corrections teaches people to skim the part that is true.
     */
    const alsoTheCopy = warning.modified
      ? [
        'The copy you filed for yourself is also older than this one, and closing does not bring '
        + 'it up to date. Export the book again to replace it.',
      ]
      : [];

    return {
      title: 'Close without a save to come back to?',
      message,
      detail: [
        'Nothing here is lost by closing. Every one of these corrections is already written into '
        + 'this book’s curation, and all of them will be exactly where you left them the next time '
        + 'you open it.',
        'What closing ends is the way back to this state. Foundry’s step-by-step undo lasts only '
        + 'as long as the book is open; a save is what turns the corrections as they stand into a '
        + 'row in Steps that you can click back to afterwards. Saving now makes this moment one of '
        + 'those rows. Closing without it keeps every correction and keeps no way back to this '
        + 'point in them.',
        ...alsoTheCopy,
      ],
      /*
       * THREE ANSWERS, AND THE ORDER IS THE SAFETY. Save is offered first and is
       * what Enter takes, because it is the one answer that costs nothing and
       * keeps everything; Close is LAST and wears the error colour, so the button
       * that ends the way back has to be aimed at; Keep it open is what a
       * dismissal means. A card whose only route to keeping the work is *cancel,
       * hunt for Save, close again* has made the user do the app's job.
       */
      choices: [
        { key: 'save', label: SAVE },
        { key: 'keep', label: KEEP },
        { key: 'close', label: CLOSE, danger: true },
      ],
      preferred: 'save',
      dismissed: 'keep',
      checkbox: null,
    };
  }

  /**
   * "You deleted this footnote's last reference. Should the footnote go too?"
   *
   * MAIN'S SENTENCES, THE APP'S OWN CARD, like `confirmClose` above and like
   * every other question this app asks. It used to be a native box, argued for
   * on the grounds that the question is modal to the WINDOW — the edit has landed
   * and the next gesture must not race it — and that an in-app modal over a
   * sandboxed iframe is a rectangle the frame can scroll out from under. The card
   * answers both: it is a fixed full-window scrim that takes every click before
   * the frame can (see `ConfirmDialogComponent`), so the frame scrolling under it
   * moves nothing the person is looking at. What the native box could not answer
   * was that it did not look like this program (`AppQuestion`).
   *
   * THE NOTE IS NAMED, both by the number the page printed and by the words it
   * begins with. "A footnote is now unreachable" tells a person nothing they can
   * act on; “25 — Kershaw, *Hitler*, p. 412…” tells them exactly what they are
   * about to lose, which is the whole difference between a question and a
   * formality.
   *
   * THREE ANSWERS AND THEY WRITE THREE DIFFERENT THINGS. Cut strikes the note as
   * well (`epub:set-note-cut`); Leave writes nothing at all and the note stands
   * in the book with nothing pointing at it, which is a legitimate edition and
   * is counted by `epub-final`'s integrity report; Cancel puts the reference
   * number back, which is a second write of the block's previous markup and is
   * why the renderer still has to be holding it.
   *
   * THE ORDER IS EDIT-THEN-ASK. The edit is already on disk when this card goes
   * up, because an edit landing the instant it is typed is the whole feel of
   * select mode and a dialog that interrupted the typing to ask permission would
   * take that away. Cancel undoes; it does not pre-empt.
   *
   * THE CHECKBOX IS REMEMBERED PER ANSWER (app-settings.ts): "always strike it"
   * and "always leave it" are different standing instructions, and a single
   * "stop asking" flag would leave main choosing which one the user meant. A
   * checked box on CANCEL is ignored — a standing instruction to always undo
   * would make deleting a reference number impossible, with no dialog left to
   * explain why every attempt reverts itself — and that rule is now SAID rather
   * than implemented twice: `checkbox.remembers` names the two answers a ticked
   * box may be stored for, and the api layer stores nothing else.
   *
   * THE STANDING ANSWER IS READ BEFORE ANYTHING IS COMPOSED, which is what makes
   * "don't ask again" mean it: no question crosses the seam, so no card is drawn
   * and nothing flickers on its way to being dismissed.
   */
  ipcMain.handle(
    'document:confirm-unlinked-note',
    (_event, note: UnlinkedNote): Asked<UnlinkedNoteAnswer> => {
      const standing = readAppSettings().unlinkedNoteAnswer;
      if (standing !== 'ask') return { kind: 'answered', answer: standing };
      const printed = note.printed.trim();
      const named = printed.length > 0 ? `Footnote ${printed}` : `The footnote “${note.noteId}”`;
      return {
        kind: 'ask',
        question: {
          title: 'That was the last reference to a footnote',
          message: `${named} is no longer reachable from the text.`,
          detail: [
            ...(note.opening.length > 0 ? [`It reads: “${note.opening}”`] : []),
            'Striking it marks it the way Delete marks any block — it stays in the working copy, '
            + 'drawn struck through, and only leaves the book when the final edition is built, so '
            + 'pressing Delete on it brings it back. Leaving it keeps the note in the book with '
            + 'nothing pointing at it. Putting the number back undoes the edit you just made.',
          ],
          /*
           * THE THREE ANSWERS IN THE ORDER THE BOX ALWAYS PUT THEM, and the two
           * that are not the same answer twice. Leave is FOCUSED (the native
           * box's own `defaultId: 1`): it is the answer that writes nothing, and
           * a note standing in the book with nothing pointing at it is a
           * legitimate edition. A DISMISSAL PUTS THE NUMBER BACK (`cancelId: 2`),
           * which is the only one of the three that is not a decision about the
           * footnote at all — somebody who waved the question away did not agree
           * to an edition, so the edit that raised it is undone and the book is
           * exactly as it was.
           */
          choices: [
            { key: 'cut', label: 'Strike the footnote too' },
            { key: 'keep', label: 'Leave the footnote' },
            { key: 'cancel', label: 'Put the number back' },
          ],
          preferred: 'keep',
          dismissed: 'cancel',
          checkbox: {
            label: 'Don’t ask again — do this every time',
            remembers: ['cut', 'keep'],
          },
        },
      };
    },
  );

  /**
   * "Read this book again?" — the queue confirm, `BANK-LIFECYCLE.md` §3.
   *
   * MAIN'S QUESTION AND THE APP'S OWN CARD, like `confirmClose` and like every
   * other question this app asks. It was a native box, and the box's own defence
   * was that it is modal to the window — the next thing that happens after a yes
   * is an enqueue, and a question the user can click behind is a question they
   * can answer twice. The card is modal to the window in the only sense that
   * matters here: it is a full-window scrim at the top of the stack, so the Add
   * button under it cannot be reached while it is up.
   *
   * ONE CARD FOR THE WHOLE QUESTION. The replaced reading and every step that goes
   * stale with it are one cost and are asked about once; a second question listing
   * the casualties would be this app arguing with an answer it already has, which
   * is the rule `closeShowing` established for a closing document.
   *
   * THE SENTENCES ARE THE RENDERER'S, and this is the only question here where
   * that is true. They are read off the step ledger, the renderer already mirrors
   * it, and the composition is a pure shared function held down by tests
   * (`reReadAhead`, shared/reread.ts) — so main asking the disk again would be a
   * round trip for a decision that is already made and already checked. What stays
   * main's is what has always been main's: the shape of the question, the buttons,
   * and what a press of one of them means.
   *
   * ANYTHING UNRECOGNISED IS A NO. A yes here spends hours of GPU and replaces a
   * bank; a card somebody dismissed is not somebody agreeing to that — which is
   * why `dismissed` names the leave-it answer rather than the proceed one.
   *
   * THE CARD DOES NOT CLOSE THE OCR DIALOG IT IS ASKED FROM. That is the
   * renderer's rule and it is written down where it is enforced
   * (`ConfirmService.put`), but it is this question that needed it: the ask comes
   * from inside the OCR card, and a "no" that took the OCR card away with it would
   * answer a question nobody asked.
   */
  ipcMain.handle(
    'reading:confirm-re-read',
    (_event, prompt: ReReadPrompt): Asked<ReReadAnswer> => ({
      kind: 'ask',
      question: {
        /*
         * THE HEADLINE IS THE PROMPT'S OWN, AND IT IS SAID ONCE. The native box
         * had a title bar and a message and this question filled both with the
         * same sentence, which cost nothing when one of them was window chrome
         * and would be a card saying "Read this book again?" twice.
         */
        title: prompt.message,
        message: prompt.detail,
        detail: [],
        choices: [
          { key: 'leave', label: RE_READ_CANCEL },
          { key: 'again', label: RE_READ_PROCEED, danger: true },
        ],
        preferred: 'leave',
        dismissed: 'leave',
        checkbox: null,
      },
    }),
  );

  /*
   * ── The page and the contents are two statements ─────────────────────────
   *
   * THE TEXT SHOULD SAY WHAT THE BOOK SAYS, AND THE CONTENTS SHOULD SAY WHAT
   * THE BOOK'S OWN APPARATUS SAYS. Those are usually the same sentence and
   * sometimes deliberately are not: the caster composes a nav label the page
   * never carried — "Part II — The Road to War" over a page that reads "II" —
   * and that divergence is correct. So neither side is derived from the other,
   * nothing is kept in sync, and renaming one OFFERS to update the other.
   *
   * TWO QUESTIONS AND TWO PREFERENCES, not one of each. Renaming a contents
   * entry and fixing a typo on the page are different gestures with different
   * intents, and a person who has told the app to stop asking about one has
   * said nothing whatever about the other.
   *
   * Both follow the unlinked-footnote question exactly (`70cdc69`): the app's own
   * card, answered from `app-settings.json` without asking when a standing answer
   * is stored, remembered PER ANSWER so that "always update the other" and "never
   * update the other" stay two different instructions, and un-set in Settings'
   * Curation card — because a don't-ask-again checkbox with no way back is a trap.
   * Both of them are EITHER answer storable, which is why `remembers` names both
   * keys here and only two of three there.
   *
   * ASKED AFTER THE WRITE, both of them, on select mode's rule: what the user
   * typed lands the instant they stop typing, and the question is about the
   * OTHER side, which nothing has touched.
   */
  ipcMain.handle(
    'document:confirm-heading-echo',
    (_event, echo: HeadingEcho): Asked<EchoAnswer> => {
      const standing = readAppSettings().contentsRenameEcho;
      if (standing !== 'ask') return { kind: 'answered', answer: standing };
      return {
        kind: 'ask',
        question: {
          title: 'The page still says the old name',
          message: `The heading on the page reads “${echo.was}”.`,
          detail: [
            `The contents entry now reads “${echo.now}”. They are allowed to differ — the page `
            + 'should say what the book says, and the contents should say what the book\'s '
            + 'apparatus says — so nothing on the page has been changed. Changing it rewrites the '
            + 'heading (and the document title) to match; leaving it keeps the words the page '
            + 'printed.',
          ],
          // Update is offered first and focused (`defaultId: 0`), because the
          // person just renamed one side and the commonest reason to do that is
          // that both sides were wrong. Leaving is what a dismissal means:
          // nothing has been written to the page, so nothing has to be undone.
          choices: [
            { key: 'update', label: 'Change the heading too' },
            { key: 'leave', label: 'Leave the page as it is' },
          ],
          preferred: 'update',
          dismissed: 'leave',
          checkbox: {
            label: 'Don’t ask again — do this every time',
            remembers: ['update', 'leave'],
          },
        },
      };
    },
  );

  ipcMain.handle(
    'document:confirm-nav-echo',
    (_event, echo: NavEcho): Asked<EchoAnswer> => {
      const standing = readAppSettings().headingEditEcho;
      if (standing !== 'ask') return { kind: 'answered', answer: standing };
      return {
        kind: 'ask',
        question: {
          title: 'The contents still says the old name',
          message: `The contents entry reads “${echo.was}”.`,
          detail: [
            `The heading on the page now reads “${echo.now}”. Nothing in the contents has been `
            + 'changed — the two are allowed to differ. Changing it relabels the entry to match; '
            + 'leaving it keeps the name the table of contents gives this chapter.',
          ],
          choices: [
            { key: 'update', label: 'Change the contents entry too' },
            { key: 'leave', label: 'Leave the contents as it is' },
          ],
          preferred: 'update',
          dismissed: 'leave',
          checkbox: {
            label: 'Don’t ask again — do this every time',
            remembers: ['update', 'leave'],
          },
        },
      };
    },
  );

  // ── Projects ─────────────────────────────────────────────────────────────
  /*
   * TWO PLANS, because there are two jobs. `plan-reading` names the bank an OCR
   * run will fill and nothing else; `plan` names the file a rendering will write
   * and rotates the one it replaces. Splitting them is what stops an OCR job
   * having to invent a format in order to be planned.
   */
  /*
   * The ASK reaches the reading plan, because which bank this run fills depends
   * on whether it is the same question a reading of this book already answered.
   * A renderer that sent nothing asks the plain question — the whole book, no
   * language declared — which is the same default `recordReading` takes, so an
   * old renderer against a new main is consistent rather than merely tolerated.
   */
  ipcMain.handle('workspace:plan-reading', (_event, inputPath: string, asked?: ReadAsk) =>
    planReading(inputPath, asked ?? {}));
  ipcMain.handle(
    'workspace:plan',
    (_event, inputPath: string, kind: ConversionKind) => planConversion(inputPath, kind),
  );
  /*
   * THREE PLANS NOW, and the third one is the same rendering with a different
   * destination. An export is a Generate that lands in the project's tray rather
   * than in the layer this app treats as an origin — nothing is ever made from it,
   * so it gets no chain, no working tree and no step (docs/WORKBENCH.md §3). The
   * split is at the plan rather than at the enqueue because `final/` and
   * `generated/` are refused on different grounds: only the second one can have a
   * book unpacked out of it and being read in a tab. See `planExport`.
   *
   * NO ALLOW-LIST CHECK, exactly as `workspace:plan` has none, and the reason is
   * the same: `planConversion` and `planExport` do not read the path they are
   * given. They resolve which PROJECT it belongs to and then compose every path
   * they return out of the project's own catalogue — the pixels come from
   * `archive/`, the bank from the position's read step — so a renderer naming a
   * file it never opened gets a plan about somebody's project or an error, and no
   * bytes. The translation plan is the one that checks, because it is the one that
   * reads the input to export a working copy of it.
   */
  ipcMain.handle(
    'workspace:plan-export',
    (_event, inputPath: string, kind: ConversionKind) => planExport(inputPath, kind),
  );
  /*
   * A translation reads a file the renderer already has open, so the input is
   * checked against the SAME allow-list every other read is. Without it this
   * handler would hash — and then hand the engine — any path a compromised
   * renderer named.
   *
   * `exportWorkingCopy` FIRST, and it is the one thing that keeps translation
   * honest now that an edit no longer repacks: the engine is a separate process
   * handed a path, so a book edited since it was cast would be translated as it
   * was before the edits, silently. The export writes a zip of the working tree
   * into `working/` — never into `generated/`, which is the record of what the
   * model read — and the job reads THAT. It is one of the two places this app
   * zips at all (electron/epub-reader.ts).
   *
   * The exported path is what the job is given, so it is admitted here too: the
   * queue re-checks `inputPath` against the same allow-list, and a path that
   * only main knows about would be refused by main's own gate a moment later.
   */
  ipcMain.handle('workspace:plan-translation', async (_event, inputPath: string, targetLanguage: string) => {
    const source = admitted(inputPath);
    if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
    const readable = await exportWorkingCopy(source);
    openable.add(path.resolve(readable));
    const plan = await planTranslation(readable, targetLanguage);
    // `plan.sourcePath` is the export admitted two lines up — planning moved
    // nothing since the rotation went to spawn time (`pump()`), and the
    // moved-aside path a self-overwriting re-translation reads exists only on
    // the spawn-time copy of the request, past every admission gate, never in
    // the renderer's hands. Re-adding the same path is harmless and kept so a
    // future plan that returns a different source is admitted the day it does.
    openable.add(path.resolve(plan.sourcePath));
    return { ...plan, inputPath: plan.sourcePath };
  });

  /** Home's primary listing: one row per book, expanding to what is in it. */
  ipcMain.handle('projects:list', () => listProjects());

  /**
   * Delete a project — the whole folder, off the disk, for real.
   *
   * THE ONE PLACE IN THIS APP WHERE SOMETHING IS REALLY DESTROYED. Everywhere
   * else "nothing is ever deleted" holds (electron/projects.ts), because
   * everywhere else it is FOUNDRY deciding that a person is finished with
   * something it made. Here it is the person, about their own folder, having
   * been told in words what is in it. A Delete button that quietly rotated the
   * project into `archived-<stamp>/` would be a lie twice over: the library
   * would go on filling up, and the folder the user pressed a button to be rid
   * of would still be there for them to find and remove by hand.
   *
   * THREE THINGS ARE REFUSED BEFORE THE QUESTION IS EVEN ASKED, all of them BY
   * NAME (ARCHITECTURE §8):
   *
   *   1. a path that is not a project directory — `inspectProject` proves it is
   *      a DIRECT CHILD of `projectsDir()` before it reads a byte, and
   *      `deleteProject` proves it again at the `rm`. That check is the whole
   *      security boundary here and its reasoning is written down where it
   *      lives; this handler must never be the thing that decides a path is
   *      safe;
   *
   *   2. a book from this project open in a tab. The renderer checks its own tab
   *      list first, because it is the side that knows the tab's title and can
   *      say a sentence worth reading — but a renderer's word is not an
   *      authorization (the `admitted` precedent, above), so main asks its OWN
   *      record of what is unpacked. Deleting a working tree out from under a
   *      live book leaves the protocol handler serving chapters that are gone,
   *      and on Windows the delete stops halfway on the first locked file and
   *      leaves a project that is neither there nor erased — worse than either;
   *
   *   3. the user themself, at the dialog, which defaults to Cancel.
   *
   * MAIN'S NATIVE BOX, like `confirmClose` and like every other question this
   * app asks: modal to the window, so the next gesture cannot race it, and not a
   * rectangle drawn over a page that can scroll out from under it.
   *
   * The sentence names the book, names the directory, and says what is inside —
   * above all the READINGS BANK, because that is the only thing in a project
   * that cost GPU-hours and cannot be rebuilt from anything else on disk. A
   * scan re-imports, a working tree re-unpacks, an edition rebuilds; a page the
   * model read is read again or not at all.
   *
   * Returns the sentence for the notice strip, or null when the user said no.
   * A refusal THROWS, so it reaches the same strip through the renderer's
   * ordinary catch and is never mistaken for a cancel.
   */
  /*
   * DESCRIBE, THEN DELETE — two calls where there used to be one.
   *
   * The question moved to the renderer, and the split is what makes that safe.
   * `projects:describe` composes the warning and PROVES the delete is currently
   * allowed; `projects:delete` proves it again and does the work. Nothing about
   * the second call trusts the first: a renderer that skipped straight to the
   * delete meets exactly the same refusals, because the checks live in the
   * function that erases rather than in the one that asks.
   *
   * The sentences stay HERE, whole. Main is the only side that knows the size on
   * disk, the readings bank's page count and whether a copy was filed, and those
   * are what make the warning worth reading — a renderer composing its own would
   * arrive at "Are you sure?" within a month.
   */
  /**
   * The two refusals, in one place because both callers owe both of them.
   *
   * NEITHER IS ADVISORY. `describe` runs them so the app does not put a warning
   * on screen for something it is going to refuse a click later; `delete` runs
   * them because that is where the authorization has to be. A renderer's word
   * about what is open or what is queued is not a fact main may act on when the
   * action is a recursive delete.
   */
  function refuseProjectDelete(project: { dir: string; title: string }): void {
    const open = openBookIn(project.dir);
    if (open !== null) {
      throw new Error(
        `${open} is open in Foundry right now, so “${project.title}” cannot be deleted — erasing `
        + 'the working copy out from under a book that is being read would leave that tab showing '
        + 'files that no longer exist, and would leave half a project on disk. Close the book '
        + 'first, then delete it.',
      );
    }
    refuseBusyJob(project);
  }

  /**
   * The narrower refusal: a job writing into this folder, and nothing else.
   *
   * IT IS SPLIT OUT BECAUSE A DOCUMENT DELETE OWES ONLY THIS HALF. Deleting the
   * whole project while any book from it is open is a working tree pulled out
   * from under a reader; deleting ONE generated file while a DIFFERENT document
   * of the same project is open is the ordinary case — read the scan, throw away
   * the EPUB you did not like — and refusing it because something else in the
   * folder happened to be open would make the button useless exactly when it is
   * wanted. The renderer closes the file's own tab before asking (open-documents).
   *
   * THREE CALLERS NOW, AND THEY SHARE THE FACT RATHER THAN THE SENTENCE. What is
   * the same for all of them is finding the job: which run is about to write into
   * this folder, and whether it is going or waiting. What differs is the
   * CONSEQUENCE — a project delete erases the folder the engine is writing into, a
   * step delete destroys a payload it may be in the middle of producing — so the
   * clause after "so" is the caller's, and everything before it is written once
   * here. A second copy of the job search is how the day comes that one of them
   * learns about a new job state and the other does not.
   */
  function refuseBusyJob(
    project: { dir: string; title: string },
    /** The clause after "so", ending in what to do about it. */
    consequence = `“${project.title}” cannot be deleted — the engine is writing into that `
      + 'folder from another process, and erasing it underneath would leave half a project on '
      + 'disk and a run writing into nothing. Cancel it in the shelf first, then delete.',
  ): void {
    /*
     * A JOB WRITING INTO IT IS THE SAME HAZARD AS AN OPEN BOOK, and worse in
     * one way: the engine is a separate process holding a file open in
     * `generated/`, so the recursive remove fails PART WAY on Windows and
     * leaves a project half erased — while the run carries on writing into a
     * directory the catalogue no longer describes.
     *
     * Every state but `held`, `queued` and `running` is finished with the
     * folder: a done, failed or cancelled row names a path nothing is holding.
     *
     * `held` counts even though nothing is writing yet. It is a job CONFIGURED
     * to write here — the output path is already chosen and the readings bank
     * already named — so deleting the folder under it would leave a row in the
     * shelf that fails the moment somebody presses Start, for a reason nothing
     * in the error would connect to a project they erased ten minutes earlier.
     */
    const busy = queue.listJobs().find((job) =>
      (job.state === 'running' || job.state === 'queued' || job.state === 'held')
      && within(project.dir, job.outputPath));
    if (busy !== undefined) {
      throw new Error(
        `A ${busy.kind} job is ${busy.state === 'running' ? 'running' : 'waiting to run'} into `
        + `“${project.title}” right now, so ${consequence}`,
      );
    }
  }

  /**
   * The warning, composed where the facts are.
   *
   * Every sentence the native box used to carry, kept verbatim — the size on
   * disk, the readings bank, the filed copy, and the flat statement that this is
   * a real delete. The only thing that changed is that it comes back as data
   * instead of being drawn by the OS.
   */
  function describeProject(project: ProjectInventory): DeletionPrompt {
    /*
     * THE BANK IS THE COST RULE IN ITS PUREST FORM (`ProjectStep.costly`). It is
     * the stored result of the expensive pass — which is exactly why a rerun is
     * free, and exactly why nothing in this app ever sweeps it. Erasing it is
     * the one loss in a project delete that no amount of time gets back.
     */
    const bank = project.readings > 0
      ? `It holds a readings bank of ${project.readings.toLocaleString()} pages the model has `
        + 'already read. That is hours of GPU, it is the one thing in here that cannot be made '
        + 'again from anything else on this disk, and once it is gone a future conversion of this '
        + 'book pays for every page from scratch.'
      : 'There is no readings bank in it, so nothing in here costs GPU-hours to make again.';
    /*
     * AND THE CURATION, which is the one thing in here that is IRREPLACEABLE
     * rather than merely expensive (`ProjectStep.retention`). A bank can be read
     * again for money and hours. A person going through four hundred pages
     * saying which blocks are running heads and where the chapters start cannot
     * be reproduced by anything, at any price, and it is quoted before the bank
     * for exactly that reason.
     */
    const curation = project.amendments > 0
      ? `It also holds ${project.amendments.toLocaleString()} corrections you made by hand about `
        + 'the blocks on those pages — strikes, categories, wording and chapter starts. Nothing '
        + 'can make those again: they are judgements about the book, not output.'
      : '';
    const filed = project.filed
      ? ' The copy you filed into this project\'s own folder is inside it and goes with it.'
      : '';
    const made = project.documents === 0
      ? 'nothing has been made from it yet'
      : project.documents === 1
        ? 'the one document Foundry has made from it'
        : `the ${project.documents} documents Foundry has made from it`;
    return {
      message: `“${project.title}” will be deleted from this computer.`,
      detail: [
        /*
         * THE IMPORT LEADS, because it is the most expensive thing in the folder
         * and the only one that is IRREPLACEABLE rather than merely costly
         * (`ProjectStep.costly`). A model pass can be run again for money and
         * hours; the file the user handed over came from somewhere only they
         * know, and Foundry treats it as the only copy in the world.
         */
        'The file you imported goes with it. Foundry keeps no other copy of it and cannot '
        + 'fetch it again — wherever you got it from is the only place it still exists.',
        `${project.dir} and everything under it goes: ${made}, every working copy and every `
        + `edit in them, and the undo history. ${sizeOnDisk(project.bytes)} in all.${filed}`,
        ...(curation.length > 0 ? [curation] : []),
        bank,
        'This is a real delete. The folder is removed from the disk — it is not moved aside, '
        + 'Foundry keeps no copy of it anywhere else, and there is nothing that will bring it back.',
      ],
      confirm: 'Delete this project',
    };
  }

  ipcMain.handle('projects:describe', async (_event, dir: string) => {
    const project = await inspectProject(dir);
    refuseProjectDelete(project);
    return describeProject(project);
  });

  ipcMain.handle('projects:delete', async (_event, dir: string) => {
    const project = await inspectProject(dir);
    refuseProjectDelete(project);

    await deleteProject(project.dir);
    // The recents list is keyed by file and a project is a folder of them, so
    // every row pointing inside goes with it. Otherwise the app would keep a
    // last-opened time for — and `listProjects` would keep dating a row by — a
    // book whose bytes it destroyed a moment ago.
    forgetRecentsUnder(project.dir);
    return `Deleted “${project.title}”. ${project.dir} and everything in it is gone from this computer.`;
  });

  /**
   * One document out of a project: what would happen, and then doing it.
   *
   * THE ORIGINAL IS NOT DELETABLE ON ITS OWN, and that is the whole reason this
   * pair describes before it acts. Every other document in a project was made
   * FROM the original; erasing it leaves a folder of outputs with no source,
   * which is not a project any more. So `describe` reports `original: true` and
   * hands back the PROJECT's warning, and `delete` refuses that path outright —
   * the renderer is expected to run the project delete instead, and a renderer
   * that ignored the flag gets a sentence rather than a half-emptied folder.
   *
   * `shared/original.ts` decides which document that is, and both sides import
   * it: the flag main sets and the row the nav draws come from one rule.
   *
   * The listing comes from `listProjects`, which is the one function that says
   * what a project contains — the same answer Home and the side nav are drawn
   * from, so a row the user can see is a row this can find.
   */
  async function findDocument(filePath: string): Promise<{
    project: ProjectSummary;
    document: ProjectDocument;
  }> {
    const target = fold(filePath);
    for (const project of await listProjects()) {
      const document = project.documents.find((row) => fold(row.path) === target);
      if (document !== undefined) return { project, document };
    }
    throw new Error(
      `${filePath} is not a document in any of Foundry's projects, so there is nothing here to `
      + 'delete. Files outside the library are the file manager\'s business, not this app\'s.',
    );
  }

  ipcMain.handle('documents:describe', async (_event, filePath: string): Promise<DocumentDeletion> => {
    const { project, document } = await findDocument(filePath);
    const inventory = await inspectProject(project.dir);

    if (isBook(project.documents, document.path, project.dir)) {
      // The original's delete IS the project's, so it owes the project's
      // refusals — including the open-book one this file's own delete does not.
      refuseProjectDelete(inventory);
      const prompt = describeProject(inventory);
      return {
        prompt: {
          ...prompt,
          message: `“${document.label}” is the original this project is built on.`,
          detail: [
            'Deleting it deletes the whole project — every document in this folder was made from '
            + 'it, and what would be left is a set of outputs with nothing they came from.',
            ...prompt.detail,
          ],
        },
        original: true,
        projectDir: project.dir,
        missing: document.missing,
      };
    }

    refuseBusyJob(inventory);
    const gone = document.missing
      ? 'That file is already gone from the disk; what is left is its row in this project\'s '
        + 'catalogue, and this clears it.'
      : `${document.path} is removed from the disk. It is not moved aside and Foundry keeps no `
        + 'copy of it anywhere else.';

    /*
     * WHAT ELSE GOES, NAMED. A delete that quietly takes more than the thing it
     * was pointed at is the exact surprise these cards exist to prevent — and
     * "5 earlier versions" is not a detail, it is most of what is about to be
     * removed by weight. Where nothing extra goes, nothing extra is said: a
     * sentence listing zero of three things reads as boilerplate and teaches
     * people to skip the paragraph that matters.
     */
    const extras = await documentAssets(document.path);
    const also: string[] = [];
    if (extras.archivedVersions > 0) {
      also.push(extras.archivedVersions === 1
        ? 'the one earlier version of it a rerun set aside'
        : `the ${extras.archivedVersions} earlier versions of it that reruns set aside`);
    }
    if (extras.workingTree) also.push('the unpacked working copy it is read from');
    if (extras.histories > 0) also.push('its edit history');

    return {
      prompt: {
        message: `“${document.label}” will be deleted from “${project.title}”.`,
        detail: [
          gone,
          ...(also.length > 0
            ? [`${sentenceList(also)} ${also.length === 1 ? 'goes' : 'go'} with it — everything in `
              + 'this project that belongs to this document and to nothing else.']
            : []),
          'The project and everything else in it stays, including the original and the readings '
          + 'bank — the hours of GPU that let this document be made again by converting the book a '
          + 'second time.',
        ],
        confirm: document.missing ? 'Remove this row' : 'Delete this document',
      },
      original: false,
      projectDir: project.dir,
      missing: document.missing,
    };
  });

  /** `a`, `a and b`, `a, b and c` — the app writes sentences, not bullet lists. */
  function sentenceList(parts: readonly string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  ipcMain.handle('documents:delete', async (_event, filePath: string) => {
    const { project, document } = await findDocument(filePath);
    const inventory = await inspectProject(project.dir);
    // Proven again, not trusted from the describe: a job can be queued between
    // the question and the answer, and this is the call that unlinks something.
    refuseBusyJob(inventory);

    if (isBook(project.documents, document.path, project.dir)) {
      throw new Error(
        `“${document.label}” is the original “${project.title}” is built on, so it cannot be `
        + 'deleted by itself — every other document in the folder was made from it. Delete the '
        + 'project instead.',
      );
    }

    const removed = await deleteDocument(document.path);
    forgetRecentsUnder(document.path);
    return removed.wasMissing
      ? `Removed “${removed.label}” from “${removed.title}” — the file was already gone.`
      : `Deleted “${removed.label}” from “${removed.title}”.`;
  });

  // ── Books ────────────────────────────────────────────────────────────────

  /**
   * Where each open book may be saved — the same rule as the two allow-lists
   * above it: the renderer names things, main decides. A destination is
   * grantable two ways only: it is the file the user themself opened the book
   * from (Save updates it), or it just came out of main's own save dialog
   * (Save As chose it). `epub:save` with anything else is refused, so a
   * renderer that was talked into asserting a path cannot write one.
   *
   * Case-folded like recents' samePath: on Windows the same file arrives
   * spelled three ways.
   */
  const grantSave = (id: string, destination: string): void => {
    const grants = saveGrants.get(id) ?? new Set<string>();
    grants.add(grantKey(destination));
    saveGrants.set(id, grants);
  };

  ipcMain.handle('epub:open', async (_event, filePath: string) => {
    /*
     * THE ALLOW-LIST, and it belongs here more than anywhere else in this file.
     *
     * Every path the renderer can legitimately pass came back to it from
     * `document:opened`, which main sent only after admitting the file itself —
     * so gating costs nothing a real caller would notice. What it stops is this
     * handler being the one door that opens ANY path on disk: it now creates a
     * project directory around whatever it is handed and copies that file into
     * it, and it hands back a save grant for an unmanaged one. An ungated
     * `epub:open` was a write grant to any path a renderer could name.
     */
    const admittedPath = admitted(filePath);
    if (admittedPath === null) {
      throw new Error(`${filePath} is not a document this app was asked to open.`);
    }
    const book = await openEpub(admittedPath);
    // A book from the user's own disk: that file IS a copy somewhere they
    // chose, so plain Save may update it. A managed book grants nothing —
    // its first save goes through the dialog below.
    if (!book.managed) grantSave(book.id, book.filePath);
    return book;
  });
  ipcMain.handle('epub:close', (_event, id: string) => {
    saveGrants.delete(id);
    closeEpub(id);
  });
  ipcMain.handle('epub:read-member', (_event, id: string, href: string) =>
    readEpubMember(id, href));
  // Writes ONE member of the project's working tree and repacks nothing — see
  // epub-reader.ts. The renderer holds the text; main holds the file. No Node in
  // the renderer, ever.
  ipcMain.handle('epub:write-member', (_event, id: string, href: string, text: string) =>
    writeEpubMember(id, href, text));
  // Renames a TOC entry — the nav label, ALWAYS, and an offer about the page's
  // heading, which is written only through the door below and only when the
  // user says so. Into the working tree, like an edit; nothing else is written.
  ipcMain.handle('epub:rename-heading', (_event, id: string, href: string, label: string) =>
    renameEpubHeading(id, href, label));
  // The "yes, change the page too" answer. A door of its own, because the
  // question is asked after the nav has already been written and the write it
  // authorises is a different write to a different file.
  ipcMain.handle(
    'epub:rename-page-heading',
    (_event, id: string, href: string, label: string, was: string) =>
      renameEpubPageHeading(id, href, label, was),
  );
  // The mirror question, for the direction that runs the other way: an edited
  // heading, and the contents entry that still reads what it used to say.
  // A QUERY, not a write — nothing changes until the app asks and is answered.
  ipcMain.handle(
    'epub:nav-echo-for-block',
    (_event, id: string, href: string, blockId: string, was: string) =>
      navEchoForBlock(id, href, blockId, was),
  );

  /*
   * ── Select mode's writes ─────────────────────────────────────────────────
   *
   * Every one of them is a member write into the working tree and every one of
   * them repacks nothing, like every other edit since the projects change. What
   * they have in common is that they are keyed by `data-bf-id` — the one name in
   * a cast book that does not renumber when something before it is removed — and
   * that each REFUSES BY NAME rather than doing its best: an id that is not
   * there, an id that is there twice, a category nothing writes, an edit that
   * moved a tag rather than a word. The reasons live with the surgery, in
   * epub-reader.ts.
   *
   * They are handlers of their own rather than a mode on `epub:write-member`
   * because the renderer must not be able to hand main a whole chapter and call
   * it a cut. What crosses this boundary is a block's NAME and either a boolean,
   * a category, or the words inside it; the document is main's the entire time.
   */
  // EVERY CUT, whether the user pressed Delete on one block, dragged a marquee
  // over thirty, or struck a whole category: one read, one write, and every id
  // located before a byte moves, so the batch either lands whole or refuses
  // whole. Resolves with how many tags actually changed — which is what the app
  // then says out loud, because a gesture that reports what it asked for rather
  // than what it did is a gesture nobody can trust with two hundred paragraphs.
  ipcMain.handle(
    'epub:set-cuts',
    (_event, id: string, href: string, blockIds: string[], cut: boolean) =>
      setBlockCuts(id, href, blockIds, cut === true),
  );
  // Resolves with the notes this edit left unreachable, which is a QUESTION for
  // the app rather than a failure: the write has already landed.
  ipcMain.handle(
    'epub:set-block-html',
    (_event, id: string, href: string, blockId: string, html: string) =>
      setBlockHtml(id, href, blockId, html),
  );
  // The "put the number back" answer. A separate door because the ordinary one
  // forbids markup being GAINED, which is exactly what restoring a deleted
  // reference number is — see restoreBlockHtml for the check it makes instead.
  ipcMain.handle(
    'epub:restore-block-html',
    (_event, id: string, href: string, blockId: string, html: string) =>
      restoreBlockHtml(id, href, blockId, html),
  );
  // The footnote itself, addressed by its OWN id — the name the reference used,
  // read out of the href the edit removed. A cut, not a deletion.
  ipcMain.handle(
    'epub:set-note-cut',
    (_event, id: string, href: string, noteId: string, cut: boolean) =>
      setNoteCut(id, href, noteId, cut === true),
  );
  // The inspector's relabel, applied to the whole selection in one read and one
  // write. It changes the LABEL and not the shape — a paragraph relabelled
  // `footnote` stays a <p> in the prose, where the page printed it.
  ipcMain.handle(
    'epub:set-categories',
    (_event, id: string, href: string, blockIds: string[], category: string) =>
      setBlockCategories(id, href, blockIds, category),
  );
  // The spine, in reading order, from the renderer — which is where the reading
  // order is known. Every href is still resolved against the book's own
  // allow-list inside, so naming a file is not the same as reaching one. The
  // stamping itself is the ENGINE's, spawned on the working tree.
  ipcMain.handle('epub:stamp', (_event, id: string, members: string[]) =>
    stampBook(id, members));

  ipcMain.handle('epub:choose-save-path', async (_event, id: string, suggestedName: string) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    /*
     * The project's own `final/`, which is what that layer is for: the tray a
     * finished book is filed into, named for the book rather than for the slug
     * the directory carries. The picker still opens — Save As is a question and
     * this only answers where it starts — and the user can put the file
     * anywhere, which is the whole point of Save As.
     *
     * The LIBRARY is the fallback, for a book that belongs to no project: the
     * pickers open where the books live, which is the folder the user pointed
     * this app at, never Documents.
     */
    const project = projectOf(id);
    const folder = project === null ? readAppSettings().libraryDir : await finalDir(project);
    await fsp.mkdir(folder, { recursive: true });
    const options = {
      title: 'Save this book',
      defaultPath: path.join(folder, suggestedName),
      filters: [{ name: 'EPUB', extensions: ['epub'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    // The dialog's answer is the grant — recorded against the book it was asked
    // for, so `epub:save` can hold the line that no other path is writable.
    grantSave(id, result.filePath);
    return result.filePath;
  });

  /**
   * Repack the working tree to where the user said.
   *
   * A REPACK and not a copy of the project's archive, and that is no longer a
   * question of a one-instant race: an edit does not repack at all now, so the
   * tree is ahead of every zip for as long as the book has been edited. Packing
   * from the tree is packing from the thing the editor actually wrote to, and it
   * is one of only two places in this app that writes a zip.
   *
   * ── AND WHAT IT WRITES IS AN EDITION, WHEN THE BOOK IS ONE OF OURS ─────────
   *
   * This is the app's second door onto `final/` and it used to be the worse one.
   * The queue's exports go through the engine, which tidies what it writes; Save
   * As zipped the working tree VERBATIM — every `data-bf-cut` a curator left on a
   * footnote, every `data-bf-id` and `data-bf-src` the picker addresses elements
   * by — and then recorded the result as a filed book. Two doors onto one tray,
   * producing two different kinds of file, and the difference was invisible until
   * somebody opened the one they saved by hand.
   *
   * So a foundry book is repacked to a temp file and `epub-final` writes the
   * destination out of it. THE ZIP STILL HAPPENS HERE and not in the engine,
   * although `epub-final --epub` takes a directory and would read the tree
   * directly: a directory has no compression to preserve, so every member would
   * come back STORED and the edition of a scanned book would be several times the
   * size of the book it was made from. `repackEpub` is what knows the order the
   * archive had and how its members were compressed.
   *
   * A BOOK THAT IS NOT OURS IS REPACKED VERBATIM, exactly as before. A loose EPUB
   * from a publisher carries none of foundry's marks — the engine refuses it by
   * name, and rightly, because there is nothing of ours in it to strip and an
   * "edition" of it would be a copy of somebody's book under a new name.
   *
   * THE TEST IS THE BOOK AND NOT THE DESTINATION, which decides the one case that
   * is not Save As: a loose EPUB somebody opened from their own disk, STAMPED in
   * select mode, and then saved in place with the grant `epub:open` handed out
   * for it. That file gets the edition too, and it should — what leaves this app
   * is a book, and the marks are the app's own working notes about it. Nothing is
   * lost by writing them out of it: the workbench is the unpacked tree in the
   * project, which keeps every mark and every stamp, and is where the next edit
   * and the next save both come from.
   *
   * A failure REJECTS across IPC rather than resolving quietly: a save that did
   * not happen must not clear the dot. That now includes a tidy that refused —
   * the file at the destination would be missing or half-written, and reporting a
   * save for it would be the app saying a book is filed when it is not.
   */
  ipcMain.handle('epub:save', async (_event, id: string, destination: string) => {
    if (!saveGrants.get(id)?.has(grantKey(destination))) {
      throw new Error(
        'That is not a place this book was granted to save to — a destination has to come '
        + 'from the save dialog, or be the file the book was opened from.',
      );
    }
    if (await isFoundryBook(id)) {
      /*
       * NAMED FOR THIS SAVE AND NOT FOR THE BOOK, in the OS temp directory under
       * `foundry/` — the queue's intermediates' rule, for the queue's reasons: two
       * saves must not collide in a directory that belongs to every program on the
       * machine, and debris does not go where products live. It is removed
       * whichever way this ends, best effort, because a leftover scratch file is a
       * console line and never a reason to fail a save that succeeded.
       */
      const scratch = path.join(os.tmpdir(), 'foundry', `save-${randomUUID()}.epub`);
      await fsp.mkdir(path.dirname(scratch), { recursive: true });
      try {
        await repackEpub(id, scratch);
        const tidied = await finalizeEpub(scratch, destination);
        if (!tidied.ok) {
          throw new Error(
            `The book could not be finished into an edition, so nothing was saved.\n${tidied.reason}`,
          );
        }
      } finally {
        await fsp.rm(scratch, { force: true }).catch((err: Error) => {
          console.error(`[save] the scratch copy ${scratch} could not be removed: ${err.message}`);
        });
      }
    } else {
      await repackEpub(id, destination);
    }
    openable.add(path.resolve(destination));
    rememberRecent(destination, 'epub', path.basename(destination), isManaged(destination));
    // Noted only when it landed in the project's own `final/`. A save to a USB
    // stick is the user's business and is already in recents; this is what lets
    // a project row say the book has been filed at all.
    await recordFinal(destination);
  });

  /*
   * ── The undo ledger, on disk ─────────────────────────────────────────────
   *
   * TWO CALLS, because the renderer has no filesystem and the stacks it holds
   * are now a file in the book's own project. It names the BOOK and nothing
   * else: main resolves which project, which working tree and which generation
   * of that tree, so the renderer cannot name a path, cannot claim a generation,
   * and therefore cannot talk one book's history into another book's folder.
   *
   * Load answers with a NOTICE as well as the stacks, and a load that found a
   * history it could not use is not an error — it is one of three ordinary
   * outcomes, all of which are said out loud. See electron/history.ts.
   */
  ipcMain.handle('history:load', (_event, bookId: string) => loadLedger(bookId));
  // Called after EVERY mutation of either stack. Whole file, atomically, because
  // a crash mid-write is exactly the case this feature exists for.
  ipcMain.handle('history:save', (_event, bookId: string, stacks: LedgerStacks) =>
    saveLedger(bookId, stacks));

  /*
   * ── The app's own preferences ────────────────────────────────────────────
   *
   * There is one, and it exists so the don't-ask-again checkbox on the
   * unlinked-footnote dialog is not a one-way door: a preference a person can
   * set and cannot see or unset is a preference that eventually gets set by
   * accident and then haunts them. `ask` puts the question back.
   */
  ipcMain.handle('prefs:unlinked-note-answer', () => readAppSettings().unlinkedNoteAnswer);
  ipcMain.handle('prefs:set-unlinked-note-answer', (_event, answer: UnlinkedNoteStanding) =>
    writeAppSettings({ unlinkedNoteAnswer: answer }).unlinkedNoteAnswer);
  // The two halves of "renaming one offers to update the other". Separate keys
  // on purpose — see the two confirm handlers above.
  ipcMain.handle('prefs:contents-rename-echo', () => readAppSettings().contentsRenameEcho);
  ipcMain.handle('prefs:set-contents-rename-echo', (_event, answer: EchoStanding) =>
    writeAppSettings({ contentsRenameEcho: answer }).contentsRenameEcho);
  ipcMain.handle('prefs:heading-edit-echo', () => readAppSettings().headingEditEcho);
  ipcMain.handle('prefs:set-heading-edit-echo', (_event, answer: EchoStanding) =>
    writeAppSettings({ headingEditEcho: answer }).headingEditEcho);

  /*
   * ── A document's own record ──────────────────────────────────────────────
   *
   * `foundry epub-meta` and `foundry pdf-meta`, spawned exactly as `doctor` and
   * `epub-stamp` are: the engine owns the file format and this app owns the
   * question. Reading and writing are one pair of handlers rather than four,
   * because the dialog does both against the same document and a patch with no
   * fields in it IS a read.
   *
   * WHICH FILE IS MAIN'S DECISION. For an EPUB the renderer names the open book
   * by its id and main resolves the working tree — the unpacked copy this app
   * edits, which is what makes the change visible immediately and what Save
   * later packs. For a PDF the renderer names the path it already has open,
   * which is the WORKING PDF; it is resolved through the same allow-list every
   * other read goes through, so a renderer cannot ask main to rewrite a file
   * nobody opened.
   */
  ipcMain.handle('meta:read-epub', (_event, id: string) => readEpubMetadata(workingTreeOf(id)));
  ipcMain.handle(
    'meta:write-epub',
    (_event, id: string, patch: Record<string, string | undefined>) =>
      writeEpubMetadata(workingTreeOf(id), patch),
  );
  /*
   * The PDF's path goes through `admitted` — the SAME allow-list the pdf.js
   * viewer's bytes go through, and the same function, so this door can never
   * drift from that one. A renderer that was talked into naming some other file
   * is refused here rather than by a path check that has to stay right forever.
   */
  const admittedPdf = (candidate: string): string => {
    const resolved = admitted(candidate);
    if (resolved === null) {
      throw new Error(`"${candidate}" is not a document this app has open, so its metadata is not ours to read.`);
    }
    return resolved;
  };
  ipcMain.handle('meta:read-pdf', (_event, filePath: string) =>
    readPdfMetadata(admittedPdf(filePath)));
  /**
   * The PDF a metadata WRITE may touch, which is not simply "one that is open".
   *
   * ── THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY ──────────────────────
   *
   * `admitted` answers for anything the user has opened, INCLUDING their own
   * file on their own disk — that is what it is for; it is a read gate. Handing
   * that answer to `pdf-meta --out` meant that editing the title of a document
   * in the window between opening it and the background import finishing (or in
   * any case where the import failed and the tab never moved) re-emitted the
   * user's own `E:\…` PDF through pdf-lib and renamed the result over it. A
   * whole-document rewrite of a file this app was only ever asked to LOOK at.
   *
   * So a write resolves to the project's working copy or it does not happen. An
   * unmanaged path is refused with the reason and with what to do about it,
   * rather than being quietly redirected — a metadata dialog that reported
   * success against a file the user was not looking at would be its own bug.
   *
   * ── AND `archive/` IS INSIDE THE LIBRARY AND STILL NOT WRITABLE ────────────
   *
   * `isManaged` answers true for every layer of a project on purpose (its own
   * header says so), and that was a complete gate for exactly as long as no
   * surface ever put an archived path in front of a writer. Standing on the origin
   * row now shows the untouched original (`documentAtPosition`, projects.ts), so
   * the dialog's `tab.path` can be that file — and a title edit made there would
   * re-emit the only copy of somebody's scan this program knows of through
   * pdf-lib, silently, in the one place the app promises it does not. The refusal
   * names the row rather than the folder: a step is named by the action it was.
   */
  const writablePdf = (candidate: string): string => {
    const resolved = admittedPdf(candidate);
    if (isArchived(resolved)) {
      throw new Error(
        'This is the document exactly as you imported it, which Foundry keeps and never writes to. '
        + 'Step forward off the import in the history panel and edit the copy this app works on.',
      );
    }
    if (isManaged(resolved)) return resolved;
    throw new Error(
      `"${resolved}" is your own file, outside Foundry's library, and this app does not write to `
      + 'documents it did not make. Foundry keeps a copy of every document you open — open this '
      + 'one from Home and edit that, and your original stays exactly as it is.',
    );
  };
  ipcMain.handle(
    'meta:write-pdf',
    (_event, filePath: string, patch: Record<string, string | undefined>) =>
      writePdfMetadata(writablePdf(filePath), patch),
  );

  /*
   * ── The block editor ─────────────────────────────────────────────────────
   *
   * A scan's blocks come from the ENGINE, off the readings bank, because the
   * engine is what decides where one block ends and the next begins — the
   * markdown split into parts, the furniture set aside, the quotes it
   * synthesises. An amendment naming `7:14` has to mean the same element here as
   * it will in the conversion that applies it, and one program deciding that is
   * the only way that stays true.
   *
   * WHICH FILES, AND WHICH READING, ARE MAIN'S. The renderer names the PDF it has
   * open — through `admittedPdf`, the same allow-list the pdf.js viewer's own
   * bytes go through, so this cannot become a door onto files nobody opened — and
   * `locateOverlay` turns that into a project, a bank, a curation, its ledger and
   * the generation all three are bound to. See electron/overlays.ts for what
   * happens when that generation has moved: the files are archived aside, never
   * deleted, and the notice says where they went.
   */
  /**
   * ── AN UNREAD BOOK IS A STATE, NOT AN EXCEPTION ────────────────────────────
   *
   * `locateOverlay` THROWS for every book it cannot place: one outside the library,
   * one whose project has no reading, one whose bank is not on disk. That is the
   * right shape for a function with several callers, some of which are about to
   * write files — and it was the wrong thing for this handler to let through. The
   * renderer asks for blocks whenever a position wants outlines, so a book nobody
   * has read yet threw an `OverlayError` across the IPC boundary and into the
   * console as an unhandled rejection, once per repaint, saying nothing anybody
   * could act on about a state that is completely ordinary.
   *
   * `readPdfBlocks` ALREADY HAS THE ANSWER SHAPE. It refuses softly — `{ ok: false,
   * reason }` — precisely because "this engine build has no blocks command" and
   * "this book has never been read" are sentences a person should meet in the pane
   * rather than as a broken tab, and the renderer already draws that shape. So the
   * refusal from one line earlier joins the refusals from one line later, in the
   * same shape, and the console goes quiet.
   *
   * `locateOverlay` ITSELF IS UNTOUCHED: the commit path and the undo ledger both
   * rely on the throw, and turning a refusal into a value there would mean a
   * caller that meant to write a file quietly writing nothing. What is soft is
   * this door, which only ever draws.
   *
   * ANYTHING THAT IS NOT AN `OverlayError` STILL REJECTS. A disk that will not read
   * or a catalogue that will not parse is not a state of the book, and swallowing
   * it here would turn a real fault into an empty pane with a plausible sentence
   * under it.
   */
  ipcMain.handle('overlay:blocks', async (_event, filePath: string) => {
    const pdf = admittedPdf(filePath);
    let where;
    try {
      where = await locateOverlay(pdf);
    } catch (err) {
      if (err instanceof OverlayError) return { ok: false, reason: err.message };
      throw err;
    }
    /*
     * THE ARCHIVED ORIGINAL, not the document the tab is showing. The engine
     * needs a PDF only to re-measure a bank that recorded no render sizes, and
     * measuring the WORKING copy would measure a real-text reprint — type on
     * blank paper, the same page sizes, none of the ink the model was shown. The
     * boxes would come back plausible and wrong. See `OverlayLocation.source`.
     */
    return readPdfBlocks(where.source ?? pdf, where.readings);
  });
  ipcMain.handle('overlay:load', (_event, filePath: string) =>
    loadOverlayFile(admittedPdf(filePath)));
  // Called after every gesture that changes a curation. Whole file, atomically,
  // for `history:save`'s reason: a crash mid-write is exactly the case the
  // flush-on-every-change design exists for.
  ipcMain.handle('overlay:save', (_event, filePath: string, file: OverlayFileWire) =>
    saveOverlayFile(admittedPdf(filePath), file as OverlayFile));
  ipcMain.handle('overlay:ledger-load', (_event, filePath: string) =>
    loadOverlayLedger(admittedPdf(filePath)));
  ipcMain.handle('overlay:ledger-save', (_event, filePath: string, stacks: LedgerStacks) =>
    saveOverlayLedger(admittedPdf(filePath), stacks));
  /**
   * Freeze the corrections as a curation step.
   *
   * Through `admittedPdf` like every other call in this family: the renderer names
   * the scan it already has open and main resolves the project, the reading
   * generation and where a snapshot goes. A commit WRITES A FILE and mints a step
   * that the delete card will one day offer to destroy, so it is not a door a
   * renderer gets to point at an arbitrary path.
   *
   * A refusal — nothing corrected yet — REJECTS with its sentence, so it reaches
   * the notice strip through the renderer's ordinary catch rather than looking
   * like a commit that quietly did nothing.
   */
  ipcMain.handle('overlay:commit', (_event, filePath: string) =>
    commitOverlay(admittedPdf(filePath)));
  /**
   * What this book holds that no save of it does — asked on the way out of a
   * document, so it must never do anything but read.
   *
   * IT ANSWERS NULL FOR EVERY REFUSAL rather than rejecting, and that is the whole
   * of the error handling on purpose. Every sentence `locateOverlay` throws is
   * about a book that has nothing at stake here — a document outside the library,
   * a scan nobody has read — and a rejection would have to become either a dialog
   * saying something a person closing a tab cannot act on, or a silence that
   * closed anyway. Null is that silence, said deliberately.
   *
   * Through `admittedPdf` like the rest of the family: the renderer names a scan
   * it already has open, and main decides which project that is.
   */
  ipcMain.handle('overlay:uncommitted', async (_event, filePath: string) => {
    try {
      return await uncommittedIn(admittedPdf(filePath));
    } catch {
      return null;
    }
  });

  // ── The step ledger ──────────────────────────────────────────────────────
  /*
   * ONE FAMILY, AND MAIN PROVES THE DIRECTORY ON EVERY MEMBER OF IT.
   *
   * The renderer names a project directory, exactly as it names a PDF above, and
   * `deleteStep` unlinks files inside whatever it was handed — which is the same
   * authorization problem `deletableProjectDir` exists for and is gated by the
   * same check (electron/projects.ts). The read and the pointer move ask it too,
   * deliberately: a gate that only guards the destructive call is a gate somebody
   * routes around by reading first.
   *
   * DESCRIBE, THEN DELETE, on the document delete's precedent and for its reason.
   * `describe-delete` composes the facts AND proves the delete is currently
   * allowed, so a card is never drawn for something that would be refused a click
   * later; `delete` proves it again, because a renderer that skipped the question
   * meets the same refusal. The origin is refused by name in both — deleting the
   * import is deleting the project, and the project ✕ does that with its own
   * ceremony and its own accounting of what it costs.
   */
  /**
   * A job writing into this project, and a delete that would take its payload.
   *
   * ── Why the delete owes this and the other two calls do not ─────────────────
   *
   * A held, queued or running job is a run that HAS ALREADY CHOSEN where its
   * output goes: the bank is named, the EPUB's path is composed, and the parent
   * step was captured when somebody pressed the button. Deleting a step while one
   * waits is aimed at exactly the file that run is about to write — the reading
   * whose bank it is filling, or the translation whose EPUB it is composing — and
   * the two possible orders are both wrong. Destroy the payload first and the run
   * finishes into a folder whose catalogue no longer describes it, leaving hours
   * of GPU nothing in this app names. Let the run land first and it appends
   * against a parent this delete has just taken off the ledger, which `landStep`
   * survives by falling back to the position, but only by filing the work
   * somewhere nobody chose.
   *
   * SO THE STEP DELETE REFUSES, on the project delete's own terms and with the
   * same vocabulary — the shelf is where a person cancels a job, and the sentence
   * says so. Coarse on purpose: ANY job writing into this project, not just one
   * whose output happens to be a payload in the doomed subtree. The narrower test
   * would have to predict where a run that has not started will write, and being
   * clever about that is how a delete comes to race a job it decided was unrelated.
   *
   * ── THE OTHER TWO ARE NOT UNSAFE, AND REFUSING THEM WOULD BE ITS OWN BUG ────
   *
   * `ledger:go` writes one field of the manifest and touches nothing else. The
   * design already defends the case it looks dangerous in: a job captures its
   * parent at enqueue (`Job.parentStep`) and its overlay at plan time
   * (`planConversion`), precisely so that clicking through the history while a run
   * waits cannot retarget it. Moving the pointer is a repaint, it is free, and
   * people do it while they wait — refusing it during a three-hour reading would
   * take the history panel away for the whole time it is most wanted, to prevent
   * nothing.
   *
   * `overlay:commit` writes `curations/<uuid>.json`, a path no job can be about to
   * write, and appends a step of its own. It is the one action in this app that
   * retains IRREPLACEABLE work — somebody's judgements about four hundred blocks —
   * and refusing to let a person save those because a machine is busy would be
   * this app declining to keep the only thing in a project it cannot make again.
   * The interesting case is a commit made while a re-read is running, and the
   * ledger already has the right answer for it: the snapshot is retained, and when
   * the reading lands and replaces its parent, `markStale` dims the save rather
   * than destroying it (the retention rule: user labour is never destroyed by a
   * re-run). That is the designed outcome, not a race.
   */
  /*
   * THE OTHER REFUSAL IS NOT HERE, AND THAT IS DELIBERATE. A book this window has
   * open cannot have its working tree unlinked, and `describeStepDelete` and
   * `deleteStep` both refuse that case themselves (electron/projects.ts,
   * `refuseOpenPayload`) — because deciding it needs the sweep, which needs the
   * manifest, which is that module's. It is the document delete's model rather
   * than the project delete's: the narrow test on the tree this step's own payload
   * serves, plus the renderer closing the tab between the confirm and the call.
   */
  const refuseBusyStepDelete = async (projectDir: string, stepId: string): Promise<void> => {
    // `deletableStep` proves the directory, names the step, AND runs the refusal
    // that never lifts — the origin is not a deletable step at any hour — so this
    // never tells somebody to cancel a job for a delete that would refuse them
    // afterwards anyway.
    const subject = await deletableStep(projectDir, stepId);
    refuseBusyJob(subject, `“${subject.label}” cannot be deleted yet — that run is about to write `
      + 'into this project, and destroying a step\'s files while it does would leave the job '
      + 'finishing into a history this app no longer has. Cancel it in the shelf, or let it land, '
      + 'then delete the step.');
  };

  ipcMain.handle('ledger:read', (_event, projectDir: string) => readStepLedger(projectDir));
  ipcMain.handle('ledger:go', (_event, projectDir: string, stepId: string) =>
    goToStep(projectDir, stepId));
  /*
   * THE SAME MOVE, NAMED BY A DOCUMENT INSTEAD OF BY A ROW.
   *
   * `go` is the user pointing at a step; this is the user pointing at a document
   * and the app working out which step that is — the gesture behind "focusing a
   * tab moves the position back" (docs/WORKBENCH.md §6c). The resolution is
   * `standForDocument` (electron/projects.ts), beside the forward direction it has
   * to agree with, for the reason every other path in a project is composed there:
   * a renderer deciding for itself which step a file belongs to would be a second
   * opinion about the ledger, and the way that opinion goes wrong is that it
   * stands somebody on the import and then translates their scan.
   *
   * NO PATH IS ADMITTED HERE, and the difference from `document-at` is worth
   * saying out loud. That call ANSWERS with a path this process then has to let a
   * viewer open, so it adds it to the allow-list. This one is handed a path the
   * renderer already has open — the allow-list said yes to it when the document
   * was opened — and answers with rows. A handler that admitted whatever it was
   * given would be a door that grants access for being asked a question.
   */
  ipcMain.handle('ledger:stand-for', (_event, projectDir: string, filePath: string) =>
    standForDocument(projectDir, filePath));
  /*
   * MAIN RESOLVES IT, SO MAIN ADMITS IT — the same pairing the import's relocation
   * already makes (`document:relocated`, above), and for the same reason. The
   * renderer is about to point a viewer, the block editor and the metadata dialog
   * at this path, and every one of those doors asks the allow-list; a path the
   * renderer named for itself is a path this process never agreed to serve.
   *
   * NOT REMEMBERED AS A RECENT. Nothing was opened here: the person clicked a row
   * in the history of a book they already have open, and a library list that grew
   * a row per click of the Steps accordion would be bookkeeping about a gesture
   * that is meant to be free.
   */
  ipcMain.handle('ledger:document-at', async (_event, projectDir: string) => {
    const resolved = await documentAtPosition(projectDir);
    if (resolved !== null) openable.add(path.resolve(resolved));
    // Fire and forget, deliberately — see `towardTheFlowingBook`. The answer is
    // the document that exists NOW; a pane held blank while a rendering runs
    // would be this handler waiting for a job the caller never asked for.
    if (resolved !== null) void towardTheFlowingBook(resolved);
    return resolved;
  });
  ipcMain.handle('ledger:describe-delete', async (_event, projectDir: string, stepId: string) => {
    // Proven BEFORE the card is composed, so a warning is never put on screen for
    // something the delete would refuse a click later.
    await refuseBusyStepDelete(projectDir, stepId);
    return describeStepDelete(projectDir, stepId);
  });
  ipcMain.handle('ledger:delete', async (_event, projectDir: string, stepId: string) => {
    // Proven again, never trusted from the describe: a job can be queued between
    // the question and the answer, and this is the call that unlinks something.
    await refuseBusyStepDelete(projectDir, stepId);
    return deleteStep(projectDir, stepId);
  });

  // ── The library folder ───────────────────────────────────────────────────
  ipcMain.handle('library:dir', () => readAppSettings().libraryDir);
  ipcMain.handle('library:set', (_event, dir: string) =>
    writeAppSettings({ libraryDir: dir }).libraryDir);
  ipcMain.handle('library:choose', async (_event, current: string) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Where should Foundry keep your books?',
      defaultPath: current,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // ── Home's list ──────────────────────────────────────────────────────────
  ipcMain.handle('recents:list', () => listRecents());
  ipcMain.handle('recents:forget', (_event, filePath: string) => forgetRecent(filePath));
  ipcMain.handle('recents:clear', () => clearRecents());

  /**
   * The position of the project a job is about to write into, at the press.
   *
   * ── Why the press and not the spawn ─────────────────────────────────────────
   *
   * A job's product is recorded as having been made FROM a step, and that step is
   * what decides whether a re-run replaces an earlier one (staling everything
   * downstream) or branches beside it. Moving the pointer, meanwhile, is free and
   * unconfirmed — people click through their own history while they wait, which is
   * exactly what the history is for. So a job that read its parent when it landed
   * would be retargeted by a glance: queue a translation from the reading, click
   * back to compare two saves, and three hours later the app files a translation
   * of a save nobody asked it to translate.
   *
   * Resolved HERE, in the handler, so the read of the catalogue and the enqueue
   * happen in one turn and `queue.enqueue` stays synchronous — the shelf row has
   * to appear the instant Add is pressed (see that function).
   *
   * FROM THE JOB'S OWN OUTPUT PATH, which is main's composition rather than the
   * renderer's word: `workspace:plan*` built it, into a project directory this app
   * chose. A request naming somewhere else answers null and lands on the same
   * fallback a project with no history does.
   */
  const parentStepFor = async (target: string): Promise<string | null> => {
    const dir = projectDirOf(target);
    return dir === null ? null : positionStepId(dir);
  };

  ipcMain.handle('queue:list', () => queue.listJobs());
  ipcMain.handle('queue:enqueue', async (_event, request: JobRequest) => queue.enqueue(
    request,
    // The BANK for a reading, the rendering's output otherwise — the same
    // `outputPath` the queue dedupes on, and the only path in a request that is
    // certainly inside the project the job is about.
    await parentStepFor(request.kind === 'read' ? request.readingsPath : request.outputPath),
  ));
  ipcMain.handle('queue:enqueue-translate', async (_event, request: TranslateRequest) => {
    // The input again, because a request can arrive with any `inputPath` at all
    // — `workspace:plan-translation` checked the one it was given, not the one
    // that ends up here.
    if (admitted(request.inputPath) === null) {
      throw new Error(`${request.inputPath} was never opened in this app.`);
    }
    return queue.enqueueTranslate(request, await parentStepFor(request.outputPath));
  });
  ipcMain.handle('queue:start', () => queue.start());
  ipcMain.handle('queue:remove', (_event, id: string) => { queue.remove(id); });
  ipcMain.handle('queue:cancel', (_event, id: string) => { queue.cancel(id); });
  ipcMain.handle('queue:clear-finished', () => { queue.clearFinished(); });

  ipcMain.handle('engine:info', () => engineInfo());
  ipcMain.handle('doctor:run', (_event, endpointUrl?: string) => runDoctor(endpointUrl));

  ipcMain.handle('settings:read', () => readSettings());
  ipcMain.handle('settings:write', (_event, patch: BackendSettingsPatch) => writeSettings(patch));

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    shell.showItemInFolder(path.resolve(target));
  });

  // ── WSL, the environment, and the server ─────────────────────────────────
  ipcMain.handle('wsl:facts', () => listDistros());
  ipcMain.handle('wsl:tooling', (_event, distro: string) => detectEnvTooling(distro));

  // The tooling is re-measured HERE rather than trusted from the renderer: the
  // route the user picked is a choice, but what the distro actually has is a
  // fact, and a fact the renderer asserted is a fact main did not check.
  ipcMain.handle('backend:setup-run', async (_event, request: SetupRequest) => {
    const tooling = await detectEnvTooling(request.distro);
    return setupWslEnv(request, tooling, (event) => broadcast('backend:setup-log', event));
  });
  ipcMain.handle('backend:setup-cancel', () => { cancelSetup(); });

  // ── The prebuilt environments ────────────────────────────────────────────
  ipcMain.handle('env:catalog', () => catalogForThisMachine());

  // An install is QUEUED, never awaited across IPC. The download is minutes to
  // an hour, and a renderer reload that dropped the promise would leave a job
  // running that nothing was left to report to — the same reason conversions
  // live in main. The shelf and `env:install-progress` carry the rest.
  ipcMain.handle('env:install', (_event, request: EnvInstallRequest) =>
    queue.enqueueEnvInstall(request).id);
  // Through the QUEUE, so the row ends as `cancelled` rather than as a failure
  // whose error text happens to read "Cancelled."
  ipcMain.handle('env:cancel', () => { queue.cancelEnvInstalls(); });

  ipcMain.handle('env:choose-dest', async (_event, defaultPath: string) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Where should the environment go?',
      defaultPath,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('vllm:status', () => vllm.serverStatus());
  ipcMain.handle('vllm:start', () => vllm.ensureServer());
  ipcMain.handle('vllm:stop', () => vllm.stopServer('the Stop button'));
  // The keep-warm knob is APP policy, not engine settings: the engine neither
  // starts nor stops servers, so its settings.json never carries this. The
  // queue reads it at every drain (job-queue.ts), so a change applies to the
  // very next one — no restart, no re-plumb.
  ipcMain.handle('vllm:keep-warm', () => readAppSettings().keepServerWarmMinutes);
  ipcMain.handle('vllm:set-keep-warm', (_event, minutes: number) =>
    writeAppSettings({ keepServerWarmMinutes: minutes }).keepServerWarmMinutes);

  queue.onQueueChanged((jobs) => broadcast('queue:changed', jobs));
  /*
   * THE LIBRARY CHANGED, said out loud, which it never used to be.
   *
   * The renderer's project list re-read on three occasions — it was constructed,
   * Home appeared, or a queue job landed — and a BACKGROUND IMPORT is none of
   * them. A dropped scan therefore became a project on the disk that the app went
   * on denying the existence of until something unrelated happened to refresh
   * the list, and everything that asks "which project is this document in?" was
   * reading that denial.
   *
   * No payload. The listing is main's to compose and re-composing it costs a
   * directory walk, so this says only THAT something moved; the renderer asks
   * for the list itself, the same way the queue's mirror asks for jobs on boot.
   */
  onProjectsChanged(() => broadcast('projects:changed', null));
  vllm.onServerStatus((status) => broadcast('vllm:status-changed', status));
  // Published beside the job row, not instead of it: the shelf reads the queue,
  // the settings card reads this, and neither of them owns the run.
  onEnvInstallProgress((progress) => broadcast('env:install-progress', progress));
}

/** One push to every window. The renderer holds mirrors; main holds the truth. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch what this machine is missing, once, after the window can show it.
 *
 * AFTER `did-finish-load`, not at `whenReady`: the first thing this does is run
 * `foundry doctor --json`, which takes seconds, and the rows it produces go into
 * the queue shelf — a job enqueued before there is a renderer to push to is a
 * download nobody can see or cancel.
 *
 * Only ONCE per launch. doctor is re-run after every install (the settings page
 * does it, and the shelf row's completion is what prompts it), so a second
 * automatic sweep would only ever find the same answer more slowly.
 *
 * `FOUNDRY_NO_AUTO_PROVISION=1` turns it off, for developing against a machine
 * that is deliberately missing something.
 */
let provisioned = false;

async function provision(): Promise<void> {
  if (provisioned) return;
  provisioned = true;
  if (process.env['FOUNDRY_NO_AUTO_PROVISION'] === '1') {
    console.log('[provision] skipped: FOUNDRY_NO_AUTO_PROVISION=1');
    return;
  }
  try {
    const { needs, note } = await planProvisioning();
    console.log(`[provision] ${note}`);
    for (const need of needs) {
      // No `dest`, no `distro`: the defaults, silently, which is the whole point
      // of provisioning. Anything genuinely ambiguous — several WSL distros —
      // comes back out of the installer as a failed row saying how to choose,
      // rather than as a guess.
      queue.enqueueEnvInstall({ target: need.target }, need.reason);
    }
  } catch (err) {
    // Never fatal. An app that will not open a PDF because it could not decide
    // whether to download a Python is worse than one that simply did not.
    console.error(`[provision] gave up: ${(err as Error).message}`);
  }
}

/*
 * Animated wheel scrolling, which Chromium has and Electron ships turned OFF.
 * In a browser a wheel notch glides; in a default Electron app it teleports
 * ~100px, which reads as the page "jumping" under the reader — most visible in
 * the PDF viewer, where the thing being scrolled is a page of a book. Must be
 * set before the app is ready or it is silently ignored.
 */
app.commandLine.appendSwitch('enable-smooth-scrolling');

void app.whenReady().then(async () => {
  applyContentSecurityPolicy();
  registerFileProtocol();
  registerIpc();
  buildMenu();
  /*
   * Regroup a flat workspace and a flat readings directory into projects — see
   * electron/projects.ts, which owns every rule about what it will and will not
   * move.
   *
   * AWAITED, and before the window. Home's first `projects:list` fires as soon
   * as the renderer paints, and a listing taken halfway through the regrouping
   * is a library with half the user's books missing from it — which reads as
   * data loss even though nothing has been lost. It is a directory scan and a
   * handful of same-volume renames on a machine that has been used, and nothing
   * at all on a fresh one.
   *
   * A failure here still opens the window. Every refusal inside is already a
   * named log line, and an app that will not start because it could not tidy a
   * folder is worse than one that started with the folder untidy.
   */
  await adoptLegacyLayout().catch((err: Error) => {
    console.error(`[projects] the existing library could not be regrouped: ${err.message}`);
  });
  // And the one-evening migration beside it, for the same reason and with the
  // same tolerance: a project whose reprint was catalogued as a second document
  // gets it promoted to being the project's PDF (`promoteStrandedReprints`).
  await promoteStrandedReprints().catch((err: Error) => {
    console.error(`[projects] a reprint could not be adopted as its project's PDF: ${err.message}`);
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  void openDocument(filePath);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Quit aborts the run. A conversion that outlived its window would hold a GPU
 * with nothing left to report to — and so would the reading server, which is
 * ~20 GB of VRAM held by a process nothing is left to talk to.
 *
 * The quit is DEFERRED once when there is a server of ours to stop, because
 * that stop is a SIGTERM inside the distro followed by waiting for the CUDA
 * device to come back, and an Electron that exited underneath it would leave
 * the guest process orphaned holding the card. A server this app merely FOUND
 * running is not ours and the quit is immediate.
 */
let quitting = false;
app.on('before-quit', (event) => {
  /*
   * THE DOCUMENTS ARE ASKED BEFORE ANYTHING IS SHUT DOWN, and the order is the
   * whole reason this is here rather than only on the window's `close`. Cmd+Q,
   * File→Quit and the app being asked to exit all reach this event FIRST, before
   * any window is told to close — so a guard that lived only on the window would
   * raise its dialog after the lines below had already aborted every running job
   * and stopped the reading server. Somebody who then answered "keep it open"
   * would have kept their window and lost the three-hour run in it.
   */
  if (!letGo) {
    event.preventDefault();
    letTheWindowGo(() => app.quit());
    return;
  }
  queue.shutdown();
  // The open-book registry, emptied. Nothing on disk goes with it — a working
  // tree lives in its project and is the newest version of that book, which is
  // exactly what makes reopening it free.
  closeAllEpubs();
  if (quitting || !vllm.ownsServer()) return;
  event.preventDefault();
  quitting = true;
  void vllm.stopServer('the app is quitting').finally(() => app.quit());
});
