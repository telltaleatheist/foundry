/**
 * crucible-registry-probe — probing a server, adding the local one, and running a command.
 */
import { spawn } from 'node:child_process';
import { CrucibleAuthError, CrucibleNotACrucible, CrucibleUnreachable, CrucibleVersionError } from '@crucible/client';
import { clampCrucibleUrl, sameCrucibleAddress, type CrucibleServerEntry } from './app-settings';
import { pairingFileRead } from './crucible-pairing';
import { tidySlotName, type CrucibleProbe, type LocalCrucibleAdd } from '../shared/slots';
import { clientFor } from './crucible-registry-client';
import { CrucibleOrchestratorError, resolveEngine } from './crucible-registry-engine';
import { crucibleServerNamed, crucibleServers } from './crucible-registry-read';
import { addCrucibleServer, refuseHostedRegistryChange } from './crucible-registry-write';

/**
 * TEST CONNECTION — `info()`, which is authenticated, so one call answers both
 * "is there a Crucible there" and "is this the right token".
 *
 * Every failure keeps the SDK's own sentence. They already name what to fix
 * ("crucible at http://… is unreachable: …", "crucible refused the token") and a
 * word of ours in place of one of those is how a fixable problem becomes an
 * unfixable one. The types are named in the catch anyway — not to reword them,
 * but so that a throw this module has NOT anticipated is visibly a different
 * branch rather than something that quietly wore the same sentence.
 */
export async function probeCrucible(name: string): Promise<CrucibleProbe> {
  const entry = crucibleServerNamed(name);
  if (entry === null) return { outcome: 'failed', message: `There is no server called "${name}".` };
  return probeEntry(entry);
}

/**
 * TEST AN ADDRESS AND A TOKEN THAT ARE NOT IN THE REGISTRY YET.
 *
 * The setup wizard's "Connect to a Crucible server" door (docs/SETUP.md, Wave 61
 * package E) has a URL box, a token box and a Test button, and none of those
 * three has been saved when the button is pressed. Testing after adding would be
 * this app writing a server into somebody's settings in order to find out
 * whether it is a server.
 *
 * IT IS THE SAME PROBE, through the same client and the same error handling —
 * the only difference is where the two fields came from. A second probe with its
 * own error branches is how one surface starts reporting "unreachable" where the
 * other reports the SDK's sentence about a refused token.
 *
 * THE TOKEN IS NOT STORED BY THIS CALL and is not logged by it. It arrives over
 * IPC from a box the person is typing in, is used for one request, and is
 * dropped; only a later `crucible:save` writes it anywhere.
 */
export async function probeCrucibleAt(url: string, token: string | null): Promise<CrucibleProbe> {
  const clamped = clampCrucibleUrl(url);
  if (clamped === null) {
    return {
      outcome: 'failed',
      message: 'That needs to be an address like http://192.0.2.20:7100 — the server\'s base URL, '
        + 'without /v1 on the end.',
    };
  }
  // No token is an OPEN server, probed with none.
  return probeEntry({ name: clamped, url: clamped, token: (token ?? '').trim(), enabled: true });
}

/**
 * The probe itself. Both doors above are this function plus a way of naming the
 * server.
 *
 * ── AN ORCHESTRATOR IN FRONT OF AN ENGINE IS A SUCCESS ─────────────────────
 *
 * And it has to be, because it is the shape of Owen's own PC (PHASE17 §5, first
 * row): the tray on `:7101`, the WSL engine on `:7100`, and an address that is
 * perfectly usable through one hop. Reporting it as a failure would tell
 * somebody to fix a machine that is working. So the probe RESOLVES first and
 * then reads the ENGINE's document — the name, the version, the backend and the
 * card are all the engine's, which is the machine the work will run on — and
 * `via` carries the orchestrator so the card can say both.
 *
 * WHAT STAYS A FAILURE is an orchestrator with nothing behind it, and a chain.
 * Both arrive as {@link CrucibleOrchestratorError}, whose sentences name what to
 * do, and both fall through the named catch below like every other refusal.
 */
/**
 * The card, named once.
 *
 * This was `${vendor} ${name}`, which on every NVIDIA machine there is produces
 * *"nvidia NVIDIA GeForce RTX 3090 Ti"* — the vendor twice, once in lower case.
 * The prefix is not useless, though, and is why the join was there: a Mac
 * answers vendor `apple` with name `M1 Ultra`, and "M1 Ultra" alone on a card
 * beside three NVIDIA rows is the one row that does not say whose it is.
 *
 * So it is prefixed only when the name does not already say it. Compared case-
 * insensitively because the two fields disagree on case by convention — the
 * vendor is a lower-case key, the name is the marketing string — and that
 * disagreement is exactly what made the duplicate invisible to whoever wrote
 * the join.
 */
/** The card in the server's words, or null when it gave neither a vendor nor a name. */
export function gpuWords(vendor: string | null, name: string | null): string | null {
  const card = name === null || name.trim().length === 0 ? null : name.trim();
  const who = vendor === null || vendor.trim().length === 0 ? null : vendor.trim();
  if (who === null) return card;
  if (card === null) return who;
  return card.toLowerCase().startsWith(who.toLowerCase()) ? card : `${who} ${card}`;
}

export async function probeEntry(entry: CrucibleServerEntry): Promise<CrucibleProbe> {
  try {
    const target = await resolveEngine(entry);
    const info = await clientFor(target.entry).info();
    return {
      outcome: 'ok',
      serverName: info.server.name,
      version: info.server.version,
      backend: info.host.backend,
      /*
       * THE CARD IS DESCRIPTIVE, SO A SERVER THAT DOES NOT DESCRIBE IT STILL
       * PROBES OK (Owen, 2026-09-24: *"if it can make the call to the crucible
       * server then it should work"*). Each part is null where it was not sent,
       * and the screen draws only what was.
       */
      gpu: info.host.gpu === null ? null : gpuWords(info.host.gpu.vendor, info.host.gpu.name),
      vramBytes: info.host.gpu === null ? null : info.host.gpu.vramBytes,
      via: target.hop === null
        ? null
        : `through the orchestrator ${target.hop.orchestratorName} at ${target.hop.orchestratorUrl} `
          + (target.hop.engineOwner === null ? '' : `(${target.hop.engineOwner})`),
    };
  } catch (err) {
    if (
      err instanceof CrucibleUnreachable
      || err instanceof CrucibleNotACrucible
      || err instanceof CrucibleAuthError
      || err instanceof CrucibleVersionError
      // The relation's own two, whose sentences already say what to install or
      // what to re-point — see CrucibleOrchestratorError.
      || err instanceof CrucibleOrchestratorError
    ) {
      return { outcome: 'failed', message: err.message };
    }
    return { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The local connection, published by Crucible on the native filesystem.
// ─────────────────────────────────────────────────────────────────────────────

export async function addLocalCrucible(name: string): Promise<LocalCrucibleAdd> {
  refuseHostedRegistryChange();
  try {
    const published = await pairingFileRead();
    if (published.found !== 'pairing') {
      return {
        outcome: 'failed',
        code: published.found === 'absent' ? 'no_local_config' : 'config_unreadable',
        message: published.found === 'absent'
          ? 'Crucible has not published a local connection. Install or repair Crucible, then try again.'
          : published.message,
      };
    }
    const connection = published.pairing;
    // Refresh an existing address in place, preserving the user's name, rank
    // and enabled state even if the server renamed itself or rotated its token.
    const existing = crucibleServers().find((entry) => sameCrucibleAddress(entry.url, connection.url));
    const wanted = tidySlotName(name);
    const label = existing !== undefined ? existing.name : wanted.length > 0 ? wanted : connection.name;
    const servers = addCrucibleServer(label, connection.url, connection.token);
    return { outcome: 'added', servers, serverName: label, url: connection.url, configPath: published.path };
  } catch (err) {
    return { outcome: 'failed', code: 'config_unreadable',
      message: err instanceof Error ? err.message : String(err) };
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. Never both with a code. */
  failure: string | null;
}

/**
 * Run one command and collect what it said.
 *
 * ── The decode, which is the thing that makes this its own function ────────
 *
 * `wsl.exe` writes its OWN messages ("There is no distribution with the
 * supplied name") in UTF-16LE with a BOM, while everything the guest prints
 * comes through as UTF-8. So the two are interleaved on one pipe with two
 * encodings, and a `spawn(..., {encoding: 'utf8'})` turns the wsl.exe half into
 * a string of NUL-separated characters — which is how a legible refusal becomes
 * an unreadable one exactly when somebody needs to read it. Each chunk is
 * therefore decoded on its own, by the one thing that tells the two apart at a
 * glance: UTF-16LE ASCII has a NUL in every other byte.
 */
export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', failure: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, failure: 'it did not answer within 20 seconds' });
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += decodeChunk(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += decodeChunk(chunk); });
    child.on('error', (err) => finish({ code: null, stdout, stderr, failure: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, failure: null }));
  });
}

/** One chunk, decoded as whichever of the two encodings it actually is. */
export function decodeChunk(chunk: Buffer): string {
  if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
    return chunk.subarray(2).toString('utf16le');
  }
  /*
   * No BOM, so look at the bytes. Interleaved NULs in the first stretch of a
   * chunk mean UTF-16LE ASCII and mean nothing else: UTF-8 never contains a NUL
   * byte at all, so a single one is already conclusive and half of them is not a
   * judgement call.
   */
  const look = Math.min(chunk.length, 64);
  let nuls = 0;
  for (let index = 1; index < look; index += 2) if (chunk[index] === 0) nuls += 1;
  return nuls > 0 && nuls >= Math.floor(look / 4) ? chunk.toString('utf16le') : chunk.toString('utf8');
}
