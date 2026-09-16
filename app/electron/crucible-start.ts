/**
 * crucible-start — Crucible is installed on this computer and is not running.
 * Offer to start it.
 *
 * ── The ruling ─────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-15, relayed through BookForge: *"foundry is a standalone
 * independent app. im talking about the standalone independent foundry app, not
 * the vendored copy. by the time the user reaches foundry in bookforge they will
 * have already been presented with the option to start it. the foundry app
 * should ask if they want to start crucible."*
 *
 * So the offer belongs to THIS window and only to this window. The vendored copy
 * inside BookForge draws nothing: by the time somebody reaches Foundry there,
 * BookForge has already asked, and two apps asking one question about one
 * machine is how a person ends up starting an engine twice and being told off by
 * the second one. `hosted()` is the whole of that rule and it is checked first.
 *
 * ── AN APP NEVER STARTS AN ENGINE. IT STARTS THE TRAY. ─────────────────────
 *
 * Agreed with BookForge the same day, and it is the reason this module is forty
 * lines rather than two hundred. On Windows the engine lives inside WSL and
 * bringing it up means a user-scoped systemd unit inside the guest:
 *
 *     wsl.exe -d <distro> --exec env XDG_RUNTIME_DIR=/run/user/<uid> \
 *             systemctl --user start crucible.service
 *
 * — and the `XDG_RUNTIME_DIR` is not optional, because a `--exec` session gets
 * no logind seat, so `systemctl --user` cannot find the bus without it; a
 * missing variable and a missing socket print the IDENTICAL error. Crucible's
 * tray already owns that path (`crucible/host/presence.py`), measured and
 * correct. Re-deriving it here would be a second owner of a mechanism that is
 * easy to get wrong and silent when it is.
 *
 * So: `crucible orchestrator` on Windows — its own help calls it *"the tray that
 * manages this machine's engine"* — and `crucible service start` on macOS, where
 * the engine runs under launchd and there is no tray yet. One owner for "is it
 * up", on both platforms.
 *
 * ── HOW "NOT RUNNING" IS TOLD FROM "NOT INSTALLED" ────────────────────────
 *
 * They want opposite offers — a Start button and an Install document — so
 * confusing them is offering somebody a button that cannot work. The two halves
 * are asked separately and neither is guessed:
 *
 *   * INSTALLED is {@link locateCrucible}, the uninstall door's own locator,
 *     exported so there is one answer to "is there a Crucible on this machine".
 *     It is a file test (plus one `wsl.exe` call on the arm that needs it) and
 *     it needs nothing running.
 *   * RUNNING is `GET /v1/ping`, which is UNAUTHENTICATED — verified against the
 *     engine on this machine, which answers `{"crucible":true,"name":...}` with
 *     no `Authorization` header at all. That matters more than it looks: the
 *     offer has to work for somebody who has installed Crucible and never
 *     registered it, so a liveness check that needed a token would be a check
 *     that could not run in exactly the case this module exists for.
 *
 * `installed && !running` is the offer. Anything else draws nothing.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { readAppSettings } from './app-settings';
import type { CrucibleStartResult } from '../shared/slots';
import { hosted } from './host';
import { pairingFileRead } from './crucible-pairing';
import {
  locateCrucible,
  posixServerCommand,
  windowsHostCommand,
  type CrucibleInvocation,
} from './crucible-uninstall';

/** Where a Crucible on this machine answers when nothing else says otherwise. */
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:7100';

/** One ping. Short, because this runs before the window is useful. */
const PING_TIMEOUT_MS = 2_000;

/**
 * How long to wait for the engine after the tray is launched, and how often to
 * look.
 *
 * THIRTY SECONDS IS NOT A GUESS ABOUT A FAST MACHINE. On Windows the tray has to
 * start, claim its engine, and wait for a systemd unit inside a WSL guest that
 * may itself be cold — and the first boot of a distro after a reboot is the slow
 * case. What the caller gets when it expires is *"it was asked to start and has
 * not answered yet"*, which is true and is not a failure; the tray is still
 * coming up and the next thing that asks will find it.
 */
const START_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;

export type CrucibleRunState =
  /** It answered. Nothing to offer. */
  | { kind: 'running'; url: string; name: string }
  /** It is here and it is not answering — the one state that gets the offer. */
  | { kind: 'stopped'; url: string; via: CrucibleInvocation['via']; distro: string | null }
  /** There is none on this computer. The install door is the right offer. */
  | { kind: 'absent'; why: string }
  /** Hosted, or otherwise not this window's question. */
  | { kind: 'not-ours' };

/**
 * WHICH ADDRESS TO PING — the local engine's, from whoever knows it.
 *
 * In the order of what is most likely to be RIGHT rather than what is cheapest,
 * because a ping to the wrong port answers "not running" about a healthy engine
 * and this module would then offer to start something that is already up:
 *
 *   1. A registered loopback entry. Somebody connected this engine, so its
 *      address is the one this app has actually been talking to.
 *   2. The pairing file, which the engine itself wrote.
 *   3. The default. A machine with neither of the above and a Crucible on a
 *      moved port is a machine this will get wrong, and the wrong answer is
 *      "offer to start it" — a button that starts a tray that finds its engine
 *      already up and does nothing. Harmless, and named rather than hidden.
 */
async function localEngineUrl(): Promise<string> {
  const registered = readAppSettings().crucibleServers.find((entry) => {
    try {
      const host = new URL(entry.url).hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    } catch {
      return false;
    }
  });
  if (registered !== undefined) return registered.url;
  const paired = await pairingFileRead();
  return paired.found === 'pairing' ? paired.pairing.url : DEFAULT_LOCAL_URL;
}

/**
 * Is a Crucible answering at this address?
 *
 * NO TOKEN, on purpose — see the header. And no `X-Crucible-Api` either: the
 * point of this call is *"is something alive here"*, and a server whose API
 * version this build cannot speak is still a server that is RUNNING. Sending the
 * header would make a version mismatch read as "not running", and the offer
 * would then be to start an engine that is already up.
 */
async function answers(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, PING_TIMEOUT_MS);
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/v1/ping`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { crucible?: unknown; name?: unknown };
    if (body.crucible !== true) return null;
    return typeof body.name === 'string' ? body.name : '';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The three states, asked in the order that costs least. */
export async function crucibleRunState(): Promise<CrucibleRunState> {
  if (hosted()) return { kind: 'not-ours' };
  const url = await localEngineUrl();
  const name = await answers(url);
  if (name !== null) return { kind: 'running', url, name };
  /*
   * IT IS NOT ANSWERING. Whether that is worth offering to fix depends entirely
   * on whether there is one here, and the locator throws when there is not —
   * carrying the sentence that says WHICH silence it was, which the install
   * offer one screen along is composed from.
   */
  try {
    const where = await locateCrucible();
    return { kind: 'stopped', url, via: where.via, distro: where.distro };
  } catch (err) {
    return { kind: 'absent', why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Launch the tray and wait for the engine.
 *
 * ── DETACHED, AND THAT IS THE WHOLE POINT ─────────────────────────────────
 *
 * The tray must OUTLIVE Foundry — it is the thing that keeps the engine up, and
 * an engine that died when somebody closed this window would be a worse state
 * than the one they started in. So `detached`, `stdio: 'ignore'` and `unref()`:
 * nothing here holds a handle on it, nothing reads its output, and this process
 * exiting is not its business. That is also why `runProcess` in the uninstall
 * module is not reused — it waits for exit, which is right for a `--dry-run` and
 * exactly wrong for a tray.
 *
 * ── cmd.exe, FOR THE REASON THE UNINSTALL DOOR ALREADY CARRIES ────────────
 *
 * `crucible.cmd` cannot be spawned directly on Electron 33's Node
 * (CVE-2024-27980 made `spawn` refuse a `.cmd` without a shell), so the Windows
 * arm goes through `cmd.exe /d /s /c` with `windowsVerbatimArguments`, verbatim
 * from `runWindowsHost`. `/d` skips AutoRun; `/s` makes cmd strip the outer
 * quotes and take the rest as the command line.
 */
export async function startCrucible(): Promise<CrucibleStartResult> {
  const state = await crucibleRunState();
  if (state.kind === 'running') {
    return { started: true, detail: `${state.name || 'The engine'} is already running.` };
  }
  if (state.kind !== 'stopped') {
    return {
      started: false,
      detail: state.kind === 'absent'
        ? `There is no Crucible to start on this computer: ${state.why}.`
        : 'The servers belong to the application Foundry is running inside.',
    };
  }

  try {
    launch(state.via, state.distro);
  } catch (err) {
    return {
      started: false,
      detail: `Crucible could not be launched: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MS);
      timer.unref?.();
    });
    const name = await answers(state.url);
    if (name !== null) {
      return { started: true, detail: `${name || 'The engine'} is running.` };
    }
  }
  /*
   * NOT A FAILURE, AND IT MUST NOT SAY ONE. The tray was launched and is still
   * bringing its engine up; a cold WSL guest genuinely takes longer than this.
   * What is wrong is only that this app stopped watching, so that is what it
   * says — and the next thing that asks (the Servers card's Test, the next
   * coordination sweep) will find it.
   */
  return {
    started: false,
    detail: 'Crucible was asked to start and has not answered yet. It is still coming up — '
      + 'Settings › Servers will find it, or try again in a moment.',
  };
}

function launch(via: CrucibleInvocation['via'], distro: string | null): void {
  if (via === 'windows-host') {
    const local = process.env['LOCALAPPDATA'] ?? '';
    const exe = windowsHostCommand(local);
    if (exe.includes('"') || exe.includes('%')) {
      throw new Error(
        `the path to Crucible (${exe}) contains a quote or a percent sign, which cmd.exe would `
        + 'read as syntax rather than as part of the name',
      );
    }
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${exe}" orchestrator"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  if (via === 'wsl-guest') {
    /*
     * NO WINDOWS TRAY, SO THERE IS NOTHING TO LAUNCH THAT OWNS THE ENGINE.
     *
     * This arm means the host pack is absent and Crucible lives only inside the
     * guest. Starting the guest's unit from here is exactly the mechanism the
     * header refuses to re-derive — the `XDG_RUNTIME_DIR` dance, whose failure
     * is silent and identical to a different failure — so this app does not try.
     * The honest answer is that the thing which owns the engine is not
     * installed, and the fix is to install it.
     */
    throw new Error(
      `Crucible is installed inside the WSL distribution ${distro ?? 'named in Settings'} but the `
      + 'Windows tray that starts and watches it is not installed on this computer. Install the '
      + 'Windows half from Crucible\'s own installer, or start the engine inside the guest '
      + 'yourself',
    );
  }
  const child = spawn(posixServerCommand(), ['service', 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/** Where the engine on this machine would be, for a sentence. Not a probe. */
export function localEngineHint(): string {
  return process.platform === 'win32'
    ? path.join(process.env['LOCALAPPDATA'] ?? '', 'Crucible')
    : posixServerCommand();
}
