/**
 * crucible-pairing — the file a Crucible leaves on its own machine, read once.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * PHASE15-HOST.md §5.1 names three ways an app connects to an engine, IN THIS
 * ORDER: the pairing file on this machine, a pasted connect code for one
 * elsewhere, and getting one installed here. This module is the first of the
 * three, and it is the one nobody has to know about — `crucible init`, `crucible
 * service install` and the Windows host all write one line to
 * `<CRUCIBLE_HOME>/pairing`, and an app on the same machine reads it and
 * registers the server without anybody typing a token (§3.6).
 *
 * ── AN ABSENT FILE IS A FACT, NOT A FALLBACK ────────────────────────────────
 *
 * §3.6, in the contract's own words: *"An absent file means 'no local server' —
 * a fact the app shows, not a fallback it fills."* So this returns null and logs
 * one line at debug volume, and NOTHING downstream treats that null as a reason
 * to guess an address. A machine with no engine on it has no engine on it; the
 * other two doors of §5.1 are how a person says otherwise.
 *
 * ── THE PARSER IS THE SDK'S AND IS NEVER REIMPLEMENTED ──────────────────────
 *
 * `parsePairing` (PHASE13-OPERATOR.md §2.1) percent-decodes the server's name,
 * refuses a second literal `@` in the authority rather than guessing which one
 * separated the userinfo, and refuses a line with no `/` before the fragment.
 * Those refusals have ONE owner — the SDK — because the spelling has one
 * producer, and a second reader that was a little more forgiving would make the
 * meaning of a line depend on which program read it (ARCHITECTURE.md R3).
 *
 * ── THE TOKEN, AND THE ONE RULE IT HAS ──────────────────────────────────────
 *
 * The line IS a credential. It is read here, handed straight to
 * `addCrucibleServer` in the main process, and never logged, never returned over
 * an IPC answer, never put on a command line — crucible-registry.ts's header
 * argues this at length and this module is bound by it. The SDK's own refusal
 * already elides everything after the `#`, which is why its sentence can be
 * printed verbatim when a line will not parse.
 *
 * ── STANDING NOTE: SWITCH TO THE SDK'S THE MOMENT THE TARBALL CARRIES IT ────
 *
 * PHASE15 §3.8 gives `@crucible/client` a `readPairingFile(home?)` of its own.
 * When the vendored tarball has it, {@link readPairingFile} below becomes one
 * line that calls it and {@link pairingFilePath} goes with it — the path table
 * is the contract's, not this app's, and two copies of a path is how a Windows
 * build starts looking somewhere the host never writes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CruciblePairingError, parsePairing, type Pairing } from '@crucible/client';

/**
 * WHERE THE PAIRING FILE IS, PER PLATFORM — and the table has one owner.
 *
 * crucible `docs/PHASE15-HOST.md` §3.6, pinned 2026-09-14 in Crucible commit
 * `3bcd003` for exactly this package. That file is the authority; this constant
 * is a reading of it and nothing more:
 *
 *   `CRUCIBLE_HOME` set          `$CRUCIBLE_HOME/pairing`, on every platform
 *   linux, darwin                `~/.crucible/pairing`
 *   win32                        `%LOCALAPPDATA%\Crucible\pairing`
 *
 * WHY WINDOWS IS NOT `~/.crucible`. On Windows the server itself lives inside
 * the WSL guest, whose home is a filesystem no Windows app looks in, so the file
 * here is the HOST's copy of the guest's line — same token, same host, same port
 * (§3.6, §4.3). Before the host lands, nothing writes it on a Windows box and
 * door 2 ("the Crucible on this machine", which reads config.toml through
 * wsl.exe) is how Owen's PC registers its WSL server; §3.6 says that door is
 * deleted when the host ships and not before.
 *
 * ONE CONSTANT, read through one function, because a path composed at two call
 * sites is two paths the first time one of them is edited.
 */
function crucibleHome(): string {
  const named = process.env['CRUCIBLE_HOME']?.trim();
  if (named !== undefined && named.length > 0) return named;
  if (process.platform === 'win32') {
    /*
     * `%LOCALAPPDATA%` and not `app.getPath('userData')`: this directory is
     * CRUCIBLE's, written by Crucible's installer beside its `host\`, and
     * resolving it through Electron would be this app naming a folder it does
     * not own. The homedir join is the documented expansion of the variable and
     * exists only because a stripped environment is not a reason to throw.
     */
    const local = process.env['LOCALAPPDATA']?.trim();
    const base = local !== undefined && local.length > 0
      ? local
      : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Crucible');
  }
  return path.join(os.homedir(), '.crucible');
}

/** The one path, composed from {@link crucibleHome}. Exported so a log can name it. */
export function pairingFilePath(): string {
  return path.join(crucibleHome(), 'pairing');
}

/**
 * What the read found — the three answers the "Look again" door has to tell
 * apart, which is one more than {@link readPairingFile} can express.
 *
 * `absent` and `refused` are DIFFERENT THINGS TO DO. Absent is the ordinary
 * state of a machine with no engine on it and the person is told a fact; refused
 * is a file that exists and says something this reader does not understand,
 * which is somebody's to fix, so it carries the SDK's own sentence.
 */
export type PairingFileRead =
  | { found: 'pairing'; pairing: Pairing; path: string }
  | { found: 'absent'; path: string }
  | { found: 'refused'; message: string; path: string };

/**
 * Read `<CRUCIBLE_HOME>/pairing` and say which of the three it was.
 *
 * ONE LINE, TRAILING NEWLINE (§3.6). The file is trimmed and the FIRST non-empty
 * line is parsed rather than the whole buffer, because a trailing newline is
 * promised and a text editor that added a second one should not turn a working
 * pairing into a refusal — while a file with two DIFFERENT lines in it is still
 * one server's file and the first line is the one the writer wrote.
 *
 * EVERY read failure that is not "no such file" is a REFUSAL rather than an
 * absence: a permission error on a file we can see is not "you have no engine",
 * and reporting it as one would leave somebody looking for an engine they have
 * already installed.
 */
export function pairingFileRead(): PairingFileRead {
  const file = pairingFilePath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { found: 'absent', path: file };
    return {
      found: 'refused',
      message: `${file} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      path: file,
    };
  }
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0)?.trim();
  if (line === undefined) return { found: 'absent', path: file };
  try {
    return { found: 'pairing', pairing: parsePairing(line), path: file };
  } catch (err) {
    /*
     * REFUSED BY NAME, IN ONE LINE, WITH NO TOKEN IN IT. `CruciblePairingError`'s
     * own message already replaces everything after the `#` with an ellipsis,
     * which is the whole reason it can be printed verbatim; anything else that
     * came out of here would be a sentence of ours over a refusal that already
     * names what is wrong with the shape.
     */
    const message = err instanceof CruciblePairingError
      ? `${file}: ${err.message}`
      : `${file}: ${err instanceof Error ? err.message : String(err)}`;
    return { found: 'refused', message, path: file };
  }
}

/**
 * THE SDK-SHAPED DOOR — `Pairing` or null, and the one function that goes when
 * `@crucible/client` grows `readPairingFile(home?)` (PHASE15 §3.8).
 *
 * It is deliberately the whole of what the startup path needs: at start there is
 * nobody to show a refusal to, so both silences are the same silence and the
 * difference between them is a console line. The "Look again on this machine"
 * button, which a person pressed and is owed an answer, reads
 * {@link pairingFileRead} instead.
 */
export function readPairingFile(): Pairing | null {
  const read = pairingFileRead();
  if (read.found === 'pairing') return read.pairing;
  if (read.found === 'refused') {
    console.error(`[pairing] refused: ${read.message}`);
    return null;
  }
  // DEBUG VOLUME, one line: no pairing file is the ordinary state of a machine
  // that has no engine on it, and a machine that has one writes this file.
  console.log(`[pairing] no pairing file at ${read.path} — no local Crucible on this machine.`);
  return null;
}

/**
 * ONE PASTED CONNECT CODE, read — PHASE15 §5.1 way 2, PHASE13-OPERATOR.md §5.1.
 *
 * ── Why this lives beside the file reader ───────────────────────────────────
 *
 * Same line, same parser, same refusal. The two ways in differ only in where the
 * line came from — a file Crucible wrote here, or a line somebody copied off an
 * operator page elsewhere — and putting the second one's parse in the IPC module
 * would be a second place that decides what a `crucible://` line means. It never
 * becomes two places, because there is only ever one `parsePairing`.
 *
 * ── The three doors take THE LINE, every time, and never a token ────────────
 *
 * Preview, Test and Add each call this with the pasted line afresh rather than
 * passing a parsed token between them. A token handed back to the renderer so it
 * could be handed forward again would be a credential living in a component for
 * as long as the door was open, for no gain: parsing is pure and costs nothing.
 *
 * The refusal is the SDK's own sentence VERBATIM — it already replaces everything
 * after the `#` with an ellipsis, and rewording it would take the `invalid_pairing`
 * name off a refusal whose name is the thing to search for.
 */
export type ConnectCodeRead =
  | { read: true; pairing: Pairing }
  | { read: false; message: string };

export function readConnectCode(line: string): ConnectCodeRead {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { read: false, message: 'Paste the connect code a Crucible printed for you.' };
  }
  try {
    return { read: true, pairing: parsePairing(trimmed) };
  } catch (err) {
    if (err instanceof CruciblePairingError) return { read: false, message: err.message };
    return { read: false, message: err instanceof Error ? err.message : String(err) };
  }
}
