/**
 * ipc — every door the renderer may knock on, in one place.
 *
 * Split out of main.ts when the app learned to be hosted (docs/BOOKFORGE-HANDOFF.md
 * §8): registering these is what MOUNTING Foundry means, and it is the same
 * registration whether this process belongs to Foundry or to BookForge. What
 * stayed behind in main.ts is only what a standalone shell owns — the menu, the
 * command line, the process's own lifecycle.
 *
 * EVERY CHANNEL IS NAMESPACED `family:verb`, and that is not a style rule: hosted,
 * these handlers are registered into a main process that has doors of its own, so
 * a bare name is a collision waiting for a version bump. docs/IPC-CHANNELS.md is
 * the enumeration, and it is the input to the audit the copy depends on.
 *
 * The renderer has no Node: it names a path and main decides whether that path is
 * a thing this app will open. `admitted` (electron/documents.ts) is where that is
 * decided, once, for every door that reads.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { startPairing, pollPairing } from '@crucible/client';
import { RemotePairingSessions } from '@owen/foundry-core/node/crucible-remote-pairing';

import { actGates } from '@owen/foundry-core/node/act-gates';
import {
  readAppSettings,
  writeAppSettings
} from '@owen/foundry-core/node/app-settings';
import { probeCloud } from '@owen/foundry-core/node/cloud-providers';
import { openCrucibleUi } from './crucible-ui';
import {
  coordinateServer,
  coordinationStates,
  onCoordination
} from '@owen/foundry-core/node/crucible-coordinate';
import {
  cloudSettingsView, crucibleServerNamed,
  crucibleSettingsView, engineClientFor,
  probeCrucible,
  slotAvailability,
  probeCrucibleAt
} from '@owen/foundry-core/node/crucible-registry';
import { readCapability } from '@owen/foundry-core/node/crucible-dispatch';
import { readEngineSettings, testUpstream } from '@owen/foundry-core/node/crucible-settings';
import { engineCatalog, jobModelOffer, pullSubject, rememberJobModel, removeModel } from '@owen/foundry-core/node/crucible-models';
import {
  cancelAsk, deleteAskConversation, readAskConversations, readAskSessions, renameAskConversation, saveAskSession, startAsk,
} from '@owen/foundry-core/node/ask-document';
import { cancelSuggest, startSuggest } from '@owen/foundry-core/node/suggest-categories';
import type { SuggestCategoriesRequest } from '@owen/foundry-core/shared/category-suggestions';
import type { AskRequest, AskSession } from '@owen/foundry-core/shared/ask';
import type { AskPresetsKept } from '@owen/foundry-core/shared/ask-presets';
import type { JobModelKind } from '@owen/foundry-core/shared/job-models';
import type {
  SettingsDocument,
  SettingsPatch,
  UpstreamName,
  UpstreamProbe,
} from '@owen/foundry-core/shared/engine-settings';
import { crucibleInstallPlan } from '@owen/foundry-core/node/crucible-install';
import { crucibleInstallDoor } from '@owen/foundry-core/node/crucible-install-door';
import {
  crucibleUninstallAvailability,
  crucibleUninstallDryRun
} from '@owen/foundry-core/node/crucible-uninstall';
import type {
  CrucibleUninstallFlags,
  CrucibleUninstallPlan,
  CrucibleUninstallRun,
} from '@owen/foundry-core/shared/uninstall-wire';
import { anyServerServing } from '@owen/foundry-core/node/crucible-provider';
import {
  type CloudProviderEdit,
  type ConnectCodePreview,
  type CrucibleProbe,
  type CrucibleServerEdit, type NewJobsWaitFor
} from '@owen/foundry-core/shared/slots';
import {
  ensureCapture,
  intakePhotos,
  mintAbort,
  mintBegin,
  mintCommit,
  mintPage,
  onIntakeProgress,
  openCapture,
  pdfStageBegin,
  pdfStagePage,
  pdfStageRelease,
  removePhotos,
  writeRecipe,
} from '@owen/foundry-core/node/capture';
import {
  amendBookOps,
  applyBookOps,
  clearPendingStack,
  correctBookBlock,
  loadBook,
  loadBookAt,
  readPendingStack,
  savePendingStack,
  viewExportedBook,
} from '@owen/foundry-core/node/book';
import { admitted, openDocument, promptForDocument } from './documents';
import {
  engineInfo,
  readEpubMetadata,
  stampMintMetadata,
  readPdfMetadata,
  runDoctor
} from '@owen/foundry-core/node/engine';
import { hosted, hostMintMeta } from '@owen/foundry-core/node/host';
import {
  actOnHostNode, hostNodesFor, hostOffers, hostOperationStates, hostOpensStatus, hostStatus, openHostStatus
} from '@owen/foundry-core/node/host-ops';
import type { HostNodeAction } from '@owen/foundry-core/shared/host-ops';
import * as queue from '@owen/foundry-core/node/job-queue';
import { setupState } from '@owen/foundry-core/node/setup';
import { probeSystem } from '@owen/foundry-core/node/system-probe';
import {
  createCaptureProject, exportInTray,
  goToStep, listProjects, onProjectsChanged, readAnalysisReport,
  readManifest,
  readStepLedger, recordMintMeta,
  standForDocument
} from '@owen/foundry-core/node/projects';
import {
  clearRecents,
  forgetRecent, listRecents
} from '@owen/foundry-core/node/recents';
import { readSettings } from '@owen/foundry-core/node/settings';
import { answerLetGo, broadcast, foundryWindow } from './window';
import { confirmClose, confirmReRead, confirmUnapplied, confirmRemoveModel } from '@owen/foundry-core/node/doors-questions';
import { deleteLedgerStep, describeProjectDelete, deleteProjectFolder, describeDocumentDelete, openExportDeleteDoor, deleteDocumentFile, describeLedgerStepDelete, openStepDeleteDoor } from '@owen/foundry-core/node/doors-delete';
import { invokeHostOperationAt, documentAtPositionAdmitted, documentAtStepAdmitted } from '@owen/foundry-core/node/doors-ledger';
import { planExportFrom, planTranslationFor, planSimplificationFor, hostPassOfferFor, planCleanupFor, planAnalysisFor } from '@owen/foundry-core/node/doors-plan';
import { namedServerOr, afterRegistryChanged, adoptPairingFile, registerApprovedPairing, saveCrucibleServers, addCrucibleServerDoor, addLocalCrucibleDoor, parseConnectCode, testConnectCode, addConnectCode, putEngineSettings, runInstallAndCoordinate, restartWindows, uninstallCrucible, offerCrucibleStart, startCrucibleAndConnect, saveCloudProviders, sweepAtStartup } from '@owen/foundry-core/node/doors-crucible';
import { readDocumentBytes, recordsBusy, refuseHostedLibraryMove, readAskPresets, saveAskPresets, writeSettingsOutsideHost, finishSetupFor } from '@owen/foundry-core/node/doors-library';
import { admittedPdf, writePdfMetadataFor, exportedBook, writeEpubMetadataFor } from '@owen/foundry-core/node/doors-meta';
import { enqueueJob, enqueueTextPassFor, enqueueTriagedCleanupFor, enqueueAnalysisFor, runJobNow } from '@owen/foundry-core/node/doors-queue';
import { planReading } from '@owen/foundry-core/node/workspace';
import {
  type CustomAnalysisCategory
} from '@owen/foundry-core/shared/analysis-categories';
import type { ReadAsk } from '@owen/foundry-core/shared/ledger';
import type { BookOp, PendingStack } from '@owen/foundry-core/shared/ops';
import type { ReReadPrompt } from '@owen/foundry-core/shared/reread';
import type {
  Asked,
  BackendSettingsPatch,
  CaptureRecipe,
  CloseAnswer,
  CloseWarning,
  ConversionKind, DocumentDeletion,
  JobRequest, MetadataWriteOutcome,
  MintMeta, ReReadAnswer,
  RewriteMode, TextPassRequest,
  AnalyzeRequest,
  CleanRequest,
  ModelClass,
  UnappliedAnswer,
  UnappliedWarning
} from '@owen/foundry-core/shared/types';

/*
 * THE FOUR NAMES THIS FILE USED TO DEFINE, re-exported so ipc.js offers what it
 * always did. The bodies moved to the doors-*.ts library files on 2026-11-04
 * (docs/FOUNDRY-CORE-PLAN.md step 2); what stayed here is the table of
 * registrations and the halves that need a window, a dialog or the shell.
 */
export { adoptPairingFile, connectLocalEngine } from '@owen/foundry-core/node/doors-crucible';
export { deleteExport, deleteLedgerStep } from '@owen/foundry-core/node/doors-delete';

export function registerIpc(): void {
  const pairingSessions = new RemotePairingSessions(registerApprovedPairing, startPairing, pollPairing);
  const pairingWindows = new Set<number>();
  ipcMain.handle('foundry:crucible-pair-start', async (event, address: string) => {
    if (hosted()) throw new Error('Manage server connections in the host application.');
    if (typeof address !== 'string' || !address.trim()) throw new Error('Enter the other computer’s address.');
    const owner = event.sender.id;
    if (!pairingWindows.has(owner)) {
      pairingWindows.add(owner);
      event.sender.once('destroyed', () => {
        pairingSessions.cancelOwner(owner);
        pairingWindows.delete(owner);
      });
    }
    return pairingSessions.begin(owner, address.trim());
  });
  ipcMain.handle('foundry:crucible-pair-poll', (event, id: string) => {
    if (hosted()) throw new Error('Manage server connections in the host application.');
    return pairingSessions.poll(event.sender.id, id);
  });
  ipcMain.handle('foundry:crucible-pair-cancel', (event) => pairingSessions.cancelOwner(event.sender.id));
  ipcMain.handle('foundry:crucible-pair-requests', async (_event, name: string) => {
    const entry = crucibleServerNamed(name);
    if (!entry) throw new Error('Choose a registered Crucible server.');
    const client = await engineClientFor(entry);
    return client.listPairingRequests();
  });
  ipcMain.handle('foundry:crucible-pair-decide', async (_event, name: string, id: string, code: string, allow: boolean) => {
    if (typeof allow !== 'boolean') throw new Error('Choose Approve or Deny.');
    const entry = crucibleServerNamed(name);
    if (!entry) throw new Error('Choose a registered Crucible server.');
    const client = await engineClientFor(entry);
    await client.decidePairing(id, code, allow);
  });
  /*
   * ── `foundry:crucible-wsl-upgrade` AND ITS PUSH ARE GONE (PHASE19 §0) ─────
   *
   * They were the two halves of one button, "Set up WSL acceleration", which
   * submitted an `engine/wsl` task to a native Windows engine and followed it.
   * PHASE19 deletes the button on a ruling, not a refactor: Owen, 2026-09-18,
   * *"we should assume they have no idea how to do it and it should do it
   * automatically."* The move is the TRAY's now, decided at every start from
   * facts on disk (§2.3), and an app that could also ask for it would be the
   * second owner of "is this machine moving to the Linux engine".
   *
   * What replaces it on screen is a READOUT, not a control: the outcome the
   * tray writes (§2.2), reached through the three doors below. The one control
   * that survives is §2.5's Try again, and it exists only because a person can
   * change a BIOS setting and want the machine looked at again.
   */
  /**
   * Is this window Foundry's own, or is it standing inside another app?
   *
   * ── Why the renderer is told at all ─────────────────────────────────────────
   *
   * Because a few things on screen are answers to questions the host has already
   * answered, and showing them twice is worse than showing them once. The library
   * folder is the first: hosted, the books live in the host's data directory and
   * the control that moves them is a control that would strand the host's own
   * mappings, so it goes (see `library:set`). Home is the next: hosted, the book
   * list is BookForge's, and two library screens are two answers to "what books
   * do I have".
   *
   * ASKED ONCE AND NEVER PUSHED. Nothing can mount a host halfway through a
   * session — `mountFoundry` runs before the window is opened and there is one
   * process — so this is a fact for the lifetime of the page, and an event
   * channel for it would be a subscription that never fires.
   */
  ipcMain.handle('app:hosted', () => hosted());

  /*
   * ── THE HOST-OPERATIONS SOCKET — a family BookForge owns nothing in ───────
   *
   * `host-ops:` was chosen for exactly that reason. Hosting is additive only
   * while no FULL channel name is shared, and every family this app has ever
   * used was audited against the host's registry once (docs/IPC-CHANNELS.md);
   * a brand-new family with a hyphen in it cannot collide with anything, so
   * the socket is collision-safe by construction rather than by re-running an
   * audit every time it grows a door. It has grown three since — the
   * failed-node pair and the chrome's status chip — and that promise is what
   * made each of them free. A fourth name arrived on 2026-08-18 and is NOT a
   * door: `host-ops:offers-changed` is a broadcast, so it is registered where
   * every push in this app is (`broadcast`, electron/window.ts) and the count
   * below is unchanged by it.
   *
   * EVERY ONE IS REGISTERED WHETHER OR NOT ANYBODY MOUNTED A HOST. The
   * renderer asks the same questions in both worlds and gets an empty list or a
   * null standalone (electron/host-ops.ts): a door that existed only when hosted
   * would be a renderer that has to know which world it woke up in before it
   * can draw a tree.
   */
  /*
   * WHAT THE HOST REGISTERED AT MOUNT — the operations, and whether a failed
   * node's Retry and Dismiss have anywhere to go.
   *
   * IT ANSWERS AN OBJECT RATHER THAN AN ARRAY, and the shape change is the
   * cheapest of the three ways to let the tree ask that second question: it is
   * the same question as the first (what did the host register), asked in the
   * same round trip the renderer already makes at startup, and it adds no channel
   * name for BookForge's collision keeper to audit. See `hostTakesNodeActions`.
   *
   * AND THE ANSWER IS COMPOSED WHERE THE PUSH COMPOSES IT. `host-ops:offers-changed`
   * carries this very shape now that a host may revise its acts, and a door and a
   * broadcast spelling one fact twice are two answers waiting to disagree — so
   * both are `hostOffers()` and there is no second literal to keep in step.
   */
  ipcMain.handle('host-ops:offers', () => hostOffers());
  /*
   * ONE PROJECT'S HOST NODES — and, on the way past, the host's QUEUE rows for it.
   *
   * ── Why two answers ride one ask ──────────────────────────────────────────
   *
   * This is the moment main learns that a window is drawing a particular book,
   * and it is the only such moment: `queue:list` is global and names no project,
   * because the shelf has always been one list across the library. A host that
   * keeps its own queue pushes per project (`setHostQueueRows`), so a window that
   * opened AFTER the host's last push would draw an empty shelf until something
   * moved — the same gap `hostNodesFor` exists to close for the tree, one line up.
   *
   * IT ADDS NO CHANNEL, which is the reason it rides here rather than arriving as
   * a door of its own: the count in docs/IPC-CHANNELS.md stays where it is and
   * BookForge's keeper has nothing new to audit. A host that offers no `rows` is
   * unaffected, and standalone the seed is a function call that returns at its
   * first line.
   */
  ipcMain.handle('host-ops:nodes', (_event, projectDir: string) => {
    queue.seedHostQueueRows(projectDir);
    return hostNodesFor(projectDir);
  });
  /*
   * How the host's stateful acts stand at one node — asked when a card is picked,
   * so a tile can say an act is already done there (`HostOperationState`).
   */
  ipcMain.handle('host-ops:state', (_event, projectDir: string, nodeId: string) =>
    hostOperationStates(projectDir, nodeId));
  /*
   * The user pressed one of the host's acts, from a node in the tree.
   *
   * MAIN OWNS THE FUNCTION AND THE RENDERER OWNS ONLY THE ID — the operation is
   * looked up in what the host registered at mount, and an id nothing registered
   * is a refusal naming it. The rejection is deliberately NOT caught: this is a
   * button, and the tree puts the host's own sentence on the notice strip when
   * it fails. See `HostOperation.invoke`.
   */
  ipcMain.handle(
    'host-ops:invoke',
    /*
     * `settings` IS THE THIRD ARGUMENT AND IT IS THE ANNOUNCED CHANGE — the
     * answers to the form the operation declared, or `{}` for one that declared
     * none (see `HostOperation.invoke`, electron/host-ops.ts). Defaulted at the
     * door as well as inside, because a renderer built against the older preload
     * would send two arguments and must go on working rather than handing the
     * host `undefined` for a record it is entitled to destructure.
     */
    /*
     * AND THE FOURTH ARGUMENT IS COMPOSED HERE RATHER THAN SENT — see
     * `HostInvokeContext` (shared/host-ops.ts). It is what FOUNDRY knows about the
     * position, so it is read off the ledger in main, at the moment of the press,
     * and not taken from a renderer that holds a mirror of the same file: a mirror
     * that had not caught up would tell somebody else's queue that a book was
     * cleaned when it was not.
     */
    (
      _event,
      operationId: string,
      projectDir: string,
      nodeId: string,
      settings: Record<string, unknown> = {},
    ) => invokeHostOperationAt(operationId, projectDir, nodeId, settings),
  );

  /*
   * RETRY OR DISMISS A HOST NODE THAT FAILED.
   *
   * ── Why it is a door of its own and not another operation ─────────────────
   *
   * An operation is the HOST's — it has an id the host minted, a label the host
   * wrote, and a rule about what it may be chained onto. These two are FOUNDRY's
   * words for a thing every queue has: the tree draws them itself, on a fixed
   * pair (`HostNodeAction`), so that a failed card has a way out of it without
   * the host having had to think of registering one. Routing them through
   * `host-ops:invoke` would have meant inventing operation ids on this side and
   * hoping no host ever used the same string.
   *
   * THE REJECTION IS DELIBERATELY NOT CAUGHT, exactly as with `invoke`: this is a
   * button, the tree says the host's sentence where the button was, and a button
   * that appears to do nothing is the one outcome this socket must not have. A
   * host that registered no callback is refused BY NAME here rather than silently
   * — though the tree does not draw the buttons at all in that case, so the only
   * way to see it is a renderer and a host that disagree.
   */
  ipcMain.handle(
    'host-ops:node-action',
    (_event, projectDir: string, nodeId: string, action: HostNodeAction) =>
      actOnHostNode(projectDir, nodeId, action),
  );

  /*
   * ── THE STATUS CHIP — the one thing a host may draw in this window's chrome ─
   *
   * WHAT THE HOST IS DOING NOW, AND WHETHER A CLICK ON IT GOES ANYWHERE.
   *
   * Both in one answer, on `host-ops:offers`' precedent exactly: they are read
   * out of one registration, they are wanted in the same breath by the same
   * component, and a second channel for the probe would be one more name for
   * BookForge's collision keeper to audit for a boolean. Null standalone and
   * null for a host that has pushed nothing, which is the chip not being drawn
   * at all — the chrome is Foundry's alone unless somebody says otherwise
   * (shared/host-ops.ts, `HostStatus`).
   */
  ipcMain.handle('host-ops:status', () => ({
    status: hostStatus(),
    openable: hostOpensStatus(),
  }));
  /*
   * THE CHIP WAS CLICKED. What that means is the host's own — raising its queue
   * window is the obvious reading and Foundry neither requires nor inspects it
   * (`FoundryHost.onStatusOpen`).
   *
   * IT REFUSES BY NAME for a host that registered nothing, and the renderer
   * should never send it in that case: the chip is drawn WITHOUT a press when
   * `openable` is false, so the only way to reach this sentence is a renderer
   * and a host that disagree about what was registered. Said out loud rather
   * than returned quietly, on `host-ops:invoke`'s rule.
   */
  ipcMain.handle('host-ops:status-open', () => openHostStatus());

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
  ipcMain.handle('document:read-bytes', (_event, target: string) => readDocumentBytes(target));

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
    if (exportInTray(resolved) === null) {
      throw new Error('That file is not one of this library’s exports.');
    }
    const extension = path.extname(resolved).replace('.', '').toLowerCase();
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
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
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
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
    answerLetGo(go === true);
  });

  /**
   * The window, closed from inside it — the ✕ pressed by the page rather than
   * by a person.
   *
   * ── Why the renderer needs a door at all ────────────────────────────────────
   *
   * Because HOSTED, RUNNING OUT OF TABS IS THE END OF THE WINDOW. Standalone,
   * closing the last document leaves the workbench standing in the project it
   * was in, and Home under that is where the app legitimately begins; hosted,
   * the book list is BookForge's and falling through to a second project picker
   * is the workbench turning into a copy of the app around it (user ruling,
   * 2026-08-16). The moment is the renderer's — main knows which files were ever
   * opened, not which documents are open NOW, the same asymmetry `window:closing`
   * exists for — and the act is main's, because a page cannot close the window
   * it is drawn in.
   *
   * IT IS THE ✕'S OWN PATH AND NOT A SHORTCUT PAST IT. `close()` re-enters the
   * window's `close` handler, which runs `letTheWindowGo` and asks the documents
   * through `window:closing` exactly as a pointer on the ✕ would. With nothing
   * open that answer is yes and arrives immediately; if something is still open
   * — anything that ever calls this with tabs left — the question is asked, and
   * a person who says keep it keeps their window.
   *
   * NO WINDOW IS NOT AN ERROR HERE. A page invoking this during teardown, after
   * the window it was drawn in has already gone, is asking for a state that has
   * arrived; `foundryWindow()` is null in exactly that case and the door is a
   * no-op rather than a throw into a renderer that is being destroyed.
   */
  ipcMain.handle('window:close', () => {
    foundryWindow()?.close();
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
   * A book pane can hold changes nobody applied, and a book's filed copy can be
   * out of date. They are two different states and this app has already ruled that
   * a closing document is asked about once (`closeShowing`,
   * core/documents.service.ts): a second card on top of the first is the app
   * arguing with an answer it already has.
   *
   * NEITHER IS A LOSS ANY MORE, and the first one used to be. Closing over a
   * stack destroyed it until 2026-08-22; it is now written to a sidecar as it is
   * made and comes back at the same step, so this card asks whether to RECORD the
   * work rather than warning that it is about to go. See `aboutTheEdits` for the
   * whole of that reversal.
   *
   * IT WAS THREE. The third — "no copy of this exists anywhere you chose" — went
   * with the user's own ruling (*"only pop up a confirmation alert if changes have
   * been made"*), and the fourth, the block editor's uncommitted CURATION, went
   * with the block editor itself: there is one editing surface now and its
   * unapplied work is the stack, which is the first arm below.
   */
  ipcMain.handle(
    'document:confirm-close',
    (_event, warning: CloseWarning): Asked<CloseAnswer> => confirmClose(warning),
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
    (_event, prompt: ReReadPrompt): Asked<ReReadAnswer> => confirmReRead(prompt),
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
  /*
   * ── AND THE THIRD ARGUMENT, WHICH IS OWEN'S PENDING-NODE RULING ARRIVING ───
   *
   * *"i click the grayed out row and hit the export epub tile."* The dialog aims at
   * the POSITION unless the tree pressed from a card that is not it — a landed row
   * further up, or a promise that has not landed at all — and `from` is how it says
   * which. `aimedAt` resolves the three cases once for all four plan doors and
   * refuses an id that is neither, by name.
   *
   * THE CHANNEL IS WIDENED RATHER THAN REPLACED, which is the standing rule for
   * this seam: docs/IPC-CHANNELS.md is BookForge's collision audit, and a new name
   * is a name to audit plus an old one to prove retired — paid for a door whose
   * behaviour is unchanged for every caller that does not pass the argument. A
   * renderer built against the older preload sends two arguments and gets exactly
   * what it always got.
   */
  ipcMain.handle(
    'workspace:plan-export',
    (_event, inputPath: string, kind: ConversionKind, from?: string) => planExportFrom(inputPath, kind, from),
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
  ipcMain.handle(
    'workspace:plan-translation',
    (_event, inputPath: string, targetLanguage: string, from?: string) =>
      planTranslationFor(inputPath, targetLanguage, from),
  );

  /*
   * A SIMPLIFY IS A TRANSLATION AND IS ADMITTED THE SAME WAY. It is the same
   * plan, about the same open document, reading the same input to materialise the
   * same book — so the allow-list check above is not a pattern being copied here,
   * it is the same check about the same act. The mode is the only thing this door
   * carries that the other does not, and it is not a path: `planSimplification`
   * takes it as one of three values and the engine refuses anything else.
   */
  ipcMain.handle(
    'workspace:plan-simplify',
    (_event, inputPath: string, mode: RewriteMode, from?: string) => planSimplificationFor(inputPath, mode, from),
  );

  /*
   * A CLEANUP IS ADMITTED THE SAME WAY, AND IT ASKS NOTHING AT ALL.
   *
   * It is the same plan about the same open document, materialising the same book
   * — so the allow-list check is not a pattern being copied here, it is the same
   * check about the same act. What it carries that the two above do not is a
   * STAMP path in the answer; what it does not carry is a question: a cleanup has
   * no language to go into and no mode to be asked in, so this door takes the
   * document and nothing else.
   *
   * IT IS NOT REFUSED HOSTED, WHICH IS `queue:enqueue-analysis`' OPPOSITE. That
   * one refuses because the host's queue has never heard of an analysis; this act
   * exists ONLY on the host's behalf (Owen, 2026-09-05: *"cleanup will only ever
   * be done on behalf of bookforge and wont be available in foundry"*), so the
   * gate is the other way round — the tile is drawn only in a hosted window
   * (`@if (hosted())`, action-menu.component.ts), and this door serves it. It is
   * not gated on `hosted()` in main because main's own gate would be a second
   * copy of a rule the renderer already enforces, and because a host act that
   * reached this from the mount seam would meet a refusal about a window rather
   * than about a book.
   */
  /*
   * THE HOST'S SECTION ON THE CLEAN TEXT CARD (`HostPassOffer`, shared/host-ops.ts).
   *
   * The step is resolved EXACTLY as `workspace:plan-clean` below resolves it — the
   * row the card is aimed at, a promise it waits on, or the position — but NOTHING
   * is planned, minted or written: this is asked every time the card opens, and a
   * card closed unpressed must leave no trace. Standalone, and for a host with no
   * `passOffer`, it is null before anything is read.
   */
  ipcMain.handle('host-ops:pass-offer', (_event, inputPath: string, from?: string) =>
    hostPassOfferFor(inputPath, from));

  ipcMain.handle('workspace:plan-clean', (_event, inputPath: string, from?: string) =>
    planCleanupFor(inputPath, from));

  /*
   * AN ANALYSIS IS ADMITTED THE SAME WAY A TRANSLATION IS, and for the identical
   * reason: it is asked ABOUT a file the renderer already has open, and the plan
   * materialises that position's book to hand to the engine. Without the check
   * this handler would resolve — and then plan against — any path a compromised
   * renderer named.
   *
   * THE CATEGORIES ARE NOT PATHS AND ARE STILL NOT TAKEN ON TRUST. Every name is
   * checked against the CLOSED SET this app can name — the engine's built-ins
   * (`ANALYSIS_CATEGORY_IDS`) plus the ids of the categories this user has
   * written down (`app-settings.json`) — before it reaches the ledger. A request
   * naming something outside that set is refused by name rather than quietly
   * dropped, because a silently narrowed checklist is a report that is missing a
   * category nobody can see was missing.
   *
   * ── THE SET IS WIDER THAN IT WAS, AND IT IS STILL CLOSED ──────────────────
   *
   * Owen's *"maybe the user can add more categories"* means free text now DOES
   * become a category name, so the sentence this comment used to carry — no free
   * text ever reaches a model's question — needed a new true form rather than a quiet
   * deletion. It is this: free text becomes a category ONLY by being written
   * into the user's own settings file through the door below, where it is
   * slugged into `customCategoryId`'s shape, length-capped and collision-checked
   * (`clampAnalysisCategories`); and this handler admits a name only if that file
   * already holds it. So the path from a text box to a prompt runs through a
   * deliberate act of saving, and the string that arrives here is always one main
   * itself minted.
   */
  ipcMain.handle('workspace:plan-analysis', (_event, inputPath: string, categories: string[]) =>
    planAnalysisFor(inputPath, categories));

  /**
   * ONE ANALYSIS STEP'S REPORT, for the panel that draws it.
   *
   * THE RENDERER STAYS FILE-FREE, which is this whole family's rule: it names a
   * project directory and a step id, main proves the directory is one of Home's
   * before it opens anything, and what comes back is the header, the findings and
   * one sentence about staleness. The cache rows — one per sentence in the book —
   * never cross (`readAnalysisReport`, electron/projects.ts).
   *
   * A REFUSAL IS A SENTENCE INSIDE THE ANSWER RATHER THAN A REJECTION, on
   * `BookOutcome`'s rule: "that step was deleted" and "the report is not on the
   * disk" are ordinary states a person should meet as a line on a panel, not as a
   * console error and an empty column. The one thing that still rejects is the
   * directory gate, which refuses before a byte is read.
   */
  ipcMain.handle('workspace:read-analysis', (_event, projectDir: string, stepId: string) =>
    readAnalysisReport(projectDir, stepId));

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

  ipcMain.handle('projects:describe', (_event, dir: string) => describeProjectDelete(dir));

  ipcMain.handle('projects:delete', (_event, dir: string) => deleteProjectFolder(dir));


  ipcMain.handle('documents:describe', (_event, filePath: string): Promise<DocumentDeletion> =>
    describeDocumentDelete(filePath));


  openExportDeleteDoor();

  ipcMain.handle('documents:delete', (_event, filePath: string) => deleteDocumentFile(filePath));

  /*
   * ── A document's own record ──────────────────────────────────────────────
   *
   * `foundry epub-meta` and `foundry pdf-meta`, spawned exactly as `doctor` and
   * `epub-stamp` are: the engine owns the file format and this app owns the
   * question. Reading and writing are one pair of handlers rather than four,
   * because the dialog does both against the same document and a patch with no
   * fields in it IS a read.
   *
   * WHICH FILE IS MAIN'S DECISION, and the two formats prove it two different
   * ways because they arrive by two different doors. For a PDF the renderer names
   * the path it already has open, which is the WORKING PDF; it is resolved through
   * the same allow-list every other read goes through, so a renderer cannot ask
   * main to rewrite a file nobody opened. For an EPUB the renderer names a
   * FINISHED EXPORT, and an export was never opened at all — it is a file this
   * process wrote into `<project>/final/` and the renderer learned about off a row
   * in the history — so the allow-list has nothing to say about it and membership
   * in the tray is the claim being exercised instead (`exportInTray`, which
   * `export:save-copy` and `book:view` are gated on for the same reason).
   */

  ipcMain.handle('meta:read-pdf', (_event, filePath: string) =>
    readPdfMetadata(admittedPdf(filePath)));
  ipcMain.handle(
    'meta:write-pdf',
    (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> =>
      writePdfMetadataFor(filePath, patch),
  );

  ipcMain.handle('meta:read-epub', (_event, filePath: string) =>
    readEpubMetadata(exportedBook(filePath)));
  ipcMain.handle(
    'meta:write-epub',
    (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> =>
      writeEpubMetadataFor(filePath, patch),
  );
  /*
   * ── The mint metadata — who the book says it is, per project ──────────────
   *
   * The block the mint modal edits (shared/mint-meta.ts carries the shape and
   * Owen's ruling). READ answers null rather than a seed: the SEEDING is the
   * dialog's decision — it composes a first guess out of the manifest title,
   * the scan's Info author and the position's language, three facts the
   * renderer already holds — and main inventing one here would be two seeders
   * with two opinions. WRITE replaces the whole block; the directory is proved
   * the way every project door proves it, by reading the manifest of the
   * folder named and nothing else.
   */
  ipcMain.handle('meta:mint-read', async (_event, projectDir: string) =>
    (await readManifest(projectDir)).meta ?? null);
  ipcMain.handle('meta:mint-write', async (_event, projectDir: string, meta: MintMeta) => {
    await recordMintMeta(projectDir, meta);
  });
  /*
   * The whole block onto ONE finished export, in place — the metadata tile's
   * Save over an EPUB somebody is looking at. Gated exactly as the flat
   * writer above (`exportedBook`): only a file this app filed answers, and
   * the language written is the FORM'S here, deliberately — an edit of a
   * finished file is a person correcting that file's record, not a mint
   * whose chain outranks them.
   */
  ipcMain.handle('meta:mint-stamp', (_event, filePath: string, meta: MintMeta) =>
    stampMintMetadata(exportedBook(filePath), meta, undefined));
  /*
   * The HOST's answer for who this book is — the hosted modal's seed (Owen:
   * "it should inherit the parent document's metadata. ill fill out whatever
   * is missing"). Null standalone; a host that THROWS rejects here in the
   * host's own words, so the form can say so (2026-09-07); the DIALOG
   * merges, because the precedence (stored block wins per-field, host fills
   * the gaps, the position feeds the language) reads two other facts only the
   * renderer holds.
   */
  ipcMain.handle('meta:mint-host', (_event, projectDir: string) => hostMintMeta(projectDir));

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

  /*
   * ── THE CAPTURE STAGE, REGISTERED AND NOT YET ANSWERING ───────────────────
   *
   * Merge 1 is the CONTRACT and nothing else: these seven exist so the renderer
   * can be written and typechecked against real declarations while main is
   * still being filled in (docs/CAPTURE.md, work packages). They refuse by name
   * rather than by silence, because a door that resolves undefined is a bug
   * report about the renderer and a door that throws is a true sentence about
   * the app.
   *
   * REGISTERED HERE AND NOT BEHIND A FLAG. A channel that appears later is a
   * channel `docs/IPC-CHANNELS.md` cannot enumerate and the audit cannot see;
   * the seven names are the contract, and the contract is what ships first.
   */

  /*
   * `capture:create` MAKES A PROJECT, which no other door here does. It answers
   * with the directory because that directory is the only handle anything has
   * on a project keyed from a random id rather than from a document — and with
   * the recipe and token beside it, so the light table opens in one round trip
   * rather than creating and then immediately loading.
   */
  ipcMain.handle('capture:create', async (_event, title: string) => {
    const made = await createCaptureProject(title);
    return { projectDir: made.dir, ...(await ensureCapture(made.dir)) };
  });
  /*
   * INTAKE IS THE LONG ONE. Every photograph is copied, hashed, decoded, encoded
   * to a lossless working copy and thumbnailed, one at a time — seconds each,
   * and the acceptance shoot is twenty-seven of them. It is an `invoke` like the
   * others because the contract says so; a person watching a spinner for a
   * minute is a surface problem, and inventing a progress channel here would
   * make it a protocol one.
   */
  ipcMain.handle('capture:intake', (_event, projectDir: string, paths: string[]) =>
    intakePhotos(projectDir, paths));
  ipcMain.handle('capture:recipe-load', (_event, projectDir: string) => openCapture(projectDir));
  /*
   * ── GRAVESTONE: `capture:pages-load` (Wave 41) ────────────────────────────
   *
   * A door stood here that listed the page images a mint had made and handed
   * back a token to serve them, because the mint wrote pictures and no
   * container. It admitted nothing — the token was the whole authorisation —
   * and it read the POSITION to decide which mint, so a re-mint's older row
   * still opened its own book.
   *
   * The mint writes a PDF (`recordMint`) and the minted row resolves to it
   * through `ledger:document-at` like every other document in the app, so
   * pdf.js draws the pages and this door has nothing to answer. Removing it
   * moves the handle count in docs/IPC-CHANNELS.md, which BookForge's keeper
   * test reads — the table is regenerated in the same commit.
   */
  /*
   * REMOVAL, WHICH IS THE ONE DOOR THAT DELETES ANYTHING IRREPLACEABLE. It is
   * allowed to because the bank holds copies of files that still exist where
   * the person dragged them from, and because the surface has already asked
   * them, by name and by count. Refused while this project is being minted.
   */
  ipcMain.handle('capture:remove', (_event, projectDir: string, photoIds: string[]) =>
    removePhotos(projectDir, photoIds));
  /*
   * SAVED WHOLE AND VALIDATED WHOLE. The renderer debounces; this does not, and
   * it refuses a recipe it cannot read rather than writing it — a malformed
   * recipe on disk is not a bug that throws, it is a project that will not open
   * tomorrow, holding photographs nobody can remake.
   */
  ipcMain.handle('capture:recipe-save', (_event, projectDir: string, recipe: CaptureRecipe) =>
    writeRecipe(projectDir, recipe));
  /*
   * THE MINT IS A SESSION AND NOT A CALL, which is why there are four of these.
   * Main decides the list, the renderer sends back one finished page at a time,
   * and the commit is the single point at which a document appears. Nothing is
   * written into the project until then: a mint given up on halfway leaves the
   * catalogue exactly as it found it.
   */
  ipcMain.handle('capture:mint-begin', (_event, projectDir: string) => mintBegin(projectDir));
  ipcMain.handle('capture:mint-page', (_event, mintId: string, index: number, jpeg: ArrayBuffer) =>
    mintPage(mintId, index, jpeg));
  ipcMain.handle('capture:mint-commit', (_event, mintId: string) => mintCommit(mintId));
  ipcMain.handle('capture:mint-abort', (_event, mintId: string) => mintAbort(mintId));
  /*
   * THE PDF EXPLOSION IS A SESSION TOO, AND FOR THE MINT'S REASON REVERSED.
   *
   * A dropped PDF becomes one PNG per page. The renderer rasterizes — pdf.js is
   * over there — and these three doors are main putting the pages on disk so
   * that `capture:intake` above can copy them in exactly as it copies a
   * photograph. One page per call, because a 300-page scan is gigabytes and a
   * call that carried the book would hold all of it in one heap.
   *
   * NOTHING HERE ADMITS ANYTHING, because nothing here is a path the renderer
   * named: main chooses the directory, the renderer supplies bytes and a
   * basename, and the basename is checked rather than trusted (`pdfStagePage`).
   * The release is separate from the last page because the two callers let go at
   * different moments — see the function's own note.
   */
  ipcMain.handle('capture:pdf-stage-begin', () => pdfStageBegin());
  ipcMain.handle('capture:pdf-stage-page', (_event, stageId: string, name: string, png: ArrayBuffer) =>
    pdfStagePage(stageId, name, png));
  ipcMain.handle('capture:pdf-stage-release', (_event, stageId: string) => pdfStageRelease(stageId));
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
  ipcMain.handle('ledger:document-at', (_event, projectDir: string) => documentAtPositionAdmitted(projectDir));
  /*
   * THE SAME ANSWER FOR A ROW NOBODY IS STANDING ON — Compare's document resolve.
   *
   * The column beside the live one is locked to a step the person picked, and a
   * step whose picture is a FILE (the import, a rendering) needs that file's path
   * before a viewer can be pointed at it. `document-at` cannot answer it: it reads
   * the pointer, and the pointer is by definition somewhere else while a
   * comparison is on screen.
   *
   * IT ADMITS WHAT IT ANSWERS, exactly as `document-at` does one door up and for
   * the identical reason: the renderer is about to point pdf.js at this path, and
   * a path the renderer named for itself is a path this process never agreed to
   * serve. The allow-list is the only thing standing between a compare column and
   * an arbitrary file, so the pairing — main resolves it, main admits it — is not
   * a convenience here, it is the whole gate.
   *
   * NOT REMEMBERED AS A RECENT, on `document-at`'s own rule: nothing was opened,
   * somebody put a second view on a row of a book they already have open.
   */
  ipcMain.handle('ledger:document-at-step', (_event, projectDir: string, stepId: string) =>
    documentAtStepAdmitted(projectDir, stepId));
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
   * THE BOOK AS OF A NAMED STEP — the read Compare is built on.
   *
   * EVERYTHING `book:load` SAYS APPLIES HERE WORD FOR WORD: no path crosses it in
   * either direction, it may spawn the engine, it answers a failure rather than
   * rejecting one, and the single thing that still rejects is a directory that is
   * not one of Home's projects. The only difference is which row the replay is
   * resolved to, and that difference is a parameter the machinery underneath has
   * carried since translations began materialising at the landing — see
   * `loadBookAt` (electron/book.ts) for why this is one replay asked twice rather
   * than two replays.
   *
   * A STALE STEP ID IS A SENTENCE, not a rejection. The picker is drawn from a
   * ledger this window read a moment ago, and a delete can land in between; the
   * compare column has a sheet to put that sentence on, which is the same contract
   * every other failure of this family has.
   */
  ipcMain.handle('book:load-at', (_event, projectDir: string, stepId: string) =>
    loadBookAt(projectDir, stepId));
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
  /*
   * ── THE WORKING STACK, ON DISK — three doors, and none of them is history ────
   *
   * Apply is what writes a STEP. These three write the thing that has not been
   * applied yet, so that no window closing, no crash and no glance at another tab
   * can be the reason somebody's afternoon is gone (user report, 2026-08-21: a
   * chapter renamed, a paragraph retyped, an EPUB exported without either, and
   * then the stack scrapped by a window nobody asked). `savePendingStack` is
   * called on a debounce from the pane, exactly as the light table's recipe is;
   * `readPendingStack` is asked once per open and refuses out loud rather than
   * adopting a stack made somewhere else; `clearPendingStack` has two callers and
   * both of them are a person speaking.
   *
   * THEY REJECT, on `book:apply`'s rule and for its reason: the changes are in
   * front of the person and a write that quietly did not happen is the failure
   * this family exists to end. The read is the one exception in spirit — it
   * answers a refusal rather than throwing one — because "there is something held
   * and it is not about this book" is a fact the pane has to say a sentence
   * about, not an error.
   */
  ipcMain.handle('book:pending-save', (_event, projectDir: string, stack: PendingStack) =>
    savePendingStack(projectDir, stack));
  ipcMain.handle('book:pending-read', (_event, projectDir: string) =>
    readPendingStack(projectDir));
  ipcMain.handle('book:pending-clear', (_event, projectDir: string) =>
    clearPendingStack(projectDir));
  /**
   * THE CARD IN FRONT OF EVERY ACT THAT WOULD RUN PAST WORK NOBODY APPLIED.
   *
   * ── OWEN'S RULING, VERBATIM (2026-08-22) ────────────────────────────────────
   *
   * *"if the user has 'this book' selected with un-applied changes, the export
   * option shouldnt be grayed out. but any action they take, whether it's
   * switching to a different step or narrating or anything at all, should ask if
   * they want to apply changes in a modal. discard/apply changes. if they hit
   * discard, it does whatever action they selected to the step theyre on after
   * dropping changes they made. if they hit apply changes, the action they select
   * is executed after applying all changes. and maybe there should be another
   * apply changes button somewhere obvious. the button on the side of the
   * workbench works but it isnt obvious"*
   *
   * Every clause of that has a home: the two buttons are here, the widened set of
   * acts is `UnappliedAct` and `UnappliedService`, "it does whatever action they
   * selected" is that service running the act after either answer, "shouldnt be
   * grayed out" is the make-act predicates NOT consulting the stack (they never
   * did, and it was checked rather than assumed), and the obvious button is at the
   * head of the book pane.
   *
   * ── Why this is a door and not four lines in the renderer ───────────────────
   *
   * Because the sentences are main's, which is this app's one rule about this one
   * card (`ConfirmService`: *"The one thing the renderer must never do to this
   * dialog is start writing its own copy"*). The renderer hands over the facts it
   * is the only holder of — how many changes are waiting, on which book, under
   * which act — exactly as `document:confirm-close` is handed `edits`, and main
   * composes.
   *
   * ── APPLY IS OFFERED FIRST, and it is the same Apply ────────────────────────
   *
   * The closing card's own argument: a dialog whose only route to keeping the
   * work is *cancel, find Apply, press again* has made the person do the app's
   * job. It is what Enter takes and Discard is last, which is this app's rule for
   * every card that can destroy something.
   *
   * ── AND THIS CARD CAN NOW DESTROY SOMETHING, WHICH IT COULD NOT BEFORE ──────
   *
   * The three-answer version was safe by construction: apply, or go on without
   * them, or cancel — every one of them left the stack on the page, and the
   * docblock that stood here said so and gave that as the reason nothing wore the
   * error colour. Discard changes that. This is the second gesture in the app
   * (the closing card's own Discard is the first) that throws unapplied work
   * away, so it wears the error colour, it is last, and the detail says out loud
   * that it is for good. The one that used to be safe-by-construction is now
   * safe-by-aiming, which is a weaker guarantee honestly stated rather than a
   * stale sentence about a card that no longer exists.
   *
   * ── ONE CARD, FIVE ACTS, TWO SENTENCES THAT VARY ────────────────────────────
   *
   * `runs` says what the act would be made from and `then` says what happens
   * after the answer. Everything else — the title, the count, the warning about
   * Discard, the way out — is identical wherever this is raised, because it is
   * one question and a person should not have to re-read it to find out whether
   * this is the same box they answered a minute ago.
   */
  ipcMain.handle(
    'book:confirm-unapplied',
    (_event, warning: UnappliedWarning): Asked<UnappliedAnswer> => confirmUnapplied(warning),
  );
  ipcMain.handle('ledger:describe-delete', (_event, projectDir: string, stepId: string) =>
    describeLedgerStepDelete(projectDir, stepId));
  openStepDeleteDoor();
  ipcMain.handle('ledger:delete', (_event, projectDir: string, stepId: string) =>
    deleteLedgerStep(projectDir, stepId));

  // ── The library folder ───────────────────────────────────────────────────
  /*
   * ── THE USER'S OWN ANALYSIS CATEGORIES ────────────────────────────────────
   *
   * Owen, 2026-08-25: *"maybe the user can add more categories - even
   * one-sentence descriptive ones."* They are the USER'S and not one project's,
   * so they live in `app-settings.json` beside the library folder and reach every
   * book that machine ever opens (`AppSettings.analysisCategories`).
   *
   * TWO DOORS AND NOT ONE, and the write takes the WHOLE LIST rather than a
   * single add or remove. A per-item door would need an id from the renderer to
   * say which item, and ids here are DERIVED from names by main — so "remove the
   * one called X" would be main re-deriving a name the renderer had already
   * derived, and the two derivations would be the thing that had to agree. The
   * whole list is one fact with one owner, and `clampAnalysisCategories` re-mints
   * every id on the way in, so what the file holds is always main's own spelling
   * whatever the window sent.
   *
   * IT IS NOT REFUSED WHEN HOSTED. A library move is refused there because the
   * books belong to the host; a list of claims somebody wants hunted for belongs
   * to the person, and BookForge has no opinion about it.
   */
  ipcMain.handle('analysis:read-categories', () => readAppSettings().analysisCategories);
  ipcMain.handle(
    'analysis:write-categories',
    (_event, categories: CustomAnalysisCategory[]) =>
      writeAppSettings({
        analysisCategories: Array.isArray(categories) ? categories : [],
      }).analysisCategories,
  );
  /*
   * SUGGEST CATEGORIES FROM THE BOOK — one streamed chat over excerpts
   * (electron/suggest-categories.ts). Ask's shape: start answers with the run's
   * id at once, the run arrives on `analysis:suggest-progress`, and each
   * suggestion is saved into the user's categories as it arrives. The book must
   * be one this window opened, the plan door's own gate.
   */
  ipcMain.handle('analysis:suggest-start', (_event, request: SuggestCategoriesRequest) => {
    const source = admitted(request.inputPath);
    if (source === null) throw new Error(`${request.inputPath} was never opened in this app.`);
    return startSuggest(request, source, (frame) => { broadcast('analysis:suggest-progress', frame); });
  });
  ipcMain.handle('analysis:suggest-cancel', (_event, runId: string) => { cancelSuggest(runId); });

  /*
   * ── ASK THE DOCUMENT — a model works through the book with tools ──────────
   *
   * `ask:start` ANSWERS WITH THE RUN'S ID AT ONCE and the run arrives on
   * `ask:progress` — a run is minutes of a model's work, and an invoke held that
   * long is one the renderer cannot even be told about (the pull door's rule).
   * Every frame carries the project, so a pane that was closed and opened again
   * still knows which frames are its own. NOTHING HERE WRITES THE BOOK: the
   * marks come back as a list and the renderer lands them on its own stack
   * (electron/ask-document.ts says why).
   *
   * THE SESSIONS ARE THE RECORD THE REVIEW CARD READS after a reload, written
   * by the renderer once a run has landed, with only what landed.
   */
  ipcMain.handle('ask:start', (_event, request: AskRequest) =>
    startAsk(request, (frame) => { broadcast('ask:progress', frame); }));
  ipcMain.handle('ask:cancel', (_event, runId: string) => { cancelAsk(runId); });
  ipcMain.handle('ask:sessions', (_event, projectDir: string) => readAskSessions(projectDir));
  ipcMain.handle('ask:save-session', (_event, projectDir: string, session: AskSession) =>
    saveAskSession(projectDir, session));
  // A book's conversations (shared/ask-conversations.ts), newest first; the first read migrates the old thread.
  ipcMain.handle('ask:conversations', (_event, projectDir: string) => readAskConversations(projectDir));
  ipcMain.handle('ask:delete-conversation', (_event, projectDir: string, id: string) => deleteAskConversation(projectDir, id));
  ipcMain.handle('ask:rename-conversation', (_event, projectDir: string, id: string, title: string) =>
    renameAskConversation(projectDir, id, title));
  // Ask's presets are the app's, kept in app-settings.json (shared/ask-presets.ts).
  ipcMain.handle('ask:presets', (): AskPresetsKept => readAskPresets());
  ipcMain.handle('ask:save-presets', (_event, patch: Partial<AskPresetsKept>): AskPresetsKept =>
    saveAskPresets(patch));

  ipcMain.handle('library:dir', () => readAppSettings().libraryDir);
  ipcMain.handle('library:set', (_event, dir: string) => {
    refuseHostedLibraryMove();
    return writeAppSettings({ libraryDir: dir }).libraryDir;
  });
  ipcMain.handle('library:choose', async (_event, current: string) => {
    refuseHostedLibraryMove();
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
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


  /*
   * ── WHAT THE SHELF DRAWS, WHICH IS NOT ALWAYS FOUNDRY'S OWN LIST ──────────
   *
   * `shelfJobs` rather than `listJobs`, and the difference only exists hosted:
   * with a host queue registered, the rows in this window are the HOST's, pushed
   * per project and accumulated into the one global list this mirror has always
   * been (electron/job-queue.ts). Standalone the two functions answer the same
   * array. The PUSH on `queue:changed` below is the same expression, because a
   * window that asked and a window that was pushed at must not hold different
   * facts — `hostOffers`' rule, one family along.
   */
  ipcMain.handle('queue:list', () => queue.shelfJobs());
  ipcMain.handle('queue:enqueue', (_event, request: JobRequest) => enqueueJob(request));
  /*
   * ── ONE DOOR FOR THREE TEXT PASSES, AND THE CHANNEL KEEPS ITS NAME ─────────
   *
   * A translation, a rewrite and a narration cleanup all arrive here (Owen,
   * 2026-09-05: *"translate, simplify, and cleanup are all three similar steps"*),
   * because everything this door does is the same for all three: re-check the
   * input against the allow-list, resolve the position from the records file's own
   * project, hand it to the one enqueue. A `queue:enqueue-clean` beside this would
   * have been a second channel with an identical body.
   *
   * THE NAME IS NOT CHANGED EITHER, and that is a deliberate refusal rather than
   * an oversight. docs/IPC-CHANNELS.md is BookForge's COLLISION AUDIT — the
   * authority on every name this app owns in a process it shares — and a rename is
   * a new name to audit plus an old one to prove retired, paid for a channel whose
   * behaviour is unchanged. `queue:enqueue-translate` is now the family's door,
   * spelled after its eldest member, and the doc says so.
   */
  ipcMain.handle('queue:enqueue-translate', (_event, request: TextPassRequest) => enqueueTextPassFor(request));
  /*
   * ── A CLEANUP WITH ITS TRIAGE IN FRONT OF IT: ONE PRESS, TWO ROWS ──────────
   *
   * Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with
   * snap and then we bring snap down and load the full normal cleaning logic."*
   * The window sends the cleanup it would have sent to the door above, and
   * `enqueueTriagedCleanup` makes the triage and chains the cleanup behind it.
   *
   * A DOOR OF ITS OWN rather than a flag on `queue:enqueue-translate`, because
   * that door's answer is one row and this act is two — the dialog pins a picked
   * server on both and its Start releases both, so it has to be handed both ids.
   * The whole argument for making the pair in main rather than in the window is
   * at `enqueueTriagedCleanup` (electron/job-queue.ts).
   *
   * THE SAME ADMISSION AND THE SAME POSITION as the door above, because the
   * cleanup is the same request it would have been: its input re-checked against
   * the allow-list, and the position resolved from the project its records file
   * belongs to — which is the triage's position too, since the verdicts are
   * named beside those records. NOT REFUSED HOSTED, on the cleanup's own terms:
   * this act exists only on BookForge's behalf, and the pair routes to its queue.
   */
  ipcMain.handle('queue:enqueue-clean-triaged', (_event, request: CleanRequest) =>
    enqueueTriagedCleanupFor(request));
  /*
   * AN ANALYSIS IS QUEUED THE SAME WAY, and since 2026-10-30 a hosted window
   * queues it too — in the HOST'S queue, which learned the pair (`enqueueAnalysis`,
   * electron/job-queue.ts; Owen: *"analysis is grayed out in foundry/bookforge"*).
   *
   * THE ONE REFUSAL LEFT is a hosted window whose host registered NO queue.
   * Owen's ruling, 2026-08-21: *"when im in bookforge, the shelf shouldnt appear
   * at all"* — so there Foundry's own scheduler would start an hour of GPU with
   * no row anybody in either window can see, cancel or start. A host that keeps a
   * queue is the case that works; one that does not is said by name.
   */
  ipcMain.handle('queue:enqueue-analysis', (_event, request: AnalyzeRequest) => enqueueAnalysisFor(request));
  /*
   * AN EXPORT RUNS AT THE PRESS AND THE ANSWER IS THE SETTLED ROW — the whole of
   * the difference from `queue:enqueue` one door up. The dialog that asked is
   * holding this invoke open for the seconds the run takes, and what it gets
   * back is the row in whatever state it settled: `done` with the filed path,
   * `failed` with the engine's own words, or a still-pending row when something
   * is already writing the same file (`runNow` hands the existing one back, and
   * the caller reads the state to tell the two apart). Never routed to a host
   * queue — an export is seconds of CPU arithmetic somebody is watching for, and
   * the argument lives at `runNow` (electron/job-queue.ts).
   */
  ipcMain.handle('queue:run', (_event, request: JobRequest) => runJobNow(request));
  ipcMain.handle('queue:start', () => queue.start());
  /*
   * ONE ROW, BY NAME — what a dialog's own Start presses. `queue:start` is the
   * shelf's button and releases the whole held batch; this releases the row the
   * caller just made and leaves every other parked row parked. Answers whether
   * it let go, so a dialog that is about to watch the run can tell "running" from
   * "somebody removed it while I was open".
   */
  ipcMain.handle('queue:release', (_event, id: string) => queue.release(id));
  ipcMain.handle('queue:remove', (_event, id: string) => { queue.remove(id); });
  ipcMain.handle('queue:cancel', (_event, id: string) => { queue.cancel(id); });
  ipcMain.handle('queue:clear-finished', () => { queue.clearFinished(); });
  /**
   * THE ROW PICKER'S ONE DOOR — send this row to a different slot.
   *
   * `waitFor` is a slot name or `any` (`ANY_SLOT`, shared/slots.ts). Nothing is
   * answered on the way OUT: the change publishes on `queue:changed` like every
   * other change to a row, and a handler returning the row would be a second
   * copy of it racing the push.
   *
   * A REFUSAL IS NOT NOTHING, THOUGH, and it is deliberately not swallowed here.
   * `setWaitFor` throws a `QueueRoutingRefusal` for a row a GPU has already
   * taken — the race it argues at length — and the throw crosses the preload as
   * a rejected invoke so the picker that sent it can say the sentence. Catching
   * it here would restore exactly the silence that made the race invisible.
   */
  ipcMain.handle('queue:set-wait-for', (_event, id: string, waitFor: string) => {
    queue.setWaitFor(id, waitFor);
  });

  ipcMain.handle('engine:info', () => engineInfo());
  ipcMain.handle('doctor:run', (_event, endpointUrl?: string) => runDoctor(endpointUrl));

  ipcMain.handle('settings:read', () => readSettings());
  /*
   * ── THE ENGINE'S SETTINGS ARE NOT OURS TO WRITE INSIDE A HOST ─────────────
   *
   * `settings.json` is the ENGINE's, machine-global, and hosted the host runs
   * that same engine with that same file (docs/BOOKFORGE-HANDOFF.md). A person
   * changing the mode or the endpoint on this screen inside BookForge would be
   * reconfiguring the host's own conversions from a window that does not own
   * them. The form is hidden there, and this is the door behind it: something
   * reachable by an IPC message must refuse at the door as well, or the hiding
   * is a decoration (`refuseHostedRegistryChange`'s rule, crucible-registry.ts).
   *
   * Found by BookForge's audit, 2026-09-14, unguarded on both sides.
   */
  ipcMain.handle('settings:write', (_event, patch: BackendSettingsPatch) => writeSettingsOutsideHost(patch));

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    shell.showItemInFolder(path.resolve(target));
  });

  /*
   * ── WHAT USED TO BE HERE: `wsl:*` AND `backend:setup-*` ───────────────────
   *
   * Four doors that listed WSL distros, asked one of them what it could build
   * with, and ran a conda/venv build of vLLM inside it while streaming the
   * guest's output over `backend:setup-log`. All four went on 2026-09-13 with
   * the launcher they fed (docs/SLOTS.md §6, package B). This app does not
   * build a vLLM, does not start one, and does not ask about WSL. The local
   * page reader below is what reads pages on this machine now, and a vLLM
   * somebody else runs is reached the way every other server is: by its URL.
   */

  /*
   * ── THE PREBUILT ENVIRONMENTS ARE GONE, AND WITH THEM FIVE DOORS ─────────
   *
   * `env:catalog`, `env:install`, `env:cancel`, `env:choose-dest` and the
   * `env:install-progress` push. They downloaded and installed the Python the
   * rasteriser and the MLX reader ran in; both are gone (2026-11-04: the pages
   * render in-process on MuPDF and every model call goes to Crucible), so there
   * is nothing to install. Folders an earlier version downloaded are left on
   * disk (`retireSettingsKeys`, node/settings.ts, says where).
   */

  /*
   * ── THE LOCAL PAGE READER IS GONE, AND WITH IT EIGHT DOORS ─────────────
   *
   * `page-reader:state`, `:install`, `:install-cancel`, `:start`, `:stop`,
   * `:set-keep-warm`, and the `:progress` / `:status-changed` pushes.
   *
   * Owen, 2026-09-17: *"foundry shouldnt assume there even is a local system.
   * there sohuldnt be a local system. foundry does all ai work through
   * crucible."* Reading a page wants a GPU, so it belongs to an engine. The
   * settings card went first, then the queue's fallback, then the gate that
   * lit the OCR tile with no engine, then the first-run step that sold the
   * download -- this is the machinery all four stood on.
   *
   * `models:inventory` and `models:remove-page-reader` went with them for a
   * smaller reason: they served the "Models on this machine" card, which Owen
   * deleted as unnecessary, and nothing else ever called either one.
   */

  // ── First run ────────────────────────────────────────────────────────────
  /*
   * THE WIZARD'S DOORS. Every one of them is also reachable from the settings
   * screen, which is the whole design: setup is the first-run ARRANGEMENT of
   * questions the app can already answer, not a separate mechanism. Nothing
   * below is exclusive to it.
   *
   * `system:probe` takes a force flag because the one case where the hardware
   * answer goes stale inside a process is somebody installing a GPU driver and
   * pressing Check again — see the cache argument in system-probe.ts.
   */
  ipcMain.handle('setup:state', () => setupState());
  ipcMain.handle('setup:finish', (_event, skipped: string[], prepare?: boolean) =>
    finishSetupFor(skipped, prepare));

  ipcMain.handle('system:probe', (_event, force?: boolean) => probeSystem(force === true));

  /*
   * ── TWELVE DOORS STOOD HERE: `ollama:*` AND `llm:*` ─────────────────────────
   *
   * Owen, 2026-09-15: *"we dont have any local models. crucible handles all
   * model orchestration. if theres no connected crucible server then tiles
   * should be disabled."* So there is no model for this app to name, no lineup
   * for it to offer, and nothing for it to pull:
   *
   *   `ollama:facts`, `ollama:choices`, `ollama:install`, `ollama:install-cancel`,
   *   `ollama:pull`, `ollama:pull-cancel`, the `ollama:progress` push, `llm:stored`,
   *   `llm:defaults`, `llm:set-model`, `llm:set-clean-model`, `llm:ollama-url` and
   *   `llm:set-ollama-url`.
   *
   * The MODEL a request names is the engine's capability record's `selected`
   * (crucible docs/PHASE15-HOST.md §3.3), applied at the spawn by the placement
   * (`doorArgs`, electron/job-queue.ts). A person choosing one in Foundry was
   * choosing something that was then ignored, which is the defect rather than
   * the feature. Where the text work runs IS still configurable from this app —
   * `crucible:engine-settings*` writes the ENGINE's own settings through
   * `PUT /v1/settings`, route and upstream per class, and that pass-through is
   * untouched. What went is Foundry keeping a model of its own.
   *
   * Ollama is still PROBED, by exactly one caller that is not a door:
   * `machine-models.ts`, which counts what is on this disk (docs/SLOTS.md §5b).
   */

  /*
   * ── THE SERVER REGISTRY AND THE SLOTS DERIVED FROM IT ─────────────────────
   *
   * docs/SLOTS.md §6 (Package C). Five doors, and the count is deliberately
   * small: the whole registry is written in one message (see
   * `writeCrucibleServers` for why add/remove/rename/reorder/enable cannot be
   * five doors onto an ordered array), and nothing here ever carries a token in
   * either direction. `crucible:settings` is the card's one read, and
   * `slots:list` is the same list on its own for the queue's picker, which has
   * no business knowing what a registry is.
   */
  ipcMain.handle('crucible:settings', () => crucibleSettingsView());
  ipcMain.handle('crucible:save', (_event, servers: CrucibleServerEdit[]) => saveCrucibleServers(servers));
  ipcMain.handle('crucible:test', (_event, name: string) => probeCrucible(name));
  /**
   * TEST AN ADDRESS AND A TOKEN THAT ARE NOT SAVED YET — the setup wizard's
   * Connect door, which has three boxes and no registry entry behind them.
   *
   * The token crosses this wire ONE WAY ONLY, into main, out of a box somebody
   * is typing in. It is used for one request and dropped; nothing stores it and
   * no answer carries it back (`CrucibleProbe` has no token field). That is the
   * same rule the registry keeps — see crucible-registry.ts's header.
   */
  /*
   * A SERVER'S OWN OPERATOR PAGE, opened by NAME so no credential crosses to
   * the renderer. The window it opens has no preload and cannot reach this
   * app (electron/crucible-ui.ts says why, at length). Named `crucible:open`
   * rather than BookForge's `crucible:open-ui`, so the two apps' channels stay
   * distinct in a vendored build.
   */
  ipcMain.handle('crucible:open', (_event, name: string) => { openCrucibleUi(name); });
  ipcMain.handle('crucible:test-at', (_event, url: string, token: string) =>
    probeCrucibleAt(url, token));
  /**
   * ADD ONE SERVER — the wizard's Add, through the registry's one writer.
   *
   * Answered with the whole settings view for `crucible:save`'s reason: adding a
   * loopback server changes the SLOTS, and a caller that redrew a list without
   * the slots would be showing a picker that is about to be wrong.
   */
  ipcMain.handle('crucible:add', (_event, name: string, url: string, token: string) =>
    addCrucibleServerDoor(name, url, token));
  ipcMain.handle('crucible:add-local', (_event, name: string) => addLocalCrucibleDoor(name));
  /*
   * ── PHASE15 §5.1's THREE WAYS IN, IN ITS ORDER ────────────────────────────
   *
   * 1. THE PAIRING FILE ON THIS MACHINE. Read once at start (electron/mount.ts)
   *    and again whenever somebody presses "Look again on this machine" — the
   *    same function, because the second press is for the case §3.6 names: the
   *    engine was installed AFTER this app started, so the answer that was
   *    honest at start ("there is nothing here") has stopped being true. It is a
   *    BUTTON and not a watcher on purpose: a filesystem watch on a directory
   *    Crucible's installer creates would have this app reacting to a file
   *    appearing mid-keystroke, and "press it when you have installed one" is a
   *    sentence a person can act on.
   */
  ipcMain.handle('crucible:add-from-pairing-file', () => adoptPairingFile());
  /*
   * 2. A PASTED CONNECT CODE, in three doors that all take THE LINE.
   *
   * The preview answers NAME AND ADDRESS ONLY (`ConnectCodePreview` argues the
   * shape at length): the renderer fills its two boxes from it so a person can
   * rename before adding, and the token never crosses the preload in either
   * direction. Test and Add re-read the same line in main. Three doors rather
   * than one for the reason `crucible:test-at` is not `crucible:add`: testing an
   * address in order to find out whether it is a Crucible must not write
   * anything, and previewing must not dial anybody at all — it runs on every
   * keystroke of a paste.
   */
  ipcMain.handle('crucible:parse-connect-code', (_event, line: string): ConnectCodePreview => parseConnectCode(line));
  ipcMain.handle('crucible:test-connect-code', (_event, line: string): Promise<CrucibleProbe> =>
    testConnectCode(line));
  /*
   * Add, through {@link registerPairing} — which is the SAME writer the pairing
   * file's road uses, because a pairing file is this line on disk and Owen's
   * ruling is that the two are *"entered the exact same way"*. The NAME is the
   * caller's: the preview filled a box with the code's own name and somebody may
   * have renamed it before pressing, and a door that re-read the name out of the
   * line would silently throw that away. An EMPTY name falls back to the code's,
   * which is what pressing Add on an untouched preview means.
   *
   * IT REJECTS BY NAME on a line that will not parse, rather than answering a
   * view: this is the door that WRITES, and everything that writes the registry
   * in this file rejects rather than returning a failed shape.
   *
   * AND IT COORDINATES, which it did not before this door and the pairing file's
   * shared one writer: PHASE14 §4a's moment is *a server being added*, and
   * `crucible:add` beside it has always taken that pass. A server added by
   * pasting a code was the one road into the registry that did not, which is a
   * card this app would then have found missing at the first job instead of now.
   */
  ipcMain.handle('crucible:add-connect-code', (_event, line: string, name: string) => addConnectCode(line, name));

  /*
   * ── THE ENGINE'S OWN SETTINGS — four doors onto somebody else's store ─────
   *
   * Wave 62 package I, to crucible `docs/PHASE15-HOST.md` §3.1, §3.2, §3.3 and
   * §5.2. Owen's ruling: the GPU engine is the SINGLE SOURCE OF TRUTH for AI
   * settings — *"If the user enters an anthropic api key, it should pass through
   * to crucible"* — so these four doors READ AND WRITE A REMOTE STORE and touch
   * `app-settings.json` not at all. §5.2: *"every control in these sections is a
   * request to the engine, and its result is the engine's answer re-read. There
   * is no Save button that writes an app file and syncs later."*
   *
   * THEY TAKE A SERVER NAME, not a url and not a token. That is the registry's
   * rule (`crucible:open`'s argument, one family up): the address and the
   * credential are looked up in main, so nothing the renderer holds could reach
   * an engine this app has not been told about.
   *
   * AND THE KEY CROSSES ONE WAY. `crucible:engine-settings-put` carries an
   * unsaved key inward and `crucible:engine-upstream-test` carries one inward to
   * be used once and dropped; no answer on any of the four carries a credential
   * back, because the document has `key_hint` — the last four characters — where
   * the engine has a key. Same rule, same sentence, as `CrucibleServerView`'s
   * `tokenSet` and `CloudProviderView`'s `keySet`.
   *
   * `engine-` RATHER THAN MORE BARE `crucible:` MEMBERS, because the family
   * already means "this app's registry of servers" and these are not about the
   * registry at all: they are about what ONE of those servers has been
   * configured to do. A reader of the channel list can tell the two apart.
   */
  ipcMain.handle('crucible:engine-settings', (_event, serverName: string) =>
    readEngineSettings(namedServerOr(serverName)));
  /**
   * WRITE THROUGH, AND REDRAW FROM THE ANSWER.
   *
   * The PUT answers the whole document after the write (§3.2), so this hands
   * that straight back and the card never guesses what took. A refusal arrives
   * as a REJECTION wearing a sentence that names the field
   * (electron/crucible-settings.ts composes it) — unlike Test there is nothing
   * to draw instead, because the write did not happen and what is on screen is
   * still true.
   *
   * ── AND A ROUTE WRITE MOVES THE TILES, SO THE REGISTRY PASS RUNS ──────────
   *
   * §2: capability *"is RECOMPUTED in-process on every settings write that
   * touches a route"*, and §3.3 says every capability row carries its route. So
   * the answer to "can this machine translate" has just changed on a server this
   * app has cached (`crucible-provider.ts` holds it for fifteen seconds) and the
   * dock's tiles are drawn from that. `afterRegistryChanged` is exactly the pass
   * that forgets, re-measures and re-composes — it is named for the registry
   * because that is what used to be the only thing that moved this answer, and a
   * route write moves it identically.
   *
   * ONLY WHEN A ROUTE WAS TOUCHED. Saving a key alone configures an upstream
   * nothing routes to yet: no capability row changes, and running the pass would
   * spend a probe per server to learn that.
   */
  ipcMain.handle('crucible:engine-settings-put', (
    _event,
    serverName: string,
    patch: SettingsPatch,
  ): Promise<SettingsDocument> => putEngineSettings(serverName, patch));
  /**
   * WHAT MODEL IDS THIS CREDENTIAL CAN USE — and it is the only list there is.
   *
   * §2: *"the server does not ship a cloud model list"*, and neither does this
   * app: the Cloud card already argued that a catalog compiled into a build is
   * wrong by the next release and confidently so. The engine asks the upstream's
   * own listing, unbilled, and the card shows THAT.
   *
   * `probe` IS THE UNSAVED CREDENTIAL, or absent for whatever is configured —
   * `crucible:test-at`'s argument one wire along: saving a key in order to find
   * out whether it works would be this app writing into somebody's engine to
   * answer a question. A failure is a RESULT, not a rejection, so the card can
   * print it beside the box.
   */
  ipcMain.handle('crucible:engine-upstream-test', (
    _event,
    serverName: string,
    upstream: UpstreamName,
    probe?: UpstreamProbe,
  ) => testUpstream(namedServerOr(serverName), upstream, probe));
  /**
   * THE CAPABILITY RECORD, BY SERVER NAME — the wizard's routes step, and the
   * one question it asks that the settings document cannot answer.
   *
   * §5.2: *"the wizard's AI step reads capability; for each llm class that is
   * `enabled: false` locally it says the class's reason and offers 'run it
   * through Anthropic / OpenAI / an Ollama server instead'."* The REASON is the
   * server's own sentence about why a class will not run on its card, and
   * nothing in `/v1/settings` carries it.
   *
   * IT IS `readCapability`, THE DISPATCHER'S OWN READER, and not a second one:
   * the shape of a capability record and the mapping of its refusals onto the
   * SDK's error types is exactly the kind of thing that is written twice and
   * then only fixed once (crucible-dispatch.ts says so where it exports it).
   */
  ipcMain.handle('crucible:engine-capability', (_event, serverName: string) =>
    readCapability(namedServerOr(serverName)));

  /**
   * WHICH ENGINE CAN DO THIS ACT — the first one that serves the class, or null.
   *
   * ── Why this is not `engine-capability` in a loop ─────────────────────────
   *
   * That door is a LIVE READ of one server (`readCapability` dials
   * `/v1/capability`), so asking it about every registered engine to find a
   * capable one would open a dialog by making N network calls, on a screen a
   * person is about to press a button on. This is the cached mirror the ACT
   * GATES already decide on — no traffic, already loopback-ranked, and the same
   * answer the tile in the dock is drawn from.
   *
   * ONE SOURCE FOR "WHO CAN DO THIS". A dialog that worked it out separately
   * would be a second opinion about the same question, and the two would
   * disagree the first time a probe lagged.
   */
  ipcMain.handle('crucible:serves', (_event, cls: ModelClass) => anyServerServing(cls));

  /**
   * WHAT A JOB'S MODEL DROPDOWN OFFERS, AND WHICH ROW IT OPENS ON (Owen,
   * 2026-10-25: *"put the option the user can pick in a dropdown on the modal
   * that configures the job"*). A LIVE READ of one server — its `models()` and
   * its upstream accounts' lists — because the dropdown is a person about to
   * choose, and the cached capability mirror `crucible:serves` reads holds
   * neither list. `server` is the dialog's pinned engine, or null for the
   * top-ranked one (`jobModelOffer`, electron/crucible-models.ts, says why).
   * A server that cannot be asked REJECTS with its own sentence.
   */
  ipcMain.handle('crucible:job-models', (_event, kind: JobModelKind, server: string | null) =>
    jobModelOffer(kind, server));
  /** The dialog's choice, remembered after its enqueue succeeded — `''` (Automatic) too. */
  ipcMain.handle('crucible:remember-job-model', (_event, kind: JobModelKind, value: string, server?: string) => {
    rememberJobModel(kind, value, typeof server === 'string' ? server : undefined);
  });

  /**
   * THE PROGRESS LIST FOR "INSTALL CRUCIBLE HERE", composed for this machine.
   *
   * A READ, and it changes nothing. It is no longer a sequence for a person to
   * perform: PHASE19 §3.1 makes it the rows the install fills in while it runs,
   * and §0 removed the one command that used to sit under the first of them.
   */
  ipcMain.handle('crucible:install-plan', () => crucibleInstallPlan());
  /*
   * THE SEAM, BUILT ONCE (electron/crucible-install-door.ts). It is the SDK's
   * `installStatus()` / `watchInstall()` / `POST /install` now; the pre-SDK
   * stopgap part 1 shipped is gone, and this one expression was the whole of
   * the swap.
   */
  const installDoor = crucibleInstallDoor();
  installDoor.watch((event) => broadcast('crucible:install-event', event));
  /**
   * THE DRIVEN INSTALL — and it refuses, today, by name.
   *
   * The button is disabled in the renderer with the same sentence this throws,
   * and the door refuses anyway: something reachable by an IPC message must
   * refuse at the door as well, or the disabling is a decoration (the Servers
   * card's hosted refusal makes the same argument). The refusal it still makes
   * is the HOSTED one — "Install Crucible from BookForge." — which PHASE19 §5
   * keeps by name; `@crucible/bootstrap` has been vendored since 1.0.0 and the
   * run itself is real.
   */
  ipcMain.handle('crucible:install', () => runInstallAndCoordinate(installDoor));
  /*
   * ── THE INSTALL DOOR'S THREE READS, PHASE19 §2.6 ──────────────────────────
   *
   * `status` and `event` used to be one thing — a string per line, pushed to
   * the window that pressed the button, gone the moment that window looked
   * away. §2.6 splits them because the move outlives the press: the tray runs
   * it, a restart happens in the middle, and the app that comes back has to be
   * able to ASK where it got to rather than only to have been listening.
   *
   * The watch is BROADCAST and not sent to the pressing window: a person who
   * opens Settings while the wizard is installing is looking at the same one
   * machine, and a second window drawing an empty list would be this app
   * pretending the install belongs to a window.
   */
  /*
   * AND THE ASK IS ALSO THE ATTACH.
   *
   * §2.3 put the move's start in the tray, so the ordinary running move is one
   * no window pressed a button for — and until 2026-09-19 a window that opened
   * onto one read `running: true` here and then sat under five waiting rows,
   * because `watch` fans out events this process was never being sent. Asking
   * where the move got to and joining its stream are the same question, so
   * they are the same call: the door replays its ring and the rows fill in.
   *
   * It is idempotent and it never starts anything (see `attach`), so the
   * second window to open costs the tray one question and nothing else.
   */
  ipcMain.handle('crucible:install-status', async () => {
    const answered = await installDoor.status();
    if (answered.running) installDoor.attach();
    return answered;
  });
  ipcMain.handle('crucible:install-retry', () => runInstallAndCoordinate(installDoor, installDoor.retry));
  /**
   * RESTART NOW — §2.3, and it is the only thing in Foundry that reboots a
   * machine.
   *
   * `shutdown.exe /r /t 5` AS THE INTERACTIVE USER: no elevation, because
   * restarting your own session needs none, and the five seconds are what let
   * somebody see the window acknowledge the press. It runs ONLY when pressed —
   * §2.3 is explicit that "the reboot is never taken by Crucible", and this
   * door is a person's press crossing the preload, never a consequence of
   * reading an outcome.
   *
   * `detached` and `unref` because Electron is about to be killed by the very
   * process it spawned; a child still parented to a dying main is a race with
   * nothing to win.
   */
  ipcMain.handle('crucible:restart-windows', () => restartWindows());
  /*
   * ── UNINSTALL: THREE DOORS, AND THE FIRST ONE DECIDES THE OTHER TWO ───────
   *
   * crucible `docs/INSTALL-UNINSTALL.md` §6.1, and Owen's ruling with it: the
   * door is drawn only for a server this app can PROVE is this machine's, and
   * never for a registry entry as such. `crucible:uninstall-availability` is
   * that one proof — the card asks it before it draws a button and both doors
   * below refuse on it as well, because a control that is hidden over a door
   * that is open has been decorated rather than locked.
   *
   * Everything about what is invoked, and why win32 needs `cmd.exe` to run a
   * `.cmd`, is in electron/crucible-uninstall.ts. Nothing about it is composed
   * here; these three are a read and two runs.
   */
  ipcMain.handle('crucible:uninstall-availability', () => crucibleUninstallAvailability());
  /**
   * THE PLAN, UNPERFORMED — §6.4 step 1, and the card re-asks it every time a
   * checkbox moves so the kept-weights headline moves with it.
   *
   * An exit code of 1 is still a plan (§6.2): the JSON's `ok: false` names the
   * one step that failed and the others happened. Only a usage error and a
   * document that is not a document are rejections — see the module.
   */
  ipcMain.handle('crucible:uninstall-dry-run', (
    _event,
    flags: CrucibleUninstallFlags,
  ): Promise<CrucibleUninstallPlan> => crucibleUninstallDryRun(flags));
  /**
   * THE REAL RUN, and the one thing Foundry does afterwards that the verb cannot.
   *
   * §2's box: *"THE TOKEN ALWAYS GOES, on every uninstall, including the default
   * one."* So a run that stopped the engine has left the registry row pointing at
   * it holding a dead credential, and the row goes — through the registry's one
   * writer, followed by `afterRegistryChanged`, which is what every other write
   * in this file does and what keeps the dock's gates and the slot list honest.
   *
   * ONLY WHEN THE PROOF NAMED A ROW. A `windows-host` proof says a host is
   * installed on this computer and says nothing about which entry, if any, points
   * at the engine it drives; removing a row on that basis would be the app
   * guessing at exactly the thing §6.1 forbids guessing at.
   *
   * COORDINATION STATE IS LEFT TO THE NEXT CONNECT, deliberately. The map in
   * crucible-coordinate.ts is keyed by registry name, the Servers card looks a
   * row's state up BY the row's name, and there is no row any more — so the
   * stale entry draws nothing anywhere. Registering a server under that name
   * again coordinates afresh and overwrites it. Clearing it would mean a new
   * export from that module for an entry nobody can see.
   */
  ipcMain.handle('crucible:uninstall', (
    _event,
    flags: CrucibleUninstallFlags,
  ): Promise<CrucibleUninstallRun> => uninstallCrucible(flags));
  ipcMain.handle('crucible:set-wsl-distro', (_event, distro: string) =>
    writeAppSettings({ wslDistro: distro }).wslDistro);
  /**
   * THE LIVE QUEUE'S DIAL — Owen's *"global crucible server option"*.
   *
   * ANY NAME IS ACCEPTED, including one no server currently answers to, and the
   * clamp is the only thing between the argument and the file. That is the same
   * decision BookForge took and for the reason they gave: a dial pointing at a
   * machine somebody has switched off must KEEP its value, or turning a server
   * off would silently re-point the queue at a different one. "Switched off",
   * "renamed" and "never existed" are one state to a settings writer, and the
   * PLACEMENT is where they are told apart and said out loud.
   *
   * The pump is woken because a dial that has just been widened is a dial that
   * may have unparked something, and a board that has gone quiet would otherwise
   * sit on that row until somebody pressed something else.
   */
  /**
   * IS THERE A CRUCIBLE HERE THAT IS NOT RUNNING, AND SHALL WE START IT?
   *
   * Owen, 2026-09-15 (relayed): *"the foundry app should ask if they want to
   * start crucible."* Standalone only — `crucibleRunState` answers `not-ours`
   * hosted, and that becomes `answered: 'later'` below, so the vendored copy
   * inside BookForge draws no card. BookForge has already offered by the time
   * anybody reaches Foundry there.
   *
   * ANSWERED RATHER THAN ASKED IS THE ORDINARY CASE, and it is why this is a
   * question door rather than a state read the renderer branches on: running,
   * absent, unhealthy and hosted all resolve without a card, so nothing flickers
   * on the startups where there is nothing to say.
   *
   * ── THE THREE ANSWERS, AND WHY SILENCE IS ONE OF THEM ───────────────────
   *
   * Owen met the old version of this door on 2026-09-17 with a perfectly healthy
   * engine and was told to repair his installation, because every state that was
   * not `running`, `stopped` or `absent` came through as one word and drew one
   * card. electron/crucible-start.ts carries the full account of what had really
   * happened — a three-second timeout on `/v1/info` — and why the fold is gone.
   * What is left here is the consequence:
   *
   *   * `stopped` and `unreachable` compose the OFFER. Something is installed
   *     and nothing is serving, and the press is the repair.
   *   * `unhealthy` composes NOTHING. It answered its ping, so there is nothing
   *     to start; and the Servers card watches that machine continuously, so a
   *     card here would be a second, worse voice on a question already covered.
   *     It is logged, because somebody reporting "it feels slow" deserves to
   *     have this line in the file.
   *   * `problem` composes the alarm — and now only ever over a fault in the
   *     installation, in that fault's own words rather than in a sentence that
   *     names two possibilities and then an action fitting one of them.
   *
   * THE CARD NAMES THE MANAGED SERVICE, NOT A ONE-OFF RUN, because the thing a
   * person is agreeing to is something that stays up after Foundry closes, which
   * is a different promise from "run this once" and one they should make
   * knowingly.
   */
  ipcMain.handle('crucible:offer-start', (): Promise<Asked<'start' | 'later'>> => offerCrucibleStart());
  /**
   * THE PRESS. Answered with a SENTENCE and never with a throw: every way this
   * can end — started, launched-but-still-coming-up, nothing here to start — is
   * a fact somebody should read, and a rejected invoke would arrive at the
   * renderer as an unhandled error with the interesting half missing.
   */
  ipcMain.handle('crucible:start', () => startCrucibleAndConnect());
  /**
   * WHAT THIS ENGINE HOLDS AND COULD HOLD — `GET /v1/catalog`, mapped.
   *
   * A READ AND NOTHING ELSE: it downloads nothing, loads nothing onto a card,
   * and is safe against a machine somebody is using. The card calls it on open
   * and after a pull lands, which is when the answer changes.
   */
  ipcMain.handle('crucible:catalog', (_event, server: string) => engineCatalog(server));
  /**
   * FETCH ONE SUBJECT. Answered with the TASK ID, not with the finished pull.
   *
   * A model is gigabytes over somebody's line, so the progress arrives on
   * `crucible:pull-progress` afterwards rather than this handler holding a
   * promise for an hour — a renderer cannot even be told about one that long.
   * Every frame carries the server, the kind and the id, so a card with two
   * pulls running places them without keeping a map of its own.
   */
  ipcMain.handle('crucible:pull', (_event, server: string, kind: string, id: string) =>
    pullSubject(server, kind, id, (progress) => {
      broadcast('crucible:pull-progress', progress);
    }));
  /**
   * ARE YOU SURE — composed in MAIN, because main is what knows the size.
   *
   * The SDK's condition on the remove door survives Owen's reversal of who may
   * call it: *"An app does not call this on a user's behalf without saying so on
   * screen."* So the press goes through the same card every destructive question
   * in this app uses, and the card is given the FIGURE — a person deciding
   * whether to free 17.3 GB is deciding something different from a person told
   * only that a file will go.
   *
   * `keep` is the dismissal, and it is the safe half: a question nobody answered
   * has not been agreed to.
   */
  ipcMain.handle(
    'crucible:confirm-remove-model',
    (_event, ask: { server: string; id: string; name: string | null; bytes: number | null }):
    Asked<'remove' | 'keep'> => confirmRemoveModel(ask),
  );
  /**
   * AND THE REMOVAL ITSELF. The server's four refusals arrive as they are —
   * `subject_in_use` naming what holds it is a different thing to do about it
   * than `subject_remove_failed` naming a file that would not go.
   */
  ipcMain.handle('crucible:remove-model', (_event, server: string, kind: string, id: string) =>
    removeModel(server, kind, id));
  ipcMain.handle('crucible:set-queue-gpu-dial', (_event, dial: string) => {
    const stored = writeAppSettings({ queueGpuDial: dial }).queueGpuDial;
    queue.venueRulesChanged();
    return stored;
  });
  ipcMain.handle('crucible:set-new-jobs-wait-for', (_event, choice: NewJobsWaitFor) =>
    writeAppSettings({ newJobsWaitFor: choice }).newJobsWaitFor);
  /*
   * ── COORDINATION: THE BUTTON THAT IS NOT THERE ────────────────────────────
   *
   * crucible `docs/PHASE14-ENVPACKS.md` §4a. There is no "set up this server
   * for Foundry" verb and no consent step: presence of the app is the request,
   * so Foundry coordinates with every enabled server it connects to and a
   * screen only ever READS the state. `electron/crucible-coordinate.ts` is the
   * one owner — these two doors start a run and read the map, and neither
   * composes a sentence, because the words are the renderer's
   * (`src/app/core/crucible-words.ts`; R1).
   */
  ipcMain.handle('crucible:coordination', () => coordinationStates());
  /**
   * Coordinate with one named server NOW, and answer the state it reached.
   *
   * Idempotent and concurrency-safe in `crucible-coordinate.ts`: a second call
   * while one is in flight joins the first. So the start sweep and a card that
   * asks about the same server a moment later are ONE run, not two — which is
   * the `task_busy` this whole design exists to avoid, manufactured by us.
   *
   * IT IS A DOOR AND NOT A BUTTON. Nothing in this app draws a control that
   * calls it; it exists so a screen that has just learnt about a server can ask
   * about that server rather than waiting for a push that has already been sent.
   */
  ipcMain.handle('crucible:coordinate', (_event, name: string) => coordinateServer(name));
  /*
   * ── THE CLOUD PROVIDERS — Package F's app half (docs/SLOTS.md §3) ─────────
   *
   * THREE DOORS, and a family of their own rather than three more members of
   * `crucible:`. That is this app's own advice taken twice over. Once because a
   * provider IS NOT A CRUCIBLE: it has no capability record, nothing resident,
   * no lease and no busy state, and a card reading `crucible:save` to write an
   * OpenAI key would teach that they are one kind of thing. And once because
   * `crucible:` is a family BookForge does not have and `cloud:` is one neither
   * side has — the cheapest possible answer to the collision audit that is still
   * open (docs/IPC-CHANNELS.md).
   *
   * NO KEY CROSSES IN THE ANSWER DIRECTION, ever. The renderer is told
   * `CloudProviderView.keySet` and may send a new key, which is the whole of
   * what a write-only field means — `crucible:`'s token rule, one registry
   * along.
   */
  ipcMain.handle('cloud:settings', () => cloudSettingsView());
  ipcMain.handle('cloud:save', (_event, providers: CloudProviderEdit[]) => saveCloudProviders(providers));
  /**
   * TEST — the model listing at the provider, and whether the chosen id is in it.
   *
   * IT TAKES THE WHOLE EDIT, unsaved, which is `crucible:test-at`'s argument for
   * a card that has only one Test button: somebody pastes a key and types a
   * model and wants to know whether the pair is right BEFORE it is written to
   * disk, and saving first in order to find out would be this app writing a
   * credential into somebody's settings to answer a question. A key on this wire
   * goes ONE WAY, into main, out of a box somebody is typing in; `apiKey: null`
   * means "the one already stored for this name", and no answer carries either.
   */
  ipcMain.handle('cloud:test', (_event, provider: CloudProviderEdit) => probeCloud(provider));

  /**
   * WHERE WORK MAY GO, for the picker.
   *
   * Its own door rather than a field on `crucible:settings` because the two have
   * different readers and different lifetimes: the settings card reads a picture
   * of a registry it is about to edit, and the queue reads a list of names to
   * draw beside rows. A queue page that had to ask for the registry in order to
   * draw a picker would be a page that needs the token flag and the WSL distro
   * to render a dropdown.
   */
  /*
   * THE LIST AND, WHEN THERE IS ONE, WHY IT IS EMPTY. A bare array told the
   * page "no servers" when the truth could be "there was nobody to ask" — a
   * hosted window whose host has not implemented the registry seam. The two
   * want different sentences, so the answer is typed (`SlotAvailability`,
   * shared/slots.ts) and the picker draws the refusal where the slots would be.
   */
  ipcMain.handle('slots:list', () => slotAvailability());
  /**
   * EVERY ROW OF OURS THAT NAMES THIS SLOT — what the Servers card shows before
   * it offers to move any of them. Owen's rule: told, never moved silently.
   */
  ipcMain.handle('slots:rows-waiting-for', (_event, name: string) =>
    queue.rowsWaitingFor(name));

  // ── What this machine may be asked to do, and what it holds ──────────────
  /*
   * THE TILE GATE, AND IT IS ONE DOOR FOR ALL FIVE ACTS.
   *
   * Owen, 2026-09-15: *"if theres no connected crucible server then tiles should
   * be disabled."* Every fact that decides it lives here — the server registry's
   * capability reads, the cloud providers, the settings file and the page
   * reader's directory — so the answer is composed in main and the renderer draws
   * it. Five acts in one call because they come off ONE snapshot, and a dock
   * asking separately could light Translate beside a Simplify that had just gone
   * dark. The stage gate (shared/stages.ts) is unchanged and still the
   * renderer's: that one is about the book, this one is about the venue.
   */
  ipcMain.handle('acts:gates', () => actGates());

  /*
   * WEIGHTS ON THIS DISK — docs/SLOTS.md §5b's "Models on this machine".
   *
   * The removal is the only door in this app that deletes model files, and it
   * deletes exactly one directory: the one this app downloaded into. Ollama's
   * store is listed beside it and never touched (Owen: *"ollama has its own
   * thing going on and we should leave it be"*), and a local Crucible's line
   * waits on package C. A refusal comes back as a RESULT with a sentence rather
   * than as a rejection, because the row prints what happened either way.
   */
  /*
   * The whole list on every mutation — and hosted, the whole list is the HOST's
   * (`shelfJobs`, electron/job-queue.ts). The queue hands it over already
   * composed rather than this line choosing, so the door above and this push
   * cannot answer differently.
   */
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
  // The same shape one door along: main talks while the invoke is still open,
  // because an intake of a whole shoot is a minute long and a promise that
  // resolves at the end cannot say anything until there is nothing to say.
  onIntakeProgress((progress) => broadcast('capture:intake-progress', progress));

  /*
   * ── DOCS/SLOTS.MD §5b, ONCE AT STARTUP ────────────────────────────────────
   *
   * For the machine where the Crucible was installed while Foundry was closed.
   * `afterRegistryChanged` covers somebody registering the local server while
   * the app is open; neither is the whole of it alone, because a person who runs
   * `crucible install llm` in a terminal and reopens Foundry has changed nothing
   * this app was watching, and their disk is still holding four gigabytes of a
   * page reader the machine no longer needs.
   *
   * IT CANNOT FIRE HOSTED, AND NOT BY A GUARD. Inside BookForge the slot list is
   * the HOST's (SLOTS.md §3) and `AppSettings.crucibleServers` is empty, so
   * `localCrucibleServes` answers `unknown` — which is not a permission to
   * delete. That is the three-valued answer doing the work it was shaped for,
   * rather than a `hosted()` check that would have to be kept in step with a
   * rule written somewhere else.
   *
   * DELIBERATELY NOT AWAITED: it probes every registered server, and blocking
   * the mount on a sleeping Mac would put a three-second stall in front of the
   * first window for a tidy-up nobody is waiting on. A failure is logged and
   * changes nothing — the files stay, and the next registry save asks again.
   */
  /*
   * ── EVERY COORDINATION STATE CHANGE, TO EVERY WINDOW ──────────────────────
   *
   * And that is not laziness about addressing: coordination starts at APP
   * START, before any window has asked for anything, and it is the same fact
   * for the Servers card and for the wizard's Crucible step. A push aimed at
   * "the sender" would have no sender for the run that matters most.
   *
   * THE SECOND HALF IS THE ONE THAT MATTERS TO THE REST OF THE APP. A run that
   * ends `preparing` with `progress.state === 'done'` means the server SERVES
   * MORE THAN IT DID — a text engine it had not installed, a model it had not
   * pulled — and every capability answer this app has cached about it was
   * measured before that. So the registry's own pass runs: forget, re-measure,
   * apply §5b's page-reader rule, light the tiles. Wired HERE rather than
   * inside the coordinate module for the reason its header gives — which
   * windows exist and what an install does to a tile are facts about the app,
   * and that module's whole subject is one conversation with one server.
   *
   * ONLY ON `done`. A `failed` module leaves behind exactly the steps that
   * completed (R6), which is a real change, and re-measuring on it would be
   * right — but a module that failed at step 1 of 4 is also the common case for
   * a server that is mid-something, and a capability sweep per failure would
   * put a probe of every registered machine behind every stumble. The next
   * connect asks again, which is the same answer arriving a moment later.
   */
  onCoordination((state) => {
    broadcast('crucible:coordination-changed', state);
    if (state.phase !== 'preparing' || state.progress.state !== 'done') return;
    void afterRegistryChanged().catch((err: unknown) => {
      console.error(
        `[crucible] "${state.server}" finished preparing, but the capability sweep that `
        + `follows it did not: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  sweepAtStartup();
}
