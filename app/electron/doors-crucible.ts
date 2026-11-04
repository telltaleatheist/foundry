/**
 * doors-crucible — the server registry's writes and everything that follows from one; pairing, install, start.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */
import { spawn } from 'node:child_process';

import { TERMINAL_OUTCOME_STATES } from '@crucible/bootstrap';
import { type Pairing } from '@crucible/client';

import {
  clampCrucibleUrl,
  sameCrucibleAddress,
  readAppSettings,
  writeAppSettings,
  type CrucibleServerEntry,
} from './app-settings';
import { writeCloudProviders } from './cloud-providers';
import {
  coordinateEveryServer, coordinateServer
} from './crucible-coordinate';
import {
  addCrucibleServer,
  addLocalCrucible,
  cloudSettingsView,
  crucibleServers,
  crucibleServerViews,
  crucibleServerNamed,
  crucibleSettingsView, forgetEngineTargets, probeCrucibleAt,
  removeCrucibleServer,
  writeCrucibleServers
} from './crucible-registry';
import { writeEngineSettings } from './crucible-settings';
import { crucibleFaultWords, crucibleRunState, startCrucible } from './crucible-start';
import type {
  SettingsDocument,
  SettingsPatch
} from '../shared/engine-settings';
import { runInstallNarrated, type CrucibleInstallDoor } from './crucible-install-door';
import {
  crucibleUninstallAvailability, crucibleUninstallPerform,
  uninstallStoppedTheEngine
} from './crucible-uninstall';
import type {
  CrucibleUninstallFlags, CrucibleUninstallRun
} from '../shared/uninstall-wire';
import { pairingFileRead, readConnectCode } from './crucible-pairing';
import { forgetCrucibleFacts, refreshCrucibleFacts } from './crucible-provider';
import {
  tidySlotName,
  type CloudProviderEdit,
  type ConnectCodePreview,
  type CrucibleProbe,
  type CrucibleServerEdit,
  type LocalCrucibleAdd
} from '../shared/slots';
import { hosted } from './host';
import { broadcast } from './platform';
import type {
  Asked
} from '../shared/types';

/**
 * SOMETHING THAT DECIDES A TILE MOVED. Say so; say nothing about what.
 *
 * The dock's gates are composed in main off three facts (act-gates.ts), and every
 * one of them is changed by a door in this file: the SERVER REGISTRY, whose
 * capability reads are the only thing that lights a text tile (`afterRegistryChanged`
 * below is that door), the page reader's directory, and the settings file. The
 * hardware probe and Ollama's library were two more until 2026-09-15, and both
 * described a machine that does not run the work.
 *
 * Without this push a person would connect an engine and watch Translate stay gray
 * until they restarted the app — which is the exact failure Owen's rule was written
 * to prevent, arriving from the other direction.
 *
 * NO PAYLOAD, on `projects:changed`'s reasoning. The gates are one composed
 * answer and composing them costs a probe, so this says only that the machine
 * moved and the renderer asks again through `acts:gates`. Pushing the shape
 * would give the app two writers of it, and the pushed copy would be the one
 * that goes stale.
 */
export function gatesChanged(): void {
  broadcast('acts:gates-changed', null);
}

/**
 * THE REGISTERED SERVER OF THAT NAME, or a rejection that says the name.
 *
 * The four `crucible:engine-*` doors take a NAME, and the address and the token
 * behind it are looked up here — `crucible:open`'s rule, so nothing a renderer
 * holds could send a key to an engine this app has not been told about.
 *
 * IT THROWS RATHER THAN ANSWERING NULL. A card drew that row a moment ago, so a
 * missing name means the registry moved underneath it (another window saved, or
 * the host's list changed hosted); "there is no server called X" is the honest
 * sentence and the card's next read redraws the list.
 */
export function namedServerOr(serverName: string): CrucibleServerEntry {
  const entry = crucibleServerNamed(serverName);
  if (entry === null) throw new Error(`there is no registered server called ${serverName}`);
  return entry;
}

/**
 * THE REGISTRY CHANGED — everything that follows from that, in one place.
 *
 * Adding, enabling, renaming or removing a server moves three things at once and
 * they have to move in this order:
 *
 *   1. FORGET the cached capability answers. They were measured against the old
 *      list and every one of them may now be wrong; a fifteen-second stale
 *      window after a deliberate press is the one case a person reads as the app
 *      ignoring them (`crucible-provider.ts`).
 *   2. MEASURE again, so the deletion below is decided on what the servers say
 *      NOW rather than on a silence that has not been broken yet. `unknown` is
 *      not a permission to delete, so skipping this would simply mean nothing
 *      happens — which is safe and is also not what somebody who just registered
 *      their local Crucible is expecting to see.
 *   3. APPLY docs/SLOTS.md §5b: if a LOCAL Crucible now serves `pages`, Foundry's
 *      own copy of the page reader is a duplicate and goes, out loud.
 *
 * THE REMOVAL IS ANNOUNCED TWICE OVER, on purpose. `acts:gates-changed` moves
 * the OCR tile's sentence, and `models:changed` moves the two cards that draw
 * the files themselves — they are different questions with different readers,
 * and one push doing both would be a card re-reading an inventory because a
 * tooltip changed.
 */
export async function afterRegistryChanged(): Promise<void> {
  /*
   * THE RESOLVED HOPS GO FIRST, AND BEFORE THE CAPABILITY ANSWERS, because the
   * capability read is made THROUGH one (crucible docs/PHASE17-ORCHESTRATOR.md
   * §6, `engineClientFor`). Re-pointing an entry from a tray to its engine — or
   * the other way — changes which process every later read reaches, and a
   * refresh that ran against a remembered hop would fill the capability cache
   * from the machine the person has just stopped naming.
   */
  forgetEngineTargets();
  forgetCrucibleFacts();
  await refreshCrucibleFacts();
  /*
   * THE AUTOMATIC REMOVAL WENT WITH THE THING IT REMOVED. SLOTS.md 5b had a
   * Crucible on this machine take over page reading, at which point Foundry
   * deleted its own copy of the reader and printed a receipt. Foundry has no
   * copy of anything to delete (2026-09-17), so the gates are still re-read --
   * a registry change moves the OCR tile -- and nothing is swept.
   */
  gatesChanged();
}

/**
 * COORDINATE WITH A SERVER BECAUSE SOMETHING CONNECTED US TO IT.
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a: every time Foundry finds a Crucible
 * it makes sure that Crucible has what Foundry needs — nobody presses anything.
 * The moments are app start (every enabled server), a server being added, and a
 * server being switched back on or newly named by a registry save; all of them
 * go through `crucible-coordinate.ts`'s one function, which is also what makes
 * two of them arriving together ONE run.
 *
 * A FAILED COORDINATION NEVER FAILS THE ACT THAT TRIGGERED IT. The server was
 * added, the switch was flipped; what did not happen is a conversation with a
 * machine, and that is the coordination STATE's to say, in the row. So this
 * catches everything and logs ONE line — and `coordinateServer` is already
 * written never to throw, which makes this the belt to that braces rather than
 * the place the outcome is decided.
 */
export async function coordinateWithServer(name: string, because: string): Promise<void> {
  try {
    const state = await coordinateServer(name);
    console.log(`[crucible] "${name}" coordinated ${because}: ${state.phase}`);
  } catch (err) {
    console.error(
      `[crucible] could not coordinate with "${name}" ${because}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * WHICH SERVERS A REGISTRY SAVE CONNECTED US TO — new by name, or switched on.
 *
 * `crucible:save` replaces the whole list in one message (see
 * `writeCrucibleServers` for why it is one door), so "what just changed" is a
 * DIFF and there is nowhere else to take it from. Two answers count as a
 * connection and the rest do not:
 *
 *   - a name the registry did not have before is a server this app has just met;
 *   - `enabled` going false → true is the exact reverse of the one gesture that
 *     means "not that one" (Owen, 2026-09-14), so switching it back on is the
 *     moment to find out what it is missing.
 *
 * A RENAMED, RE-ADDRESSED OR RE-TOKENED ROW IS NOT IN THIS LIST unless its name
 * is new, and that is the honest reading of a card that saves on every edit: a
 * person dragging rows around has connected to nothing, and coordinating with
 * six servers because one of them moved up the order would be this app spending
 * somebody's afternoon on a reorder.
 */
function serversConnectedBySave(
  before: readonly { name: string; enabled: boolean }[],
  after: readonly { name: string; enabled: boolean }[],
): string[] {
  const was = new Map(before.map((entry) => [entry.name.toLowerCase(), entry.enabled]));
  return after
    .filter((entry) => {
      if (!entry.enabled) return false;
      const previously = was.get(entry.name.toLowerCase());
      return previously === undefined || previously === false;
    })
    .map((entry) => entry.name);
}

/**
 * THE FIRST OF PHASE15 §5.1's THREE WAYS IN: the connect code a Crucible left on
 * this machine, read and registered under THE NAME THE LINE CARRIES, with nobody
 * typing anything.
 *
 * ── Why it is here and not in crucible-pairing.ts ───────────────────────────
 *
 * Because it WRITES THE REGISTRY, and everything that writes the registry ends
 * in `afterRegistryChanged` above — forget the capability answers, measure
 * again, apply docs/SLOTS.md §5b — which is this module's and deliberately
 * private to it. A second caller that wrote an entry and did not take that pass
 * would leave a registered engine behind gates that still say there is none, and
 * that is the exact failure the pass was written for. crucible-pairing.ts reads
 * a file; this decides what the app does about what it read.
 *
 * ── THERE IS NO RESERVED NAME. THE LINE NAMES THE SERVER ────────────────────
 *
 * This used to register the entry as `local`, and the doc-comment here used to
 * justify that word as parity with BookForge. Owen's ruling ends both halves:
 * *"it shouldnt be named 'local' anywhere. it might not be local. a local
 * crucible server shouldnt be treated any differently than a remote crucible
 * server. it should all be entered the exact same way… bookforge shouldnt even
 * know if it's local because it doesnt mater."* BookForge deleted its own
 * reserved identity (their `24b7bf67`), so there is nothing left to be in parity
 * with either.
 *
 * What replaces it was already in the line. A pairing file IS A CONNECT CODE the
 * machine left on disk — same spelling, same `parsePairing`, same `{name, url,
 * token}` — so this registers it EXACTLY as a pasted one is registered, through
 * {@link registerPairing}, which is the one writer both doors share. The name is
 * the server's own (`crucible@example-pc-wsl`, whatever the operator called it),
 * which is the same name a person would see in the preview if they pasted the
 * line by hand.
 *
 * RE-READING STILL FIXES A ROTATED TOKEN rather than growing a second row:
 * `addCrucibleServer` replaces an existing NAME in place, keeping its rank and
 * its enabled state, and the name is stable because it comes out of the line.
 *
 * ── IT DECLINES WHEN THIS URL IS ALREADY REGISTERED ─────────────────────────
 *
 * Not when ANY loopback entry is — that was the same "local is special"
 * assumption one layer down, and wrong on its own terms: somebody with a tailnet
 * Crucible registered AND a pairing file on disk got neither, because the
 * tailnet row's address happened to be loopback. The question actually being
 * asked is "do I already have THIS server", so the test is the clamped URL
 * against the registry's, which is name-free and locality-free. It is also
 * `addLocalCrucible`'s test (crucible-registry.ts), which has keyed on the URL
 * all along.
 *
 * ── HOSTED, THE REGISTRY IS THE HOST'S AND THIS DOES NOTHING ────────────────
 *
 * Refused at the door as well as skipped at the call, because `addCrucibleServer`
 * throws hosted (`refuseHostedRegistryChange`) and an unguarded startup call
 * would put that throw in a console every time BookForge opened the window.
 *
 * ── WHAT THE FILE NAMES IS WHAT IS REGISTERED, EVEN IF IT IS A TRAY ─────────
 *
 * crucible docs/PHASE17-ORCHESTRATOR.md §6: *"the pairing line an app reads is
 * the ENGINE's"* — on Windows the orchestrator writes the guest's line verbatim
 * — so this ordinarily registers an engine and the hop below never fires. When
 * a line names an ORCHESTRATOR anyway, registering it is still CORRECT and is
 * left alone: `resolveEngine` (crucible-registry.ts) follows the hop for every
 * call that does work, and the one door that does not is the console button,
 * which should open the process the person's machine actually named (see
 * `openCrucibleUi`, which argues it). Rewriting the address here would be this
 * app storing a fact it derived over the fact the machine stated.
 */
export async function adoptPairingFile(): Promise<LocalCrucibleAdd> {
  if (hosted()) {
    return {
      outcome: 'failed',
      code: 'no_local_config',
      message: 'The servers are the host application\'s while Foundry is running inside it.',
    };
  }
  const read = await pairingFileRead();
  if (read.found === 'absent') {
    // Debug volume, one line, and the SAME sentence the button shows — see
    // crucible-pairing.ts: an absent file is a fact about this machine.
    console.log(`[pairing] no pairing file at ${read.path} — nothing has left a code here.`);
    return {
      outcome: 'failed',
      code: 'no_local_config',
      message: `No Crucible has left a connect code on this machine (${read.path}). `
        + 'Install one here, or connect to one somewhere else.',
    };
  }
  if (read.found === 'refused') {
    console.error(`[pairing] refused: ${read.message}`);
    return { outcome: 'failed', code: 'config_unreadable', message: read.message };
  }
  /*
   * THE ADDRESS DECIDES, NOT THE ADDRESS'S SHAPE. Clamped first because that is
   * what the registry stored its own rows through, then compared with
   * `sameCrucibleAddress` — the registry's one duplicate rule, which also
   * settles host case and a default port.
   *
   * IT MUST BE THE SAME RULE THE WRITER USES, and that is not tidiness. Since
   * the writer began refusing a duplicate address, a check here that was even
   * slightly narrower would let a line through to `registerPairing` that the
   * writer then THREW on — turning this function's clean "already registered,
   * nothing to do" into a caught `config_unreadable`, on the startup path, on
   * every launch. The two rules being one is what keeps that unreachable.
   */
  const url = clampCrucibleUrl(read.pairing.url);
  const already = crucibleServers().find(
    (entry) => url !== null && sameCrucibleAddress(entry.url, url),
  );
  if (already !== undefined) {
    return {
      outcome: 'failed',
      code: 'already_registered',
      message: `${read.pairing.url} is already registered as "${already.name}".`,
    };
  }
  /*
   * A LINE THE REGISTRY WILL NOT TAKE IS A FACT, NOT A CRASH. `registerPairing`
   * goes through the one writer, which refuses BY NAME — a name with a `:` in
   * it, an address that is not http(s) — and this is the one road nobody
   * pressed: mount.ts calls it at startup and does not await it, on the stated
   * contract that it *"cannot reject"*. So the refusal is caught and worn as the
   * third outcome the type already has, which is also the sentence the "Look
   * again" button shows.
   */
  let name: string;
  try {
    name = registerPairing(read.pairing, '');
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    console.error(`[pairing] ${read.path} could not be registered: ${said}`);
    return {
      outcome: 'failed',
      code: 'config_unreadable',
      message: `${read.path} names a server this app cannot store: ${said}`,
    };
  }
  await afterRegistryChanged();
  console.log(`[pairing] registered "${name}" at ${read.pairing.url} from ${read.path}.`);
  // A server this app has just met, by the same rule as `crucible:add`:
  // finding it is the request (PHASE14 §4a), so it is coordinated with now.
  void coordinateWithServer(name, 'it was found in the pairing file');
  return {
    outcome: 'added',
    servers: crucibleServerViews(),
    serverName: name,
    url: read.pairing.url,
    configPath: read.path,
  };
}

/**
 * THE ENGINE ON THIS MACHINE, CONNECTED WITHOUT ANYBODY BEING ASKED.
 *
 * Owen, 2026-09-15, on opening the wizard to three doors over a Crucible that
 * was already running here: *"this should be idiot proof. it should check to
 * see if a server is installed here. if it is, it just connects. seamlessly…
 * it shouldnt talk about crucible unless it needs to, or to ask the user to add
 * a crucible server."*
 *
 * ── WHY TWO READS AND NOT ONE ─────────────────────────────────────────────
 *
 * There are two files a Crucible on this machine may have left, and which one
 * exists is not something a person should have to know:
 *
 *   * `<CRUCIBLE_HOME>/pairing` — the connect code, written by the installer.
 *     {@link adoptPairingFile}. Present on a machine somebody installed with a
 *     current Crucible.
 *   * that server's own `config.toml` — {@link addLocalCrucible}, the door
 *     labelled "Use the Crucible on this machine". Present on every machine
 *     with a server on it, including ones whose pairing file was never written
 *     or has been tidied away.
 *
 * The pairing file goes first because it is PHASE15 §5.1's own order and it
 * carries the server's chosen name; the config is the fallback that catches the
 * rest. A machine with neither has no engine here, which is a fact and the one
 * case where the wizard has something to say.
 *
 * ── `already_registered` IS A SUCCESS HERE, AND THAT IS THE WHOLE POINT ───
 *
 * Both doors refuse an address the registry already holds, and they are right
 * to: adding it twice would be two GPU lanes over one card. But the question
 * THIS function asks is not "did I write a row", it is *"is the engine on this
 * machine connected"* — and a door refusing because the row is already there
 * answers that with yes. Owen pressed the local door on exactly this machine
 * and was shown *"http://127.0.0.1:7100 is already registered as \"local\".
 * Rename or remove that entry first"*, which is a true sentence about the
 * registry and a useless one about his situation: he was connected and was
 * being told to dismantle it. So the refusal is READ rather than shown, the
 * second read is skipped, and nothing is drawn.
 *
 * ── IT SPENDS NOTHING AND CANNOT REJECT ───────────────────────────────────
 *
 * Two file reads and, at most, one registry write. No model is loaded, no job
 * is placed, and the network is touched only by the coordination the writers
 * already start for a server this app has just met (PHASE14 §4a). Every arm
 * answers a {@link LocalCrucibleAdd}, so `mount.ts` can call it unawaited on a
 * path that runs before the window exists.
 */
export async function connectLocalEngine(): Promise<LocalCrucibleAdd> {
  if (hosted()) return { outcome: 'failed', code: 'no_local_config',
    message: 'The local connection belongs to the host application.' };
  const local = await addLocalCrucible('');
  if (local.outcome === 'added') {
    console.log(`[engine] registered "${local.serverName}" at ${local.url} from ${local.configPath}.`);
    await afterRegistryChanged();
    /*
     * THE SAME MOMENT THE DOOR TAKES, because this IS that door: finding a
     * server is the request (PHASE14 §4a), and a row that arrived without
     * anybody pressing anything still has to be coordinated with or the tiles
     * stay dark until something else asks.
     */
    void coordinateWithServer(local.serverName, 'a Crucible was found on this machine');
    return local;
  }
  if (local.code === 'already_registered') {
    console.log(`[engine] ${local.message} Nothing to connect.`);
    return local;
  }
  console.log(`[engine] no Crucible on this machine: ${local.message}`);
  return local;
}

/**
 * REGISTER ONE PAIRING LINE — the ONE writer behind both doors that take one.
 *
 * A pairing FILE is a connect code the machine left on disk, and a pasted
 * connect code is the same line off somebody's operator page. Owen's ruling —
 * *"it should all be entered the exact same way"* — means the two cannot differ
 * in how they name the server, so they do not differ in the code either: same
 * `addCrucibleServer`, same refusals, same `slotNameRefusal` clamp on the way to
 * disk, same name source.
 *
 * THE NAME IS THE LINE'S UNLESS SOMEBODY TYPED ONE. `typed` is the connect-code
 * card's Name box: the preview filled it with the code's own name and a person
 * may have renamed it before pressing Add, and a door that re-read the name out
 * of the line would silently throw that away. Empty — which is what the pairing
 * file's path passes, because there is no box on that road — means the line's
 * own name.
 *
 * It answers THE NAME AS STORED, because that is what the caller has to
 * coordinate with and log: `addCrucibleServer` tidies whitespace, and a
 * coordination keyed on the untidied string would be a run under a name no card
 * draws.
 *
 * NO TOKEN CROSSES OUT OF HERE. The line carries one; it goes into the registry
 * and nowhere else, which is crucible-registry.ts's standing rule.
 */
function registerPairing(pairing: Pairing, typed: string): string {
  const wanted = tidySlotName(typed);
  const name = wanted.length > 0 ? wanted : tidySlotName(pairing.name);
  addCrucibleServer(name, pairing.url, pairing.token);
  return name;
}

/** What `RemotePairingSessions` does with a pairing the other machine approved (registerIpc wires it). */
export async function registerApprovedPairing(pairing: Pairing): Promise<void> {
  const existing = crucibleServers().find((entry) => sameCrucibleAddress(entry.url, pairing.url));
  const stored = registerPairing(pairing, existing === undefined ? '' : existing.name);
  await afterRegistryChanged();
  void coordinateWithServer(stored, 'remote pairing was approved');
}

/** `crucible:save`. */
export async function saveCrucibleServers(servers: CrucibleServerEdit[]) {
  /*
   * READ BEFORE THE WRITE, because the only thing that can say which servers
   * this save CONNECTED us to is the pair of lists (see
   * `serversConnectedBySave`). Names and flags only — no token is read here
   * and none is compared.
   */
  const before = crucibleServers().map((entry) => ({ name: entry.name, enabled: entry.enabled }));
  writeCrucibleServers(servers);
  await afterRegistryChanged();
  /*
   * A SERVER THAT WAS JUST SWITCHED ON, OR JUST NAMED, IS A SERVER THIS APP
   * HAS JUST CONNECTED TO (PHASE14 §4a). Not awaited: a save must not sit on
   * a catalog read, let alone on a half-hour wait for somebody else's card,
   * and the row draws the run's own state as it arrives.
   */
  for (const name of serversConnectedBySave(before, crucibleServers())) {
    void coordinateWithServer(name, 'it was added or switched back on');
  }
  /*
   * THE WHOLE VIEW, not just the list, because saving a server CHANGES THE
   * SLOTS — enabling a loopback entry takes the local slot away — and a card
   * that redrew its list from this answer and its slot preview from a second
   * read would draw one repaint of the two disagreeing.
   */
  return crucibleSettingsView();
}

/** `crucible:add`. */
export async function addCrucibleServerDoor(name: string, url: string, token: string) {
  addCrucibleServer(name, url, token);
  await afterRegistryChanged();
  /*
   * A SERVER THAT HAS JUST BEEN ADDED IS A SERVER THIS APP HAS JUST CONNECTED
   * TO (PHASE14 §4a), so it is coordinated with immediately. The NAME the
   * registry stored is used rather than the one that was typed, because
   * `addCrucibleServer` normalises whitespace and a coordination run keyed on
   * an un-normalised name would be a second row under a name no card draws.
   */
  const stored = crucibleServers().find(
    (entry) => entry.name.toLowerCase() === tidySlotName(name).toLowerCase(),
  );
  if (stored !== undefined) void coordinateWithServer(stored.name, 'it was added');
  return crucibleSettingsView();
}

/** `crucible:add-local`. */
export async function addLocalCrucibleDoor(name: string) {
  const answer = await addLocalCrucible(name);
  if (answer.outcome === 'added') {
    await afterRegistryChanged();
    /*
     * THE SAME MOMENT, one door along — and the name is the ANSWER's, not the
     * argument's: `addLocalCrucible` falls back to the server's own name when
     * the box was left empty, so the argument may be the empty string while a
     * row called "crucible" now exists.
     */
    const added = crucibleServers().find((entry) => entry.url === answer.url);
    if (added !== undefined) {
      void coordinateWithServer(added.name, 'the Crucible on this machine was registered');
    }
  }
  return answer;
}

/** `crucible:parse-connect-code`. */
export function parseConnectCode(line: string): ConnectCodePreview {
  const read = readConnectCode(line);
  return read.read
    ? { outcome: 'read', name: read.pairing.name, url: read.pairing.url }
    : { outcome: 'refused', message: read.message };
}

/** `crucible:test-connect-code`. */
export async function testConnectCode(line: string): Promise<CrucibleProbe> {
  const read = readConnectCode(line);
  // A REFUSAL IS A RESULT HERE, not a rejection, because the door it is drawn
  // in already draws `CrucibleProbe.outcome === 'failed'` — one sentence, one
  // place to look, whether the line was unreadable or the server was.
  if (!read.read) return { outcome: 'failed', message: read.message };
  return probeCrucibleAt(read.pairing.url, read.pairing.token);
}

/** `crucible:add-connect-code`. */
export async function addConnectCode(line: string, name: string) {
  const read = readConnectCode(line);
  if (!read.read) throw new Error(read.message);
  const stored = registerPairing(read.pairing, name);
  await afterRegistryChanged();
  void coordinateWithServer(stored, 'it was added from a connect code');
  return crucibleSettingsView();
}

/** `crucible:engine-settings-put`: write through, and redraw from the answer. */
export async function putEngineSettings(serverName: string, patch: SettingsPatch): Promise<SettingsDocument> {
  const document = await writeEngineSettings(namedServerOr(serverName), patch);
  if (patch.routes !== undefined) {
    const settings = readAppSettings();
    writeAppSettings({ setupSkipped: settings.setupSkipped.filter(step => step !== 'routes') });
    await afterRegistryChanged();
    void coordinateWithServer(serverName, 'its model routes were selected');
  }
  return document;
}

/**
 * THE RUN, AND WHAT MUST HAPPEN AFTER IT, in one place.
 *
 * Two doors reach it — the Install button and §2.5's Try again — and they
 * must not differ in their tail: an install that registered the engine but
 * never coordinated leaves a connected server with none of the environments
 * this app asked for, and which of the two buttons was pressed has nothing
 * to do with that.
 *
 * ── COORDINATE WAITS FOR A TERMINAL OUTCOME (PHASE19 §2.8) ────────────────
 *
 * Coordinate-on-connect is what installs job environments and pulls weights,
 * and under PHASE20 those are gigabytes. Run against the NATIVE engine on a
 * machine that is mid-move they land on Windows and make migrate-weights
 * expensive for nothing, so the app waits and then coordinates once, against
 * whichever engine is left standing. `failed` is deliberately not terminal:
 * the tray retries it once (§2.2), and coordinating over a move that is
 * about to start again is the same mistake one attempt later.
 *
 * The gate is asked HERE and not inside the run, because it is a statement
 * about what this app does NEXT, and the run's own business is finished.
 */
export async function runInstallAndCoordinate(
  installDoor: CrucibleInstallDoor,
  run: () => Promise<void> = runInstallNarrated,
): Promise<void> {
  await run();
  await afterRegistryChanged();
  const outcome = (await installDoor.status()).outcome;
  if (outcome !== null && !TERMINAL_OUTCOME_STATES.includes(outcome.state)) return;
  for (const entry of crucibleServers().filter((entry) => entry.enabled)) {
    void coordinateWithServer(entry.name, 'Crucible was installed');
  }
}

/** `crucible:restart-windows`: Restart now. */
export function restartWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('Only Windows asks for a restart to finish setting up its engine.');
  }
  const child = spawn('shutdown.exe', ['/r', '/t', '5'], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** `crucible:uninstall`: the real run, and the registry row it leaves dead. */
export async function uninstallCrucible(flags: CrucibleUninstallFlags): Promise<CrucibleUninstallRun> {
  const availability = await crucibleUninstallAvailability();
  const plan = await crucibleUninstallPerform(flags);
  if (availability.server === null || !uninstallStoppedTheEngine(plan)) {
    return { plan, unregistered: null };
  }
  removeCrucibleServer(availability.server);
  await afterRegistryChanged();
  console.log(
    `[crucible] "${availability.server}" was removed from the registry: its engine was `
    + 'uninstalled from this computer and the token went with config.toml.',
  );
  return { plan, unregistered: availability.server };
}

/** `crucible:offer-start`: is there a Crucible here that is not running, and shall we start it? */
export async function offerCrucibleStart(): Promise<Asked<'start' | 'later'>> {
  const state = await crucibleRunState();
  if (state.kind === 'problem') {
    const words = crucibleFaultWords(state.fault);
    return {
      kind: 'ask', question: {
        title: words.title, message: state.why, detail: words.detail,
        choices: [{ key: 'later', label: 'Close' }], preferred: 'later',
        dismissed: 'later', checkbox: null,
      },
    };
  }
  if (state.kind === 'unhealthy') {
    console.log(
      `[crucible] the local engine answered its ping and did not finish the rest: ${state.why}. `
      + 'Nothing is offered — there is nothing to start, and nothing here repairs a slow '
      + 'answer. The Servers card has it from now on.',
    );
    return { kind: 'answered', answer: 'later' };
  }
  if (state.kind !== 'stopped' && state.kind !== 'unreachable') {
    return { kind: 'answered', answer: 'later' };
  }
  return {
    kind: 'ask',
    question: {
      title: 'Start Crucible?',
      /*
       * TWO SENTENCES FOR TWO STATES, because they are different facts and a
       * person who reads "is stopped" about a machine whose tray icon they can
       * see has been told something they know to be false. `unreachable` is the
       * one where Crucible believes it is up and nothing is answering.
       */
      message: state.kind === 'stopped'
        ? 'Crucible is installed on this computer and is stopped.'
        : 'Crucible is installed on this computer and is not answering.',
      detail: [
        'Crucible is the GPU engine. Translation, simplification, cleanup, analysis and page '
        + 'reading all run on it, and none of them can run while it is stopped. Opening a book, '
        + 'compiling one and exporting one are unaffected.',
        'Crucible starts its managed service. It stays running after Foundry closes.',
      ],
      choices: [
        { key: 'start', label: 'Start Crucible' },
        { key: 'later', label: 'Not now' },
      ],
      preferred: 'start',
      dismissed: 'later',
      checkbox: null,
    },
  };
}

/** `crucible:start`: the press, answered with a sentence. */
export async function startCrucibleAndConnect() {
  const result = await startCrucible();
  if (result.started) await connectLocalEngine();
  return result;
}

/** `cloud:save`. */
export async function saveCloudProviders(providers: CloudProviderEdit[]) {
  writeCloudProviders(providers);
  /*
   * `gatesChanged` AND NOT `afterRegistryChanged`. Connecting a provider moves
   * the TILES — an enabled one lights translate, simplify, analysis and clean
   * on a machine that could not run them (act-gates.ts) — and moves nothing
   * else. The three steps `afterRegistryChanged` takes are all about a
   * Crucible: forgetting capability answers nobody asked a provider for,
   * re-probing servers that have not changed, and §5b's page-reader deletion,
   * which a cloud provider can never trigger because it does not serve
   * `pages` at all.
   */
  gatesChanged();
  /*
   * THE WHOLE VIEW for `crucible:save`'s reason: enabling a provider CHANGES
   * THE SLOTS, and a card that redrew its list from this answer and its slot
   * preview from a second read would draw one repaint of the two disagreeing.
   */
  return cloudSettingsView();
}

/*
 * ── AND THE FIRST SWEEP, ONCE AT STARTUP ──────────────────────────────────
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a and Owen, 2026-09-14: *"lets make
 * it as simple as possible."* Every ENABLED server, in the REGISTRY'S OWN
 * ORDER, with no button and no question — the enable switch in Settings is the
 * one opt-out, because it is the control that already means "not that one".
 * It used to put the loopback entries at the front; Owen's ruling that *"a
 * local crucible server shouldnt be treated any differently than a remote
 * crucible server"* retired that, and `coordinateEveryServer` argues why the
 * operator's drag rank is the only order this app is entitled to.
 *
 * IT RUNS HOSTED TOO. The registry is the host's over there and read-only,
 * and each app still posts its OWN module: the union of the two modules on
 * one server is the contract. What is suppressed hosted is the DRAWING (the
 * Servers card is BookForge's), not the asking.
 *
 * REGISTERED AFTER THE LISTENER ABOVE, deliberately: the sweep's first
 * `checking` is published synchronously inside `coordinateServer`, so a
 * listener added afterwards would miss the first frame of the run it was
 * added for.
 *
 * DELIBERATELY NOT AWAITED, on the same reasoning as the §5b pass below: a
 * run can end in a half-hour wait on somebody else's card, and nothing on
 * screen is waiting for it. A failure is a STATE, drawn in the row; the
 * console line here is for the case where the sweep itself could not start.
 */
export function sweepAtStartup(): void {
  void coordinateEveryServer()
    .then((states) => {
      /*
       * ONE LINE PER SERVER, once the sweep has settled. The states are already
       * pushed to every window as they move; this is for the console a person
       * reads when a window is not what they are looking at — a launch that
       * found an engine and asked it for nothing should say so, and one that
       * could not reach it should say which. No token, no address: the name
       * and the phase are the whole of the news.
       */
      for (const state of states) {
        const detail = state.phase === 'unreachable' || state.phase === 'refused'
          ? `: ${state.message}`
          : '';
        console.log(`[crucible] "${state.server}" at start-up: ${state.phase}${detail}`);
      }
    })
    .catch((err: unknown) => {
      console.error(
        '[crucible] the start-up coordination sweep did not finish: '
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    });

  // Same at startup: the facts are refreshed, and there is no longer a local
  // reader for a local engine to have superseded.
  void refreshCrucibleFacts()
    .then(() => {
      gatesChanged();
    })
    .catch((err: unknown) => {
      console.error(
        '[slots] the weights-ownership pass could not finish: '
        + `${err instanceof Error ? err.message : String(err)}. Nothing was removed.`,
      );
    });
}

