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

  workspace: {
    plan: (inputPath, kind) => ipcRenderer.invoke('workspace:plan', inputPath, kind),
  },

  epub: {
    open: (filePath) => ipcRenderer.invoke('epub:open', filePath),
    close: (id) => ipcRenderer.invoke('epub:close', id),
    readMember: (id, href) => ipcRenderer.invoke('epub:read-member', id, href),
    writeMember: (id, href, text) => ipcRenderer.invoke('epub:write-member', id, href, text),
    renameHeading: (id, href, label) => ipcRenderer.invoke('epub:rename-heading', id, href, label),
    chooseSavePath: (id, suggestedName) => ipcRenderer.invoke('epub:choose-save-path', id, suggestedName),
    save: (id, destination) => ipcRenderer.invoke('epub:save', id, destination),
  },

  library: {
    dir: () => ipcRenderer.invoke('library:dir'),
    choose: (current) => ipcRenderer.invoke('library:choose', current),
    set: (dir) => ipcRenderer.invoke('library:set', dir),
  },

  recents: {
    list: () => ipcRenderer.invoke('recents:list'),
    forget: (filePath) => ipcRenderer.invoke('recents:forget', filePath),
    clear: () => ipcRenderer.invoke('recents:clear'),
  },

  queue: {
    list: () => ipcRenderer.invoke('queue:list'),
    enqueue: (request) => ipcRenderer.invoke('queue:enqueue', request),
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
  onNavigate: (listener) => subscribe<string>('navigate', listener),
  onMenuAction: (listener) => subscribe<MenuAction>('menu:action', listener),
};

contextBridge.exposeInMainWorld('foundry', api);
