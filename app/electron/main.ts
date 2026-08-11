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

import { engineInfo, runDoctor } from './engine';
import * as queue from './job-queue';
import { readSettings, writeSettings } from './settings';
import type { BackendSettingsPatch, JobRequest } from '../shared/types';

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
 * ALLOW-LISTED, not path-checked. Only a file the user opened through the menu,
 * a drop, or the file dialog is servable — a renderer that was talked into
 * asking for `C:\Users\…\id_rsa` gets a 403 rather than a cleverer path check
 * that has to be right forever.
 */
const openable = new Set<string>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'foundry-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerFileProtocol(): void {
  protocol.handle('foundry-file', async (request) => {
    let target: string | null = null;
    try {
      target = new URL(request.url).searchParams.get('p');
    } catch {
      target = null;
    }
    if (!target) return new Response('No file was named.', { status: 400 });

    const resolved = path.resolve(target);
    if (!openable.has(resolved)) {
      return new Response('That file was never opened in this app.', { status: 403 });
    }

    try {
      const stat = await fsp.stat(resolved);
      // Streamed rather than buffered: a scanned book is hundreds of megabytes
      // and the whole point of handing it to Chromium's viewer is not holding it.
      const body = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
      return new Response(body, {
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(stat.size),
          'content-disposition': `inline; filename="${path.basename(resolved)}"`,
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

/**
 * Admit a path and tell every window about it. The single door: the menu, the
 * dialog and a drop all come through here, so the allow-list and the viewer can
 * never disagree about which file is open.
 */
async function openDocument(candidate: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  if (path.extname(resolved).toLowerCase() !== '.pdf') return null;
  try {
    await fsp.access(resolved);
  } catch {
    return null;
  }
  openable.add(resolved);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('document:opened', resolved);
  }
  return resolved;
}

/**
 * A PDF named on the command line — `foundry-app book.pdf`, and what Windows
 * hands the app when a .pdf is opened with it. Options are skipped, so
 * `electron . --dev book.pdf` finds the book and not the flag.
 */
function pdfFromArgv(argv: readonly string[]): string | null {
  return argv.slice(1).find(
    (arg) => !arg.startsWith('-') && arg.toLowerCase().endsWith('.pdf'),
  ) ?? null;
}

async function promptForPdf(): Promise<string | null> {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  const result = win
    ? await dialog.showOpenDialog(win, {
      title: 'Open a PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    : await dialog.showOpenDialog({
      title: 'Open a PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
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
    const named = pdfFromArgv(process.argv);
    if (named) void openDocument(named);
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

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void promptForPdf(); },
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
  ipcMain.handle('dialog:open-pdf', () => promptForPdf());

  // A drop hands the renderer a path (webUtils, in the preload); main decides
  // whether it is openable. The renderer never gets to assert that a file is.
  ipcMain.handle('document:open-path', (_event, candidate: string) => openDocument(candidate));

  ipcMain.handle('dialog:choose-output', async (_event, defaultPath: string) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Where should the EPUB go?',
      defaultPath,
      filters: [{ name: 'EPUB', extensions: ['epub'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    return result.canceled ? null : (result.filePath ?? null);
  });

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

  queue.onQueueChanged((jobs) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('queue:changed', jobs);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// TODO(components): BookForge downloads and manages its own binaries
// (electron/components/: a catalog, a downloader, an update check, and the
// bottom-right shelf they report into). Nothing in v1 is downloaded — the
// engine is a dev checkout or a binary beside the app — so a component manager
// would slot in HERE, between `whenReady` and `createWindow`, and would report
// into the same queue shelf the conversions use.

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

// Quit aborts the run. A conversion that outlived its window would hold a GPU
// with nothing left to report to.
app.on('before-quit', () => queue.shutdown());
