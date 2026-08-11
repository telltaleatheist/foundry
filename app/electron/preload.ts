/**
 * preload — the whole surface the renderer is allowed to touch.
 *
 * `window.foundry`, and nothing else. The renderer has no Node, no `require`,
 * no filesystem: it names a path and main decides whether that path is a thing
 * this app will open. The interface itself lives in shared/api.ts so the
 * renderer is typed against the same declaration this implements.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { FoundryApi } from '../shared/api';
import type { Job, ServerStatus, SetupLogEvent } from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

const api: FoundryApi = {
  platform: process.platform,

  openPdfDialog: () => ipcRenderer.invoke('dialog:open-pdf'),
  openPath: (candidate) => ipcRenderer.invoke('document:open-path', candidate),
  pathForFile: (file) => webUtils.getPathForFile(file),
  documentUrl: (absolutePath) => `foundry-file://open/?p=${encodeURIComponent(absolutePath)}`,
  chooseOutputPath: (defaultPath) => ipcRenderer.invoke('dialog:choose-output', defaultPath),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),

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
  },

  onDocumentOpened: (listener) => subscribe<string>('document:opened', listener),
  onNavigate: (listener) => subscribe<string>('navigate', listener),
};

contextBridge.exposeInMainWorld('foundry', api);
