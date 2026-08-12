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
import { engineInfo, runDoctor } from './engine';
import { catalogForThisMachine, onEnvInstallProgress } from './env-install';
import { planProvisioning } from './env-provision';
import {
  closeAllEpubs,
  closeEpub,
  openEpub,
  readEpubMember,
  renameEpubHeading,
  repackEpub,
  resolveEpubMember,
  writeEpubMember,
} from './epub-reader';
import * as queue from './job-queue';
import { clearRecents, forgetRecent, listRecents, rememberRecent } from './recents';
import { readSettings, writeSettings } from './settings';
import * as vllm from './vllm-server';
import { isManaged, planConversion, workspaceDir } from './workspace';
import { detectEnvTooling, listDistros } from './wsl';
import type { MenuAction } from '../shared/api';
import type {
  BackendSettingsPatch,
  CloseWarning,
  ConversionKind,
  EnvInstallRequest,
  JobRequest,
  RecentKind,
  SetupRequest,
} from '../shared/types';

const isDev = process.argv.includes('--dev');
const DEV_SERVER = 'http://localhost:4260';

let mainWindow: BrowserWindow | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// foundry-file:// — how a PDF on disk reaches an <iframe>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The renderer is a page on http://localhost:4260 (dev) or file:// (packaged),
 * and neither may point an <iframe> at an arbitrary `file://` URL. So the app
 * serves the bytes itself, on a scheme of its own, and Chromium's built-in PDF
 * viewer takes it from the `application/pdf` content type.
 *
 * TWO HOSTS, because the two things served have different addressing needs:
 *
 *   `foundry-file://open/?p=<abs path>` — one whole file, named absolutely.
 *   That is a PDF, and Chromium's viewer only ever asks for the one URL it was
 *   given, so a query parameter is enough.
 *
 *   `foundry-file://epub/<book id>/<path inside the book>` — a chapter out of an
 *   unpacked EPUB. PATH-shaped and not query-shaped because an XHTML document
 *   resolves `style.css` and `img/plate-3.png` RELATIVELY: served from a query
 *   string, every one of those would resolve to a URL with no `?p=` at all and
 *   the book would render unstyled and pictureless.
 *
 * Both are ALLOW-LISTED, not path-checked. A PDF is servable only once the user
 * opened it through the menu, a drop or the dialog; a book's member is servable
 * only if it is in the set of files that unpack actually wrote (epub-reader.ts).
 * A renderer that was talked into asking for `C:\Users\…\id_rsa` gets a 403,
 * rather than a cleverer path check that has to stay right forever.
 */
const openable = new Set<string>();

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

    const target = url.searchParams.get('p');
    if (!target) return new Response('No file was named.', { status: 400 });

    const resolved = path.resolve(target);
    if (!openable.has(resolved)) {
      return new Response('That file was never opened in this app.', { status: 403 });
    }
    return serveFile(resolved, {});
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
  // the one function every open passes through. A book still in the workspace is
  // remembered too, and flagged, because a tab closed by accident has to be
  // findable again from Home.
  rememberRecent(resolved, kind, path.basename(resolved), isManaged(resolved));
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('document:opened', resolved);
  }
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
    backgroundColor: '#16181c',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER);
  } else {
    // dist/electron -> dist -> app; the renderer build lands in dist/renderer.
    const index = path.join(__dirname, '..', 'renderer', 'browser', 'index.html');
    mainWindow.loadFile(index).catch((err: Error) => {
      void mainWindow?.loadURL(
        'data:text/html,'
        + encodeURIComponent(
          `<body style="background:#16181c;color:#eee;font:14px system-ui;padding:40px">
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
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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

function registerIpc(): void {
  ipcMain.handle('dialog:open-document', () => promptForDocument());

  // A drop hands the renderer a path (webUtils, in the preload); main decides
  // whether it is openable. The renderer never gets to assert that a file is.
  ipcMain.handle('document:open-path', (_event, candidate: string) => openDocument(candidate));

  /**
   * The warning before a tab with something to lose closes.
   *
   * Worded around what is ACTUALLY at risk, which is never the book itself:
   * every edit is written through to the workspace copy the moment it is made
   * (electron/epub-reader.ts), so closing a tab loses track of a book and never
   * loses one. Telling a user their work is about to be destroyed when it is not
   * would teach them to distrust the next warning that matters.
   */
  ipcMain.handle('document:confirm-close', async (_event, warning: CloseWarning) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const shared =
      'Every edit was written straight into Foundry\'s workspace copy as you made it, '
      + `so nothing is lost — the book is in ${workspaceDir()} and Home will still list it.`;
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

  // ── The managed workspace ────────────────────────────────────────────────
  ipcMain.handle(
    'workspace:plan',
    (_event, inputPath: string, kind: ConversionKind) => planConversion(inputPath, kind),
  );

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
    const book = await openEpub(filePath);
    // A book from the user's own disk: that file IS a copy somewhere they
    // chose, so plain Save may update it. A managed book grants nothing —
    // its first save goes through the dialog below.
    if (!book.managed) grantSave(book.id, book.filePath);
    return book;
  });
  ipcMain.handle('epub:close', (_event, id: string) => {
    saveGrants.delete(id);
    return closeEpub(id);
  });
  ipcMain.handle('epub:read-member', (_event, id: string, href: string) =>
    readEpubMember(id, href));
  // Writes through to the workspace copy — see epub-reader.ts. The renderer
  // holds the text; main holds the file. No Node in the renderer, ever.
  ipcMain.handle('epub:write-member', (_event, id: string, href: string, text: string) =>
    writeEpubMember(id, href, text));
  // Renames a TOC entry — the nav label, and the heading when it carried the
  // same text. Same write-through as an edit; the user's own file is untouched.
  ipcMain.handle('epub:rename-heading', (_event, id: string, href: string, label: string) =>
    renameEpubHeading(id, href, label));

  ipcMain.handle('epub:choose-save-path', async (_event, id: string, suggestedName: string) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    // The LIBRARY, not Documents: the pickers open where the books live, which
    // is the folder the user pointed this app at.
    const library = readAppSettings().libraryDir;
    await fsp.mkdir(library, { recursive: true });
    const options = {
      title: 'Save this book',
      defaultPath: path.join(library, suggestedName),
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
   * Repack the working copy to where the user said.
   *
   * A REPACK and not a copy of the workspace file, because the two can differ
   * for one instant: an edit writes the member and then repacks, and a save that
   * raced that would write a book missing the last keystroke. Packing from the
   * unpacked directory is packing from the thing the editor actually wrote to.
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

  ipcMain.handle('queue:list', () => queue.listJobs());
  ipcMain.handle('queue:enqueue', (_event, request: JobRequest) => queue.enqueue(request));
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

void app.whenReady().then(() => {
  applyContentSecurityPolicy();
  registerFileProtocol();
  registerIpc();
  buildMenu();
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
  // Every book still unpacked in %TEMP%. Tabs delete their own on close; this is
  // for the tabs that were never closed, which is most of them — an app is
  // usually quit with its documents open.
  closeAllEpubs();
  if (quitting || !vllm.ownsServer()) return;
  event.preventDefault();
  quitting = true;
  void vllm.stopServer('the app is quitting').finally(() => app.quit());
});
