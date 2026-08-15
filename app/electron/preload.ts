/**
 * preload — the whole surface the renderer is allowed to touch.
 *
 * `window.foundry`, and nothing else. The renderer has no Node, no `require`,
 * no filesystem: it names a path and main decides whether that path is a thing
 * this app will open. The interface itself lives in shared/api.ts so the
 * renderer is typed against the same declaration this implements.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { FoundryApi, MenuAction } from '../shared/api';
import type { EnvInstallProgress, Job, ServerStatus, SetupLogEvent } from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

const api: FoundryApi = {
  platform: process.platform,

  openDocumentDialog: () => ipcRenderer.invoke('dialog:open-document'),
  openPath: (candidate) => ipcRenderer.invoke('document:open-path', candidate),
  pathForFile: (file) => webUtils.getPathForFile(file),
  documentBytes: (absolutePath) => ipcRenderer.invoke('document:read-bytes', absolutePath),
  documentSaveCopy: (absolutePath, suggestedName) =>
    ipcRenderer.invoke('document:save-copy', absolutePath, suggestedName),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  confirmClose: (warning) => ipcRenderer.invoke('document:confirm-close', warning),
  confirmUnlinkedNote: (note) => ipcRenderer.invoke('document:confirm-unlinked-note', note),
  confirmHeadingEcho: (echo) => ipcRenderer.invoke('document:confirm-heading-echo', echo),
  confirmNavEcho: (echo) => ipcRenderer.invoke('document:confirm-nav-echo', echo),

  meta: {
    readEpub: (bookId) => ipcRenderer.invoke('meta:read-epub', bookId),
    writeEpub: (bookId, patch) => ipcRenderer.invoke('meta:write-epub', bookId, patch),
    readPdf: (filePath) => ipcRenderer.invoke('meta:read-pdf', filePath),
    writePdf: (filePath, patch) => ipcRenderer.invoke('meta:write-pdf', filePath, patch),
  },

  workspace: {
    planReading: (inputPath) => ipcRenderer.invoke('workspace:plan-reading', inputPath),
    plan: (inputPath, kind) => ipcRenderer.invoke('workspace:plan', inputPath, kind),
    planTranslation: (inputPath, targetLanguage) =>
      ipcRenderer.invoke('workspace:plan-translation', inputPath, targetLanguage),
  },

  epub: {
    open: (filePath) => ipcRenderer.invoke('epub:open', filePath),
    close: (id) => ipcRenderer.invoke('epub:close', id),
    readMember: (id, href) => ipcRenderer.invoke('epub:read-member', id, href),
    writeMember: (id, href, text) => ipcRenderer.invoke('epub:write-member', id, href, text),
    renameHeading: (id, href, label) => ipcRenderer.invoke('epub:rename-heading', id, href, label),
    renamePageHeading: (id, href, label, was) =>
      ipcRenderer.invoke('epub:rename-page-heading', id, href, label, was),
    navEchoForBlock: (id, href, blockId, was) =>
      ipcRenderer.invoke('epub:nav-echo-for-block', id, href, blockId, was),
    setCuts: (id, href, blockIds, cut) =>
      ipcRenderer.invoke('epub:set-cuts', id, href, blockIds, cut),
    setNoteCut: (id, href, noteId, cut) =>
      ipcRenderer.invoke('epub:set-note-cut', id, href, noteId, cut),
    setCategories: (id, href, blockIds, category) =>
      ipcRenderer.invoke('epub:set-categories', id, href, blockIds, category),
    setBlockHtml: (id, href, blockId, html) =>
      ipcRenderer.invoke('epub:set-block-html', id, href, blockId, html),
    restoreBlockHtml: (id, href, blockId, html) =>
      ipcRenderer.invoke('epub:restore-block-html', id, href, blockId, html),
    stamp: (id, members) => ipcRenderer.invoke('epub:stamp', id, members),
    chooseSavePath: (id, suggestedName) => ipcRenderer.invoke('epub:choose-save-path', id, suggestedName),
    save: (id, destination) => ipcRenderer.invoke('epub:save', id, destination),
  },

  history: {
    load: (bookId) => ipcRenderer.invoke('history:load', bookId),
    save: (bookId, stacks) => ipcRenderer.invoke('history:save', bookId, stacks),
  },

  overlay: {
    blocks: (pdfPath) => ipcRenderer.invoke('overlay:blocks', pdfPath),
    load: (pdfPath) => ipcRenderer.invoke('overlay:load', pdfPath),
    save: (pdfPath, file) => ipcRenderer.invoke('overlay:save', pdfPath, file),
    loadLedger: (pdfPath) => ipcRenderer.invoke('overlay:ledger-load', pdfPath),
    saveLedger: (pdfPath, stacks) => ipcRenderer.invoke('overlay:ledger-save', pdfPath, stacks),
    commit: (pdfPath) => ipcRenderer.invoke('overlay:commit', pdfPath),
  },

  ledger: {
    read: (projectDir) => ipcRenderer.invoke('ledger:read', projectDir),
    go: (projectDir, stepId) => ipcRenderer.invoke('ledger:go', projectDir, stepId),
    describeDelete: (projectDir, stepId) =>
      ipcRenderer.invoke('ledger:describe-delete', projectDir, stepId),
    delete: (projectDir, stepId) => ipcRenderer.invoke('ledger:delete', projectDir, stepId),
  },

  prefs: {
    unlinkedNoteAnswer: () => ipcRenderer.invoke('prefs:unlinked-note-answer'),
    setUnlinkedNoteAnswer: (answer) =>
      ipcRenderer.invoke('prefs:set-unlinked-note-answer', answer),
    contentsRenameEcho: () => ipcRenderer.invoke('prefs:contents-rename-echo'),
    setContentsRenameEcho: (answer) => ipcRenderer.invoke('prefs:set-contents-rename-echo', answer),
    headingEditEcho: () => ipcRenderer.invoke('prefs:heading-edit-echo'),
    setHeadingEditEcho: (answer) => ipcRenderer.invoke('prefs:set-heading-edit-echo', answer),
  },

  library: {
    dir: () => ipcRenderer.invoke('library:dir'),
    choose: (current) => ipcRenderer.invoke('library:choose', current),
    set: (dir) => ipcRenderer.invoke('library:set', dir),
  },

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    onChanged: (listener) => subscribe<null>('projects:changed', listener),
    describe: (dir) => ipcRenderer.invoke('projects:describe', dir),
    delete: (dir) => ipcRenderer.invoke('projects:delete', dir),
  },

  documents: {
    describe: (filePath) => ipcRenderer.invoke('documents:describe', filePath),
    delete: (filePath) => ipcRenderer.invoke('documents:delete', filePath),
  },

  recents: {
    list: () => ipcRenderer.invoke('recents:list'),
    forget: (filePath) => ipcRenderer.invoke('recents:forget', filePath),
    clear: () => ipcRenderer.invoke('recents:clear'),
  },

  queue: {
    list: () => ipcRenderer.invoke('queue:list'),
    enqueue: (request) => ipcRenderer.invoke('queue:enqueue', request),
    enqueueTranslate: (request) => ipcRenderer.invoke('queue:enqueue-translate', request),
    start: () => ipcRenderer.invoke('queue:start'),
    remove: (id) => ipcRenderer.invoke('queue:remove', id),
    cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
    clearFinished: () => ipcRenderer.invoke('queue:clear-finished'),
    onChanged: (listener) => subscribe<Job[]>('queue:changed', listener),
  },

  engineInfo: () => ipcRenderer.invoke('engine:info'),
  doctor: (endpointUrl) => ipcRenderer.invoke('doctor:run', endpointUrl),
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (patch) => ipcRenderer.invoke('settings:write', patch),
  },

  wsl: {
    facts: () => ipcRenderer.invoke('wsl:facts'),
    tooling: (distro) => ipcRenderer.invoke('wsl:tooling', distro),
  },

  env: {
    catalog: () => ipcRenderer.invoke('env:catalog'),
    install: (request) => ipcRenderer.invoke('env:install', request),
    cancel: () => ipcRenderer.invoke('env:cancel'),
    chooseDest: (defaultPath) => ipcRenderer.invoke('env:choose-dest', defaultPath),
    onInstallProgress: (listener) => subscribe<EnvInstallProgress>('env:install-progress', listener),
  },

  backendSetup: {
    run: (request) => ipcRenderer.invoke('backend:setup-run', request),
    cancel: () => ipcRenderer.invoke('backend:setup-cancel'),
    onLog: (listener) => subscribe<SetupLogEvent>('backend:setup-log', listener),
  },

  vllmServer: {
    status: () => ipcRenderer.invoke('vllm:status'),
    start: () => ipcRenderer.invoke('vllm:start'),
    stop: () => ipcRenderer.invoke('vllm:stop'),
    onStatus: (listener) => subscribe<ServerStatus>('vllm:status-changed', listener),
    keepWarm: () => ipcRenderer.invoke('vllm:keep-warm'),
    setKeepWarm: (minutes) => ipcRenderer.invoke('vllm:set-keep-warm', minutes),
  },

  onDocumentOpened: (listener) => subscribe<string>('document:opened', listener),
  onDocumentRelocated: (listener) =>
    subscribe<{ from: string; to: string }>('document:relocated', listener),
  onNavigate: (listener) => subscribe<string>('navigate', listener),
  onMenuAction: (listener) => subscribe<MenuAction>('menu:action', listener),
};

contextBridge.exposeInMainWorld('foundry', api);
