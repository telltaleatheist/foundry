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
import {
  amendBookOps,
  applyBookOps,
  bookFigureFile,
  correctBookBlock,
  loadBook,
  materializeTranslation,
  viewExportedBook,
} from './book';
import {
  engineInfo,
  readPdfMetadata,
  runDoctor,
  writePdfMetadata,
} from './engine';
import { catalogForThisMachine, onEnvInstallProgress } from './env-install';
import { planProvisioning } from './env-provision';
import * as queue from './job-queue';
import {
  deletableStep,
  deleteDocument,
  deleteProject,
  deleteStep,
  describeStepDelete,
  documentAssets,
  documentAtPosition,
  goToStep,
  importDocument,
  inspectProject,
  type ProjectInventory,
  isArchived,
  isManaged,
  listProjects,
  metadataDir,
  noteProjectTitle,
  onProjectsChanged,
  positionStepId,
  projectDirOf,
  readStepLedger,
  recordMetadata,
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
import { planExport, planReading, planTranslation } from './workspace';
import { detectEnvTooling, listDistros } from './wsl';
import { fold, isBook } from '../shared/original';
import type { ReadAsk } from '../shared/ledger';
import type { BookOp } from '../shared/ops';
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
  EnvInstallRequest,
  JobRequest,
  MetadataPatch,
  MetadataWriteOutcome,
  ProjectDocument,
  ProjectFacsimile,
  ProjectFinal,
  ProjectLedger,
  ProjectSummary,
  StepRow,
  RecentKind,
  ReReadAnswer,
  SetupRequest,
  TranslateRequest,
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
/*
 * The book pane's two, which say what its own gestures are called rather than
 * borrowing the pair above. "Save these corrections" is the block editor's verb
 * over the block editor's noun, and neither is what a person did on the proof
 * sheet; "Close it" is too mild for a button that destroys the only copy of
 * something, which is what closing over a stack does and what closing over a
 * curation never does.
 */
const APPLY = 'Apply these changes, then close';
const DISCARD = 'Discard them and close';

// ─────────────────────────────────────────────────────────────────────────────
// foundry-file:// — how a book's figures reach the page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The renderer is a page on http://localhost:4260 (dev) or file:// (packaged),
 * and neither may load an arbitrary `file://` URL as an image. So the app serves
 * the bytes itself, on a scheme of its own.
 *
 * ONE HOST, AND IT IS THE LAST ONE: `foundry-file://book/<token>/<figure name>`
 * — a crop the engine cut beside the bank, for an open book's proof sheet. Two
 * others have been retired and both for the same reason, which is that a serving
 * route with no consumer is a door into files on disk kept open for nobody:
 * `open` served whole PDFs to Chromium's viewer (PDFs go to the app's own pdf.js
 * through `document:read-bytes` now), and `epub` served chapters out of an
 * unpacked working tree to an <iframe> that no longer exists (docs/RENDERER.md
 * §7). What survives is allow-listed rather than path-checked: `bookFigureFile`
 * answers only for a token a successful `book:load` minted, so a renderer that
 * was talked into asking for `C:\Users\…\id_rsa` gets a 403 rather than meeting
 * a cleverer path check that has to stay right forever.
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
 * Extension -> content type, for the pictures a book file's figures can be.
 *
 * Chromium decides what to DO with a response from this header and nothing else,
 * and there is no sniffing fallback on purpose: an unknown extension is served
 * as a download rather than guessed into being executable. The list is the image
 * formats a crop can come out as, because the one surviving host serves crops.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Stream a file as a response, or say why not. */
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

    if (url.host === 'book') {
      /*
       * `/<token>/<figure name>` — a cut figure of an OPEN book, and nothing
       * else. The token is minted by a successful `book:load` and looked up in
       * an allow-list (`bookFigureFile`, electron/book.ts), which is the same
       * decision the epub host makes one branch down: a URL the renderer
       * composed for a directory nothing registered is a refusal, not a read.
       * These are app-cut PNGs served to the app's own page — never into a
       * book's sandboxed frame — so they carry the no-store/nosniff pair and
       * no CSP of their own.
       */
      const segments = url.pathname.split('/').filter((part) => part.length > 0);
      const token = segments.shift();
      if (token === undefined || segments.length !== 1) {
        return new Response('No book and figure were named.', { status: 400 });
      }
      const figure = bookFigureFile(token, decodeURIComponent(segments[0]!));
      if (figure === null) {
        return new Response('That book\'s figures are not open in this app.', { status: 403 });
      }
      return serveFile(figure, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    }

    // The old `open` and `epub` hosts are both gone — the first with Chromium's
    // PDF viewer, the second with the iframe reader. 404 rather than silence, so
    // a stale URL says what happened to it.
    return new Response('This app no longer serves whole files; a book\u2019s figures only.', { status: 404 });
  });
}

/**
 * The renderer's Content-Security-Policy, on the DOCUMENT only.
 *
 * `img-src foundry-file:` is the whole reason this is written by hand: a book
 * file's figure crops are the one cross-scheme thing the page is allowed to load,
 * and there is no `frame-src` at all any more because there is no frame.
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
  // `foundry-file:` for the book pane's figures — the crops the engine cut
  // beside the bank, served through the allow-listed `book` host and nothing
  // else on that scheme reachable as an image.
  "img-src 'self' data: blob: foundry-file:",
  "font-src 'self' data:",
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
   * waits on it: the work is serialised per folder (projects.ts), so whatever
   * asks about this project next queues behind the import rather than racing it.
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
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('document:relocated', { from: resolved, to: working });
      }
    }
    /*
     * The PDF's own idea of its title, noted here because for a project that
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
  /**
   * SAVE A COPY OF AN EXPORT — the door the finished shelf row presses.
   *
   * Gated on the FINAL TRAY rather than the opened-documents allow-list,
   * because an export was never "opened": it is a file this app just wrote
   * into `<project>/final/`, and membership in a project's tray is exactly the
   * claim being exercised. Anything else — a path outside every project, or
   * inside one but not in its tray — is refused; this door copies exports and
   * copies nothing else.
   */
  ipcMain.handle('export:save-copy', async (_event, target: string) => {
    const resolved = path.resolve(target);
    const dir = projectDirOf(resolved);
    const inside = dir === null ? null : path.relative(dir, resolved).split(path.sep);
    if (dir === null || inside === null || inside.length !== 2 || inside[0] !== 'final') {
      throw new Error('That file is not one of this library’s exports.');
    }
    const extension = path.extname(resolved).replace('.', '').toLowerCase();
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Save a copy of this export',
      defaultPath: path.join(app.getPath('downloads'), path.basename(resolved)),
      filters: extension.length > 0
        ? [{ name: extension.toUpperCase(), extensions: [extension] }]
        : [],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) === resolved) {
      throw new Error('That is the file itself. Pick somewhere else to put the copy.');
    }
    await fsp.copyFile(resolved, result.filePath);
    return result.filePath;
  });

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
   * Worded around what is ACTUALLY at risk. Closing a tab deletes nothing on
   * disk — the project keeps every byte of the book and Home still lists it — so
   * what a close can cost is a stack of changes nobody applied, and nothing
   * else. Telling a user their work is
   * about to be destroyed when it is not would teach them to distrust the next
   * warning that matters.
   *
   * ── TWO REASONS, ONE QUESTION ───────────────────────────────────────────────
   *
   * A book pane's unapplied changes are genuinely destroyed by closing, and a
   * book's filed copy can be out of date. They are two different losses and this
   * app has already ruled that a closing document is asked about once
   * (`closeShowing`, tabs.service.ts): a second card on top of the first is the
   * app arguing with an answer it already has.
   *
   * IT WAS THREE. The third — "no copy of this exists anywhere you chose" — went
   * with the user's own ruling (*"only pop up a confirmation alert if changes have
   * been made"*), and the fourth, the block editor's uncommitted CURATION, went
   * with the block editor itself: there is one editing surface now and its
   * unapplied work is the stack, which is the first arm below.
   */
  ipcMain.handle(
    'document:confirm-close',
    (_event, warning: CloseWarning): Asked<CloseAnswer> => ({
      kind: 'ask',
      /*
       * THE STACK LEADS WHEN THERE IS ONE, ahead of both the others, because it is
       * the only loss on this card that is a loss. A book pane's unapplied changes
       * are in memory and closing genuinely destroys them; the corrections are on
       * disk and the filed copy is merely old. A card that opened with "your copy
       * is out of date" while somebody was about to lose an afternoon's strikes
       * would have buried the one sentence that mattered under the one that did
       * not.
       */
      question: warning.edits !== null && warning.edits > 0
        ? aboutTheEdits(warning, warning.edits)
        : aboutTheCopy(warning),
    }),
  );

  /**
   * THE ONE CARD IN THIS APP THAT IS ALLOWED TO SAY THE WORK WILL BE LOST.
   *
   * ── Why it is allowed, when everything around it was forbidden ──────────────
   *
   * The card this used to sit beside — `aboutTheCorrections` — existed to STOP
   * this app saying "you have unsaved changes that will be lost", because in the
   * block editor it was false: every strike was written into the live curation as
   * it was made. That editor is gone and so is the card. The book pane is the
   * other case and the difference was always the design's, not an accident.
   * Changes on the proof sheet are a LIFO stack held in memory precisely so that
   * undo is cheap and free of the disk, and the ruling that pays for that is the
   * one this card reports: Apply writes them and clears the stack; closing without
   * it scraps them (docs/RENDERER.md §3). So the true sentence here is the
   * frightening one, and softening it would be the worse lie.
   *
   * WHICH IS EXACTLY WHY THE OFFER IS A BUTTON. A dialog whose only route to
   * keeping the work is *cancel, find Apply, close again* has made the person do
   * the app's job, and the way that ends is that they stop reading the box. Apply
   * is offered first and is what Enter takes; Close is last and wears the error
   * colour, so the button that destroys has to be aimed at.
   *
   * NO COUNT OF WHAT KIND. "5 changes" is what the card says, not "3 strikes, a
   * relabel and an edit" — the changes themselves are on the paper behind the
   * dialog, in the cancel marks and the changed paragraphs, and that is a better
   * description of them than a tally of verbs would be.
   */
  function aboutTheEdits(warning: CloseWarning, edits: number): AppQuestion {
    const changes = edits === 1 ? '1 change' : `${edits} changes`;
    /*
     * The filed copy, when this tab owes that as well. Kept to a clause and put
     * last: it is the smaller loss, and the buttons are about the stack.
     */
    const alsoTheCopy = warning.modified
      ? [
        'The copy you filed for yourself is also older than this one, and closing does not bring '
        + 'it up to date. Export the book again to replace it.',
      ]
      : [];
    return {
      title: 'Close and discard these changes?',
      message: `“${warning.title}” has ${changes} that have not been applied.`,
      detail: [
        'Changes made on the book are held while you work so that taking one back is instant, and '
        + 'they are not written down until you apply them. Closing throws them away — there is no '
        + 'copy of them anywhere else and nothing brings them back.',
        'Applying now records all of them as one row in Steps, which you can stand on, branch from '
        + 'and delete afterwards. The book itself is untouched either way.',
        ...alsoTheCopy,
      ],
      choices: [
        { key: 'save', label: APPLY },
        { key: 'keep', label: KEEP },
        { key: 'close', label: DISCARD, danger: true },
      ],
      preferred: 'save',
      dismissed: 'keep',
      checkbox: null,
    };
  }

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
   * the same: the rendering plans do not read the path they are
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
   * A translation is asked ABOUT a file the renderer already has open, so the
   * path is checked against the SAME allow-list every other read is. Without it
   * this handler would resolve — and then plan against — any path a compromised
   * renderer named.
   *
   * ── `exportWorkingCopy` USED TO RUN FIRST, AND ITS REASON IS GONE ──────────
   *
   * It repacked the open book's working tree into `working/` and handed the job
   * THAT, because the engine is a separate process given a path and a book edited
   * since it was cast would otherwise have been translated as it was before the
   * edits. The run does not read an EPUB any more: `planTranslation` materialises
   * the position's own book file — every applied change replayed into it — and
   * that is what the engine is handed (`TranslateRequest.bookPath`). So the
   * repack bought nothing, and the refusal inside it ("that is not the book
   * Foundry has open in that project") had become a refusal about a file nothing
   * in the run would ever open. A guard whose premise has been removed is not a
   * safety margin; it is a stop sign in a field.
   *
   * The path that comes back is the one admitted here, so the queue's re-check of
   * `inputPath` against the same allow-list finds exactly what this admitted.
   */
  ipcMain.handle('workspace:plan-translation', async (_event, inputPath: string, targetLanguage: string) => {
    const source = admitted(inputPath);
    if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
    const plan = await planTranslation(source, targetLanguage);
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

  /**
   * The same question asked of the TRAY, which is a different catalogue.
   *
   * ── The bug this closes ─────────────────────────────────────────────────────
   *
   * The library tree draws a ✕ on export rows, and every one of them threw:
   * `findDocument` searches `project.documents` — the CHAIN, what each step
   * produced — while an export row comes from `manifest.final` by way of
   * `filedDocuments`. Two catalogues, and the delete only knew one, so pressing
   * the ✕ on a file this app had just made produced "is not a document in any
   * of Foundry's projects" — a sentence written for a path somebody typed from
   * outside the library, shown for a row the app drew from its own manifest.
   *
   * ── Why a separate door instead of teaching `findDocument` about final/ ─────
   *
   * Because an export is not a document in the sense the delete pair means. It
   * has no steps, no retention, no origin; it can never be the book the project
   * is built on; nothing was made FROM it. Folding it into the document lookup
   * would put a row in front of `isBook`, `documentAssets` and the original's
   * refusal — three questions that have no answer for a file in the tray — and
   * the first one to guess would be a bug nobody could see coming.
   *
   * `final/` is the user's own tray (`projects.ts`, `filedDocuments`): they may
   * have already moved it onto a reader or deleted it themselves, which is why
   * a row whose file has gone is a REMOVAL and not an error.
   */
  async function findExport(filePath: string): Promise<{
    project: ProjectSummary;
    made: ProjectFinal;
    label: string;
  } | null> {
    const target = fold(filePath);
    for (const project of await listProjects()) {
      for (const made of project.exports) {
        // Whole paths, never basenames — this project holds `generated/Book.pdf`
        // and `final/Book.pdf` at once, and the layer is the only thing telling
        // them apart. The oldest house rule in this codebase.
        if (fold(path.join(project.dir, ...made.file.split('/'))) !== target) continue;
        return { project, made, label: path.basename(made.file) };
      }
    }
    return null;
  }

  /**
   * And the same question asked of the FACSIMILES, which is a third catalogue —
   * or rather a third listing, since nothing catalogues these at all.
   *
   * ── The same bug, one row further down the tree ─────────────────────────────
   *
   * The nav draws a ✕ on facsimile rows exactly as it draws one on exports, and
   * every one of them threw the sentence written for a path somebody typed from
   * outside the library. A facsimile is in NEITHER of the two lookups above it:
   * `project.documents` is the chain and `project.exports` is `manifest.final`,
   * while `ProjectSummary.facsimiles` is composed by scanning `generated/` for
   * the name each read step's id makes (`facsimilesOf`, electron/projects.ts).
   * Three listings, and the delete knew two.
   *
   * ── Why a third door and not a branch in either of the others ───────────────
   *
   * `findExport`'s argument, and it applies harder here. An export at least has a
   * row in the manifest; a facsimile has nothing — no steps, no retention, no
   * origin, nothing made FROM it, and no catalogue entry to strike out. Every
   * question the document path asks (`isBook`, `documentAssets`, the original's
   * refusal) is a question with no answer for a page-for-page reprint, and the
   * first one to guess would be the bug nobody sees coming.
   *
   * AND IT IS THE CHEAPEST THING IN THE PROJECT TO LOSE, which is why its card is
   * one line shorter than an export's: the bank it reprints is kept whatever
   * happens, so the reprint is seconds of offline arithmetic away for as long as
   * the reading exists.
   */
  async function findFacsimile(filePath: string): Promise<{
    project: ProjectSummary;
    made: ProjectFacsimile;
    label: string;
  } | null> {
    const target = fold(filePath);
    for (const project of await listProjects()) {
      for (const made of project.facsimiles) {
        // Whole paths with their layer, never basenames — the same rule spelled
        // out above `findExport`, and a facsimile lives in `generated/` beside a
        // cast and a rotated predecessor of itself.
        if (fold(path.join(project.dir, ...made.file.split('/'))) !== target) continue;
        return { project, made, label: path.basename(made.file) };
      }
    }
    return null;
  }

  ipcMain.handle('documents:describe', async (_event, filePath: string): Promise<DocumentDeletion> => {
    /*
     * THE TRAY IS ASKED FIRST, and the question it gets is its own. Removing an
     * export takes the file and its row and nothing else: no chain to unpick, no
     * working tree, no history, and nothing was ever made from it. Saying so in
     * one sentence is the honest card — the document card's paragraph about the
     * readings bank surviving would be reassurance about a danger that was never
     * on the table.
     */
    const filed = await findExport(filePath);
    if (filed !== null) {
      // `final/` is the user's own tray, so the file may legitimately not be
      // there — moved onto a reader, handed to somebody, deleted by hand. That
      // is a row to clear, not an error to raise, and it changes the sentence.
      const gone = await fsp.access(filePath).then(() => false, () => true);
      return {
        prompt: {
          message: `“${filed.label}” will be removed from “${filed.project.title}”.`,
          detail: [
            gone
              ? 'That file is no longer on the disk — moved or deleted somewhere else — so this '
                + 'clears the row that still lists it.'
              : 'The file is deleted from the disk. Foundry keeps no copy of it anywhere else.',
            'Nothing else changes: this is one of the finished documents you exported, and the '
            + 'book, its readings and every step it was made from stay exactly as they are. You '
            + 'can export it again at any time.',
          ],
          confirm: gone ? 'Remove this row' : 'Delete this export',
        },
        original: false,
        projectDir: filed.project.dir,
        missing: gone,
      };
    }

    /*
     * THEN THE REPRINTS, and their card is the shortest one in this app because
     * there is genuinely almost nothing to warn anybody about. A facsimile is a
     * rendering of a bank that is kept whatever else happens: no step points at
     * it, nothing was made from it, and the reading it reprints is untouched by
     * its going. Saying so plainly is the honest card — the document card's
     * paragraph about the bank surviving reads as reassurance about a danger that
     * was never on the table, which is how people learn to skip these.
     */
    const reprint = await findFacsimile(filePath);
    if (reprint !== null) {
      // The listing stats before it draws a row, so this is the window between
      // that stat and this click — somebody tidying `generated/` by hand, a
      // window holding a tree from a minute ago. A row to clear, not an error.
      const gone = await fsp.access(filePath).then(() => false, () => true);
      return {
        prompt: {
          message: `“${reprint.label}” will be deleted from “${reprint.project.title}”.`,
          detail: [
            gone
              ? 'That file is no longer on the disk — moved or deleted somewhere else — so this '
                + 'clears the row that still lists it.'
              : 'The file is deleted from the disk. Foundry keeps no copy of it anywhere else.',
            'The readings bank and every step in this project stay exactly as they are. This is '
            + 'the pages of one reading reprinted, nothing is made from it, and you can make it '
            + 'again from that reading at any time — it costs seconds and no GPU.',
          ],
          confirm: gone ? 'Remove this row' : 'Delete this facsimile',
        },
        original: false,
        projectDir: reprint.project.dir,
        missing: gone,
      };
    }

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
    /*
     * The tray again, and asked again rather than trusted from the describe —
     * same rule as the busy-job proof below: this is the call that unlinks
     * something, and the catalogue may have moved under it.
     *
     * `deleteDocument` already does exactly the right thing with a `final/`
     * path: it strikes the row out of `manifest.final` by LAYER (`inLayer`),
     * removes the file, and sweeps nothing else, because an export has no
     * working tree, no archived predecessors and no history to sweep. Only the
     * lookup above it was blind.
     */
    const filed = await findExport(filePath);
    if (filed !== null) {
      refuseBusyJob(await inspectProject(filed.project.dir));
      const removed = await deleteDocument(filePath);
      forgetRecentsUnder(filePath);
      return removed.wasMissing
        ? `Removed “${filed.label}” from “${filed.project.title}” — the file was already gone.`
        : `Deleted “${filed.label}” from “${filed.project.title}”.`;
    }

    /*
     * The reprints, asked again for the same reason the tray is: this is the call
     * that unlinks something and the listing may have moved under it.
     *
     * `deleteDocument` is already right for a `generated/` facsimile, and it is
     * right by construction rather than by luck. THE MANIFEST NEEDS NOTHING DONE
     * TO IT: a facsimile is in no list in `project.json`, so the documents filter
     * matches no chain (nothing names this file as a step's payload), and
     * `working.files` and `final` are asked only about their own layers. THE ROW
     * GOES BECAUSE THE FILE DOES: `facsimilesOf` composes the name from the read
     * step's id and stats it, so the listing is the directory's answer and a
     * deleted file is a listing with one fewer row in it the next time anything
     * asks. And the SWEEP is exactly what it should be: the archived copies of
     * this same name beside it, which for a name carrying a step's own id can
     * only be earlier reprints of that same reading.
     */
    const reprint = await findFacsimile(filePath);
    if (reprint !== null) {
      refuseBusyJob(await inspectProject(reprint.project.dir));
      const removed = await deleteDocument(filePath);
      forgetRecentsUnder(filePath);
      return removed.wasMissing
        ? `Removed “${reprint.label}” from “${reprint.project.title}” — the file was already gone.`
        : `Deleted “${reprint.label}” from “${reprint.project.title}”.`;
    }

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
  /**
   * THE STEP FOR A METADATA EDIT — written after the document, and never instead
   * of it.
   *
   * ── What this is the second half of ─────────────────────────────────────────
   *
   * The write above is what the user SEES: the package or the Info dictionary
   * changes and the pane in front of them says the new title at once. This is what
   * SURVIVES it. An export is cast fresh from the bank and a working tree's package
   * is not one of its inputs, so before this existed the correction was silently
   * absent from every book the app filed afterwards (docs/WORKBENCH.md §9). The
   * payload here is what materialisation replays.
   *
   * ── The file before the step, which is the rule and not a preference ───────
   *
   * A step is a pointer at a retained payload, so a step recorded before its
   * payload exists is a row somebody can click, render from, and be shown a
   * refusal by. The uuid makes the write collision-free by construction — two Applies a
   * millisecond apart cannot land on one name — so there is no file here to
   * overwrite and nothing to serialise against.
   *
   * ── A LANDING THAT FAILS IS A CONSOLE LINE, NOT A FAILED WRITE ─────────────
   *
   * By the time this runs the document has been edited: the values are in the
   * book, visibly, and reporting failure would tell somebody their correction did
   * not happen while leaving it done. What is actually lost is the RECORD of it,
   * which is worth a named line in the terminal and is not worth turning a
   * successful edit into a refusal.
   *
   * ── Absent for two ordinary states, and neither is an error ────────────────
   *
   * A patch with no changed fields in it is a read wearing a Save button, and a
   * document outside every project — a file the user opened off their own disk —
   * has no ledger for a row to go in. Both answer undefined, and the dialog knows
   * that means there is nothing to adopt.
   */
  const landMetadata = async (
    inside: string,
    kind: MetadataPatch['kind'],
    patch: Record<string, string | undefined>,
  ): Promise<{ ledger: ProjectLedger; rows: StepRow[] } | undefined> => {
    const fields: Record<string, string> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      fields[field] = value;
    }
    const named = Object.keys(fields);
    if (named.length === 0) return undefined;
    const dir = projectDirOf(inside);
    if (dir === null) return undefined;
    try {
      const name = `${randomUUID()}.json`;
      await fsp.mkdir(metadataDir(dir), { recursive: true });
      const body: MetadataPatch = { kind, fields };
      await fsp.writeFile(path.join(metadataDir(dir), name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      // PROJECT-RELATIVE WITH FORWARD SLASHES, as every payload is: the ledger's
      // spelling of a path is not this platform's, and a payload that carried a
      // backslash would be a row no other machine could resolve.
      return await recordMetadata(dir, `metadata/${name}`, { fields: named });
    } catch (err) {
      console.error(
        `[meta] the ${kind} record was written, but the step for it could not be: `
        + `${err instanceof Error ? err.message : String(err)}. The document carries the values; `
        + 'the history does not, so anything made from here will not carry them.',
      );
      return undefined;
    }
  };

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
    async (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> => {
      // Resolved once and used for both halves: the write goes to the working
      // copy, and the step is filed against the project that copy is in. Asking
      // `writablePdf` twice would be two answers about one document, and the
      // refusals it makes are the ones that decide whether there is anything to
      // record at all.
      const working = writablePdf(filePath);
      const outcome = await writePdfMetadata(working, patch);
      if (!outcome.ok) return outcome;
      const landed = await landMetadata(working, 'pdf', patch);
      return landed === undefined ? outcome : { ...outcome, landed };
    },
  );

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
   * parent at enqueue (`Job.parentStep`) and every path it will read or write at
   * PLAN time (`planRendering`), precisely so that clicking through the history
   * while a run waits cannot retarget it. Moving the pointer is a repaint, it is free, and
   * people do it while they wait — refusing it during a three-hour reading would
   * take the history panel away for the whole time it is most wanted, to prevent
   * nothing.
   *
   * `book:apply` writes `ops/<uuid>.jsonl`, a path no job can be about to
   * write, and appends a step of its own. It is the one action in this app that
   * retains IRREPLACEABLE work — somebody's judgements about four hundred blocks —
   * and refusing to let a person land those because a machine is busy would be
   * this app declining to keep the only thing in a project it cannot make again.
   * The interesting case is an Apply made while a re-read is running, and the
   * ledger already has the right answer for it: the payload is retained, and when
   * the reading lands and replaces its parent, `markStale` dims the step rather
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
    /*
     * A NULL IS AN ORDINARY ANSWER AND NOTHING IS FIRED AT IT ANY MORE. There
     * used to be a `towardTheFlowingBook` here: when a position resolved to the
     * scan, or to nothing, this handler asked the queue to cast the project's
     * flowing book so the pane would have an EPUB to unpack. The pane reads the
     * book file now — a read, a save and a translation all open the proof sheet
     * — so a position that names no separate document names none, and the panes
     * correctly keep what they have (docs/RENDERER.md §7).
     */
    return resolved;
  });
  /*
   * THE QUEUE'S HALF OF THE CORRECTION DOOR.
   *
   * A translation appends to its records file for hours and a correction swaps
   * that whole file into place, so the door is shut while a run is producing it.
   * The queue knows and projects.ts must not import it; main, which composes the
   * door, hands the check in (`recordCorrection`, electron/projects.ts).
   *
   * IT USED TO BE HANDED TO TWO DOORS. The other one started from a cast EPUB's
   * path — a word edited in the iframe reader — and both it and the reader are
   * deleted (docs/RENDERER.md §7). There is one door onto a translation's words
   * now, and it is the pane's.
   */
  const recordsBusy = (recordsFile: string): string | null => (
    queue.producing(recordsFile)
      ? 'A translation is writing this book\'s records right now, so the correction was not '
        + 'recorded — the edit is on screen and in this copy of the book. Let the run finish '
        + '(or cancel it) and make the edit again.'
      : null
  );
  /*
   * THE BOOK ITSELF — the rows the renderer draws, off the file the reflow made.
   *
   * ONE CALL AND NO PATH CROSSES IT IN EITHER DIRECTION, which is the difference
   * from `document-at` one door up and is worth saying plainly. That handler
   * ANSWERS with a path a viewer then opens, so it admits it to the allow-list;
   * this one answers with the BOOK — blocks, chapters, measured type — and the
   * renderer never learns where any of it lives. There is nothing for it to open,
   * so there is nothing to admit.
   *
   * IT MAY SPAWN THE ENGINE, and that is the whole of what makes opening a read
   * position work on a library written before this format existed
   * (electron/book.ts says why the ensure and the migration are one path). It is
   * awaited rather than fired and forgotten: the caller is a pane with
   * `Opening the book…` on it and nothing else to show, so
   * a promise that resolved before the file existed would be a blank sheet with
   * no sentence on it.
   *
   * IT ANSWERS A FAILURE RATHER THAN REJECTING ONE, and the sentence it carries
   * is composed to be READ — it lands on the paper (RENDERER-DESIGN.md §5). The
   * paths that make a refusal actionable go to the terminal instead, which is the
   * house rule for every sentence in this app. The one thing that still rejects
   * is a directory that is not one of Home's projects: that is the gate refusing,
   * not the book being unavailable.
   */
  ipcMain.handle('book:load', (_event, projectDir: string) => loadBook(projectDir));
  /*
   * AND THE OTHER DIRECTION — the pane's stack, landed as a step.
   *
   * IT REJECTS WHERE `book:load` ANSWERS, which is the difference worth stating
   * at the door rather than only in the module. A load with nothing to show has an
   * empty sheet to put a sentence on; an Apply that fails has the person's changes
   * still in front of them, and the honest thing is a refusal they can act on
   * rather than a stack silently cleared. `applyBookOps` writes the file before
   * the step and takes the file back if the step will not land, so there is no
   * half-applied state for this handler to describe.
   */
  ipcMain.handle('book:amend', (_event, projectDir: string, ops: BookOp[]) =>
    amendBookOps(projectDir, ops));
  // A finished export, exploded and shown read-only — never a rejection a pane
  // cannot draw: every refusal is a sentence in the outcome.
  ipcMain.handle('book:view', (_event, target: string) => viewExportedBook(target));
  ipcMain.handle('book:apply', (_event, projectDir: string, ops: BookOp[]) =>
    applyBookOps(projectDir, ops));
  /*
   * AND THE THIRD DOOR ONTO THIS BOOK — a corrected paragraph on a TRANSLATED
   * position, which is not an op and must never become one.
   *
   * *"Translated edits are per-language record corrections."* (docs/RENDERER.md
   * §5.) `book:apply` records decisions about STRUCTURE — strike, category,
   * merge, split, chapter — and every one of those is as true of a translation as
   * of the book it came from, so they ride the ops chain unchanged. The WORDS are
   * the exception: they belong to the records file, which is the step's payload
   * and the truth the derived book is a pure function of, and a `text` op over one
   * would leave the same paragraph saying two things.
   *
   * IT REJECTS, like `book:apply` and for its reason, and it ANSWERS WITH THE
   * WHOLE BOOK — the correction is not visible until the derived book has been
   * made again, and making the pane ask a second time for a state this call
   * already produced would be two questions about one gesture.
   */
  ipcMain.handle('book:correct', (_event, projectDir: string, id: string, text: string) =>
    correctBookBlock(projectDir, id, text, recordsBusy));
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
    // The RECORDS file, which is what a translation writes now: the position is
    // resolved from the project that file belongs to, exactly as it used to be
    // resolved from the project the output EPUB belonged to.
    return queue.enqueueTranslate(request, await parentStepFor(request.recordsPath));
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
   * The startup migrations that used to run here — regrouping the pre-project
   * flat workspace into projects, promoting stranded reprints — are gone, on
   * the ruling that nothing is kept for legacy's sake (2026-08-16): every
   * machine that held the old layouts has been regrouped or deliberately
   * wiped, and a scan of two directories on every launch forever is a tax
   * paid to a past no install has.
   */
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
  if (quitting || !vllm.ownsServer()) return;
  event.preventDefault();
  quitting = true;
  void vllm.stopServer('the app is quitting').finally(() => app.quit());
});
