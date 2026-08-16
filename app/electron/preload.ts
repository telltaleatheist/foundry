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
import type {
  AppQuestion,
  Asked,
  CloseAnswer,
  EchoAnswer,
  EnvInstallProgress,
  Job,
  QuestionAnswer,
  ReReadAnswer,
  ServerStatus,
  SetupLogEvent,
  UnlinkedNoteAnswer,
} from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

/**
 * The card that draws this app's questions, once the renderer has one.
 *
 * NULL UNTIL THE APP STARTS, and null forever in a renderer that has no card to
 * register (`ng serve` in a plain browser reaches none of this, but a window
 * whose bootstrap threw is a real state). Every `ask` below carries its own safe
 * answer for that case: a question that was never drawn was never answered, and
 * a caller must not be told somebody agreed to something.
 */
let card: ((question: AppQuestion) => Promise<QuestionAnswer>) | null = null;

/**
 * ASK MAIN, DRAW THE CARD, ANSWER WITH THE CHOSEN WORD — the shape all five of
 * this app's questions share.
 *
 * Main composes (it owns the sentences) and may answer outright (a standing
 * "don't ask again", read before anything is composed, so no card is drawn and
 * nothing flickers). What comes back from the card is the pressed choice's own
 * key, which IS the caller's answer union — no index, no label lookup, and a
 * mismatch between main's composition and the caller's `switch` is a type error
 * rather than a silently wrong answer (see `AppQuestion`).
 *
 * The cast on the way out is the one unchecked step in the chain and it is
 * checked at the other end: main built these choices out of `Answer`'s own
 * members, and the card returns a key it was given.
 */
async function ask<Answer extends string>(
  channel: string,
  payload: unknown,
  /** What the answer is when there is nothing on screen to answer it. */
  unasked: Answer,
  /** Where a ticked "do this every time" goes, for the questions that offer it. */
  remember?: (answer: Answer) => Promise<unknown>,
): Promise<Answer> {
  const asked: Asked<Answer> = await ipcRenderer.invoke(channel, payload);
  if (asked.kind === 'answered') return asked.answer;
  if (card === null) return unasked;
  /*
   * A CARD THAT THREW IS A QUESTION NOBODY ANSWERED, and it resolves like one.
   * The alternative is a rejection travelling back into `questionBefore` or the
   * OCR dialog's Add — call sites written against a promise that always settles
   * — where it would come out as a close that did not happen, with nothing on
   * screen saying why.
   */
  const { key, standing } = await card(asked.question).catch(() => ({ key: asked.question.dismissed, standing: false }));
  const answer = key as Answer;
  /*
   * THE BOX IS ONLY STORED FOR AN ANSWER MAIN SAID IT MAY BE STORED FOR.
   * `remembers` is main's rule — "always put the number back" would make deleting
   * a reference number impossible, with no dialog left to explain why every
   * attempt undoes itself — and this is the one place that could break it.
   */
  if (standing && remember && (asked.question.checkbox?.remembers.includes(answer) ?? false)) {
    await remember(answer);
  }
  return answer;
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
  /*
   * ── The five questions, and the safe answer each of them keeps ─────────────
   *
   * Keep the tab open; put the footnote reference back; leave the reading alone;
   * leave the other side of the book as it is. Every one of them is the outcome
   * that destroys nothing and costs nothing, which is what an unanswered question
   * has to resolve to.
   */
  confirmClose: (warning) =>
    ask<CloseAnswer>('document:confirm-close', warning, 'keep'),
  confirmUnlinkedNote: (note) =>
    ask<UnlinkedNoteAnswer>(
      'document:confirm-unlinked-note',
      note,
      'cancel',
      (answer) => ipcRenderer.invoke('prefs:set-unlinked-note-answer', answer),
    ),
  confirmReRead: async (prompt) =>
    await ask<ReReadAnswer>('reading:confirm-re-read', prompt, 'leave') === 'again',
  confirmHeadingEcho: (echo) =>
    ask<EchoAnswer>(
      'document:confirm-heading-echo',
      echo,
      'leave',
      (answer) => ipcRenderer.invoke('prefs:set-contents-rename-echo', answer),
    ),
  confirmNavEcho: (echo) =>
    ask<EchoAnswer>(
      'document:confirm-nav-echo',
      echo,
      'leave',
      (answer) => ipcRenderer.invoke('prefs:set-heading-edit-echo', answer),
    ),
  /*
   * REGISTERED, NEVER CALLED FROM HERE. The renderer hands its card in as the app
   * starts and this holds the reference for the five calls above; see
   * `FoundryApi.drawQuestions` for why the drawing has to arrive from that side.
   */
  drawQuestions: (draw) => { card = draw; },

  meta: {
    readEpub: (bookId) => ipcRenderer.invoke('meta:read-epub', bookId),
    writeEpub: (bookId, patch) => ipcRenderer.invoke('meta:write-epub', bookId, patch),
    readPdf: (filePath) => ipcRenderer.invoke('meta:read-pdf', filePath),
    writePdf: (filePath, patch) => ipcRenderer.invoke('meta:write-pdf', filePath, patch),
  },

  workspace: {
    planReading: (inputPath, asked) =>
      ipcRenderer.invoke('workspace:plan-reading', inputPath, asked),
    plan: (inputPath, kind) => ipcRenderer.invoke('workspace:plan', inputPath, kind),
    planExport: (inputPath, kind) => ipcRenderer.invoke('workspace:plan-export', inputPath, kind),
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
    uncommitted: (pdfPath) => ipcRenderer.invoke('overlay:uncommitted', pdfPath),
  },

  ledger: {
    read: (projectDir) => ipcRenderer.invoke('ledger:read', projectDir),
    go: (projectDir, stepId) => ipcRenderer.invoke('ledger:go', projectDir, stepId),
    standFor: (projectDir, filePath) =>
      ipcRenderer.invoke('ledger:stand-for', projectDir, filePath),
    documentAt: (projectDir) => ipcRenderer.invoke('ledger:document-at', projectDir),
    describeDelete: (projectDir, stepId) =>
      ipcRenderer.invoke('ledger:describe-delete', projectDir, stepId),
    delete: (projectDir, stepId) => ipcRenderer.invoke('ledger:delete', projectDir, stepId),
  },

  book: {
    load: (projectDir) => ipcRenderer.invoke('book:load', projectDir),
    apply: (projectDir, ops) => ipcRenderer.invoke('book:apply', projectDir, ops),
  },

  translation: {
    ofDocument: (projectDir, filePath) =>
      ipcRenderer.invoke('translation:of-document', projectDir, filePath),
    recordEdit: (projectDir, filePath, parts, text) =>
      ipcRenderer.invoke('translation:record-edit', projectDir, filePath, parts, text),
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
  // The window is going and the documents in it have not been asked yet. The
  // payload is nothing — what is open is the renderer's own business, and this
  // says only that the question is now due.
  onWindowClosing: (listener) => subscribe<void>('window:closing', () => listener()),
  letWindowClose: (go) => ipcRenderer.invoke('window:let-go', go),
};

contextBridge.exposeInMainWorld('foundry', api);
