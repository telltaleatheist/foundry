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
import { injectReporter, REPORTER_ID, REPORTER_MEMBER, REPORTER_SOURCE, sanitizeChapter } from './click-reporter';
import {
  engineInfo,
  readEpubMetadata,
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
  adoptLegacyLayout,
  deleteProject,
  finalDir,
  importDocument,
  inspectProject,
  isManaged,
  listProjects,
  projectsDir,
  recordFinal,
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
import { planConversion, planTranslation } from './workspace';
import { detectEnvTooling, listDistros } from './wsl';
import type { MenuAction } from '../shared/api';
import type {
  BackendSettingsPatch,
  CloseWarning,
  ConversionKind,
  EchoAnswer,
  EchoStanding,
  EnvInstallRequest,
  HeadingEcho,
  JobRequest,
  LedgerStacks,
  NavEcho,
  RecentKind,
  SetupRequest,
  TranslateRequest,
  UnlinkedNote,
  UnlinkedNoteAnswer,
  UnlinkedNoteStanding,
} from '../shared/types';

const isDev = process.argv.includes('--dev');
const DEV_SERVER = 'http://localhost:4260';

let mainWindow: BrowserWindow | null = null;

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
  void importDocument(resolved, kind).then((imported) => {
    // A stamping refusal is a NOTICE, not a failure, and this call is the
    // background one — the tab's own `epub:open` import carries the same
    // sentence to the notice strip, where somebody will read it.
    if (imported.notice !== null) console.warn(`[projects] ${imported.notice}`);
  }).catch((err: Error) => {
    console.error(`[projects] ${resolved} could not be imported into a project: ${err.message}`);
  });
  return resolved;
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

function createWindow(): void {
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
          // Save writes the book to the file the user already chose, and falls
          // back to the picker when there is not one yet — the behaviour every
          // editor has, and the reason the chapter editor can have a Save button
          // that does not ask a question every time.
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('save-as'),
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
   * The warning before a tab with something to lose closes.
   *
   * Worded around what is ACTUALLY at risk, which is never the book itself:
   * every edit lands in the project's own working copy as it is made
   * (electron/epub-reader.ts) and closing a tab deletes nothing at all, so this
   * loses track of a book and never loses one. Telling a user their work is
   * about to be destroyed when it is not would teach them to distrust the next
   * warning that matters.
   */
  ipcMain.handle('document:confirm-close', async (_event, warning: CloseWarning) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const shared =
      'Every edit went straight into Foundry\'s working copy of the book as you made it, '
      + `so nothing is lost — the project is in ${projectsDir()} and Home will still list it.`;
    const options = {
      type: 'question' as const,
      buttons: ['Close tab', 'Keep it open'],
      defaultId: 1,
      cancelId: 1,
      title: warning.unsaved ? 'Close without saving it anywhere?' : 'Close with edits unsaved?',
      message: warning.unsaved
        ? `“${warning.title}” has not been saved anywhere you chose.`
        : `“${warning.title}” has been edited since you saved it.`,
      detail: warning.unsaved
        ? `${shared} It is not in a folder of yours, though, and nothing else on this machine `
          + 'knows about it. Save (Ctrl+S) to put it somewhere you will find it.'
        : `${shared} The copy you saved at ${warning.savedPath ?? 'your chosen location'} is the `
          + 'older version. Save (Ctrl+S) to bring it up to date.',
    };
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result.response === 0;
  });

  /**
   * "You deleted this footnote's last reference. Should the footnote go too?"
   *
   * MAIN'S NATIVE BOX, like `confirmClose` above and like every other dialog in
   * this app: the question is modal to the WINDOW — the edit has landed and the
   * next gesture must not race it — and an in-app modal over a sandboxed iframe
   * is a rectangle the frame can scroll out from under.
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
   * THE ORDER IS EDIT-THEN-ASK. The edit is already on disk when this box goes
   * up, because an edit landing the instant it is typed is the whole feel of
   * select mode and a dialog that interrupted the typing to ask permission would
   * take that away. Cancel undoes; it does not pre-empt.
   *
   * THE CHECKBOX IS REMEMBERED PER ANSWER (app-settings.ts): "always strike it"
   * and "always leave it" are different standing instructions, and a single
   * "stop asking" flag would leave main choosing which one the user meant. A
   * checked box on CANCEL is ignored — a standing instruction to always undo
   * would make deleting a reference number impossible, with no dialog left to
   * explain why every attempt reverts itself.
   */
  ipcMain.handle('document:confirm-unlinked-note', async (_event, note: UnlinkedNote) => {
    const standing = readAppSettings().unlinkedNoteAnswer;
    if (standing !== 'ask') return standing;
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const printed = note.printed.trim();
    const named = printed.length > 0 ? `Footnote ${printed}` : `The footnote “${note.noteId}”`;
    const options = {
      type: 'question' as const,
      buttons: ['Strike the footnote too', 'Leave the footnote', 'Put the number back'],
      defaultId: 1,
      cancelId: 2,
      checkboxLabel: "Don't ask again — do this every time",
      checkboxChecked: false,
      title: 'That was the last reference to a footnote',
      message: `${named} is no longer reachable from the text.`,
      detail: (note.opening.length > 0 ? `It reads: “${note.opening}”\n\n` : '')
        + 'Striking it marks it the way Delete marks any block — it stays in the working copy, '
        + 'drawn struck through, and only leaves the book when the final edition is built, so '
        + 'pressing Delete on it brings it back. Leaving it keeps the note in the book with '
        + 'nothing pointing at it. Putting the number back undoes the edit you just made.',
    };
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    const answer: UnlinkedNoteAnswer =
      result.response === 0 ? 'cut' : result.response === 1 ? 'keep' : 'cancel';
    if (result.checkboxChecked && answer !== 'cancel') {
      writeAppSettings({ unlinkedNoteAnswer: answer });
    }
    return answer;
  });

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
   * Both follow the unlinked-footnote box exactly (`70cdc69`): a native
   * message box modal to the window, answered from `app-settings.json` without
   * asking when a standing answer is stored, remembered PER ANSWER so that
   * "always update the other" and "never update the other" stay two different
   * instructions, and un-set in Settings' Curation card — because a
   * don't-ask-again checkbox with no way back is a trap.
   *
   * ASKED AFTER THE WRITE, both of them, on select mode's rule: what the user
   * typed lands the instant they stop typing, and the question is about the
   * OTHER side, which nothing has touched.
   */
  ipcMain.handle('document:confirm-heading-echo', async (_event, echo: HeadingEcho) => {
    const standing = readAppSettings().contentsRenameEcho;
    if (standing !== 'ask') return standing;
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'question' as const,
      buttons: ['Change the heading too', 'Leave the page as it is'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "Don't ask again — do this every time",
      checkboxChecked: false,
      title: 'The page still says the old name',
      message: `The heading on the page reads “${echo.was}”.`,
      detail: `The contents entry now reads “${echo.now}”. They are allowed to differ — the page `
        + 'should say what the book says, and the contents should say what the book\'s apparatus '
        + 'says — so nothing on the page has been changed. Changing it rewrites the heading (and '
        + 'the document title) to match; leaving it keeps the words the page printed.',
    };
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    const answer: EchoAnswer = result.response === 0 ? 'update' : 'leave';
    if (result.checkboxChecked) writeAppSettings({ contentsRenameEcho: answer });
    return answer;
  });

  ipcMain.handle('document:confirm-nav-echo', async (_event, echo: NavEcho) => {
    const standing = readAppSettings().headingEditEcho;
    if (standing !== 'ask') return standing;
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'question' as const,
      buttons: ['Change the contents entry too', 'Leave the contents as it is'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "Don't ask again — do this every time",
      checkboxChecked: false,
      title: 'The contents still says the old name',
      message: `The contents entry reads “${echo.was}”.`,
      detail: `The heading on the page now reads “${echo.now}”. Nothing in the contents has been `
        + 'changed — the two are allowed to differ. Changing it relabels the entry to match; '
        + 'leaving it keeps the name the table of contents gives this chapter.',
    };
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    const answer: EchoAnswer = result.response === 0 ? 'update' : 'leave';
    if (result.checkboxChecked) writeAppSettings({ headingEditEcho: answer });
    return answer;
  });

  // ── Projects ─────────────────────────────────────────────────────────────
  ipcMain.handle(
    'workspace:plan',
    (_event, inputPath: string, kind: ConversionKind) => planConversion(inputPath, kind),
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
    return { ...plan, inputPath: readable };
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
  ipcMain.handle('projects:delete', async (_event, dir: string) => {
    const project = await inspectProject(dir);

    const open = openBookIn(project.dir);
    if (open !== null) {
      throw new Error(
        `${open} is open in Foundry right now, so “${project.title}” cannot be deleted — erasing `
        + 'the working copy out from under a book that is being read would leave that tab showing '
        + 'files that no longer exist, and would leave half a project on disk. Close the book '
        + 'first, then delete it.',
      );
    }

    /*
     * A JOB WRITING INTO IT IS THE SAME HAZARD AS AN OPEN BOOK, and worse in
     * one way: the engine is a separate process holding a file open in
     * `generated/`, so the recursive remove fails PART WAY on Windows and
     * leaves a project half erased — while the run carries on writing into a
     * directory the catalogue no longer describes.
     *
     * Every state but `running` and `queued` is finished with the folder: a
     * done, failed or cancelled row names a path nothing is holding.
     */
    const busy = queue.listJobs().find((job) =>
      (job.state === 'running' || job.state === 'queued')
      && within(project.dir, job.outputPath));
    if (busy !== undefined) {
      throw new Error(
        `A ${busy.kind} job is ${busy.state === 'running' ? 'running' : 'waiting to run'} into `
        + `“${project.title}” right now, so it cannot be deleted — the engine is writing into that `
        + 'folder from another process, and erasing it underneath would leave half a project on '
        + 'disk and a run writing into nothing. Cancel it in the shelf first, then delete.',
      );
    }

    const bank = project.readings > 0
      ? `It holds a readings bank of ${project.readings.toLocaleString()} pages the model has `
        + 'already read. That is hours of GPU, it is the one thing in here that cannot be made '
        + 'again from anything else on this disk, and once it is gone a future conversion of this '
        + 'book pays for every page from scratch.'
      : 'There is no readings bank in it, so nothing in here costs GPU-hours to make again.';
    const filed = project.filed
      ? ' The copy you filed into this project\'s own folder is inside it and goes with it.'
      : '';
    const made = project.documents === 0
      ? 'nothing has been made from it yet'
      : project.documents === 1
        ? 'the one document Foundry has made from it'
        : `the ${project.documents} documents Foundry has made from it`;

    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'warning' as const,
      buttons: ['Delete this project', 'Keep it'],
      // Cancel is the default and the destructive answer is not — this is the
      // one dialog in the app where a reflexive Enter would destroy something.
      defaultId: 1,
      cancelId: 1,
      title: 'Delete this project?',
      message: `“${project.title}” will be deleted from this computer.`,
      detail: `${project.dir} and everything under it goes: the original you imported, ${made}, `
        + 'every working copy and every edit in them, and the undo history. '
        + `${sizeOnDisk(project.bytes)} in all.${filed}\n\n${bank}\n\n`
        + 'This is a real delete. The folder is removed from the disk — it is not moved aside, '
        + 'Foundry keeps no copy of it anywhere else, and there is nothing that will bring it back.',
    };
    const answer = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (answer.response !== 0) return null;

    await deleteProject(project.dir);
    // The recents list is keyed by file and a project is a folder of them, so
    // every row pointing inside goes with it. Otherwise the app would keep a
    // last-opened time for — and `listProjects` would keep dating a row by — a
    // book whose bytes it destroyed a moment ago.
    forgetRecentsUnder(project.dir);
    return `Deleted “${project.title}”. ${project.dir} and everything in it is gone from this computer.`;
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
  const saveGrants = new Map<string, Set<string>>();
  const grantKey = (destination: string): string => path.resolve(destination).toLowerCase();
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
   * A failure REJECTS across IPC rather than resolving quietly: a save that did
   * not happen must not clear the dot.
   */
  ipcMain.handle('epub:save', async (_event, id: string, destination: string) => {
    if (!saveGrants.get(id)?.has(grantKey(destination))) {
      throw new Error(
        'That is not a place this book was granted to save to — a destination has to come '
        + 'from the save dialog, or be the file the book was opened from.',
      );
    }
    await repackEpub(id, destination);
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
  ipcMain.handle(
    'meta:write-pdf',
    (_event, filePath: string, patch: Record<string, string | undefined>) =>
      writePdfMetadata(admittedPdf(filePath), patch),
  );

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

  ipcMain.handle('queue:list', () => queue.listJobs());
  ipcMain.handle('queue:enqueue', (_event, request: JobRequest) => queue.enqueue(request));
  ipcMain.handle('queue:enqueue-translate', (_event, request: TranslateRequest) => {
    // The input again, because a request can arrive with any `inputPath` at all
    // — `workspace:plan-translation` checked the one it was given, not the one
    // that ends up here.
    if (admitted(request.inputPath) === null) {
      throw new Error(`${request.inputPath} was never opened in this app.`);
    }
    return queue.enqueueTranslate(request);
  });
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
