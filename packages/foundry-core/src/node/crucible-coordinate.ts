/**
 * THE ONE OWNER OF "make sure this server has what Foundry needs".
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a. Owen, 2026-09-14: *"if its present,
 * bookforge should coordinate with the installed crucible to make sure it has
 * what it needs to run all of its features"* — and, on the whole install story,
 * *"this whole process needs to be idiot proof."* The ruling names BookForge
 * because BookForge asked first; it is about the APP. Foundry needs a text
 * engine and three models on whatever machine it is pointed at, and the two
 * apps' modules are a UNION on a shared server rather than a competition. So
 * there is no button here either. Every time Foundry finds a Crucible it
 * coordinates with it, and the row draws what happened.
 *
 * ── ASK, THEN ACT ──────────────────────────────────────────────────────────
 *
 * The amendment Foundry's own review produced (crucible `cecfdd0`) and the
 * reason it is not merely tidier:
 *
 *   1. READ `GET /v1/info`, `GET /v1/catalog` and `GET /v1/capability`. All
 *      three are cheap, read-only, and touch neither the lane nor the card.
 *   2. Compare the vendored module (`shared/foundry.module.json`) against them.
 *   3. Nothing missing → STOP. No task is posted at all.
 *   4. Something missing → post the module and follow its events.
 *
 * The third read is crucible `docs/PHASE15-HOST.md` §5.3a's (crucible
 * `e342fee`): the module's `needs` carry CAPABILITY CLASSES, unresolved, and the
 * engine's own capability record is the one place a class becomes an id. A class
 * that engine has disabled is NOT missing and NOT a refusal — it is UNMET, the
 * task still finishes `done`, and the row says "not on this engine".
 *
 * A module is idempotent (installed entries come back `skipped`), so posting
 * one on every connect would have been *correct* and still wrong: a Crucible
 * runs ONE task at a time, so a task whose whole content is `skipped` events is
 * a task the other app on this machine collides with (`task_busy`). The cheapest correct thing and the cheapest thing are
 * the same thing here, which is why the read comes first.
 *
 * ── NOTHING TO PRESS, ON ANY SERVER ────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"lets make it as simple as possible."* Coordination is
 * automatic on every server this app is connected to, however long ago it was
 * registered (crucible `1a10cc8`). The one way to say "not that one" is the
 * ENABLE switch that already means it, which is why {@link coordinateServer}
 * refuses a disabled server by name rather than inventing a second opinion about
 * which servers count.
 *
 * THERE IS NO `local` CONSTANT IN THIS APP and none is introduced here. Owen's
 * ruling: *"it shouldnt be named 'local' anywhere. it might not be local. a
 * local crucible server shouldnt be treated any differently than a remote
 * crucible server."* So this module asks every enabled server the same question
 * in the same way, and {@link coordinateEveryServer} takes them IN THE
 * REGISTRY'S ORDER — the operator's own drag rank — rather than putting an
 * address at the front of the queue.
 *
 * ── THE THREE THINGS THAT CAN COME BACK, AND WHY EACH IS ITS OWN ACT ───────
 *
 * - **`task_busy`** — a task is already running on that server. It is FOLLOWED,
 *   never re-posted: there is no queue for tasks (PHASE13 §3.3), so a second
 *   post is simply refused again, and joining the stream of the one in flight
 *   is the only way to end up drawing the truth.
 * - **A held card is not one of them.** Since Crucible 2.0 a module task is
 *   never refused `server_busy`: it downloads beside whatever holds the card,
 *   so there is nothing here to wait for.
 * - **A refusal about the REQUEST** — `invalid_module`, `unknown_subject`. It
 *   fails ONCE, by name, and is remembered for the rest of the session: the
 *   vendored file cannot change while the app runs, so re-posting it would be
 *   the same wrong answer on a timer (R3 wants the loud wrong answer once, not
 *   forever).
 * - **Anything else** — unreachable, not a Crucible, a wrong token. Nothing was
 *   posted and the state says so.
 *
 * ── AND NEVER TWICE AT ONCE FOR ONE SERVER ─────────────────────────────────
 *
 * Three moments call this (app start for every enabled server, a server added,
 * a server re-enabled or newly named by a registry save) and two of them can
 * happen inside a second of each other — `crucible:add` runs the start sweep's
 * server again the moment somebody presses the wizard's button. {@link inFlight}
 * is what makes the second one join the first instead of racing it into the
 * `task_busy` this whole design exists to avoid.
 *
 * ── AND NOT ONE LOG LINE CARRIES A TOKEN ───────────────────────────────────
 *
 * Nothing in this file reads `entry.token` except `engineClientFor`, which is
 * where the registry already says the token meets the SDK. Every sentence
 * composed here names a server, a code or the server's own message, and a
 * server's own message is the SDK's — see `crucible-registry.ts`'s header for
 * the rule this keeps.
 */
export { FOUNDRY_MODULE, foundryModuleForBackend } from './crucible-coordinate-module';
export { coordinationStates, onCoordination } from './crucible-coordinate-state';
export { missingForFoundry } from './crucible-coordinate-missing';
export { coordinateServer, coordinateEveryServer, prepareFoundryForUse } from './crucible-coordinate-run';
export { followTask } from './crucible-coordinate-task';
