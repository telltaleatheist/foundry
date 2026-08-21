// OPEN THE WINDOW AND MEASURE WHAT IS IN IT. A TOOL, NOT A GATE.
//
// Owen's ruling is the first thing to say about this file: it is a thing you
// REACH FOR ON A UI WAVE, not a seventh gate. Nothing in CI runs it, no commit
// waits on it, and it will not be added to the six. It is a screwdriver.
//
// ── WHY IT EXISTS: THE GATES HAVE NEVER CAUGHT WHAT A PERSON CLICKING FOUND ──
//
// Blank capture cards, stale previews, a split that appeared to do nothing, an
// unrotated modal image, two routes to Home in a hosted window, and the third
// cost of Wave 21. Every one of them typechecked, built, and passed 418 tests.
// They were all found by somebody opening the app and looking at it.
//
// The blank cards are the argument in miniature. Three separate hand-built
// harnesses reproduced the component and all three agreed with each other to
// within ten pixels -- and all three were wrong, because the defect was not a
// property of the component. It was a property of the component inside a `1fr`
// track inside a flex column: `.shot` carried an `aspect-ratio` and no in-flow
// content, so its used width resolved to 0 and the ratio times zero was zero in
// both axes. `getComputedStyle(.shot).width` was 0px broken and 295.333px
// fixed, with `aspect-ratio` reading "1.33333 / 1" IN BOTH.
//
// A test that could see that has to stand up the whole chain -- at which point
// it IS the app. So the missing instrument is not a better unit test; it is a
// different KIND of thing: the real app, really running, measured.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
// A harness. It mounts a real Foundry against a library you name, opens a real
// window with the opacity at zero and off the taskbar, and hands your walk the
// window plus five verbs. The walk does the looking. Runs in about the time one
// Electron start takes -- forty seconds for the walks written so far.
//
//   electron tools/open-and-measure.js --library <dir> --walk <file.js>
//                                      [--project <dir>] [--hosted] [--tag <name>]
//
// The walk is a module exporting one async function:
//
//   module.exports = async ({ win, say, where, until, press, shoot, dirs }) => { … }
//
//     say(object)          one JSON line on stdout, prefixed PROBE
//     where()              what is on screen, by ELEMENT: home, capture, pdf, book, held, tabs
//     until(expr, n, ms)   poll a page expression until it answers truthy
//     press(selector)      click the first match; answers whether there was one
//     shoot(name)          a PNG beside the walk file
//     dirs                 { app, library, project }
//
// ── THREE RULES THIS FILE ENFORCES RATHER THAN DOCUMENTS ─────────────────────
//
// 1. IT REFUSES TO RUN AGAINST A LIBRARY IT WAS NOT POINTED AT. `projectsDir()`
//    is checked against `--library` after the mount and before a window exists,
//    because a settings file left over from another run is exactly how an
//    instrument ends up writing into somebody's real projects. Copies only.
// 2. IT PRINTS THE TREE UNDER TEST WITH THE RESULT. The one mistake this
//    instrument has already made was measuring a `dist/` that had been rebuilt
//    underneath it and reporting the repair as the defect. A result without the
//    build it came from is not a measurement.
// 3. IT WAITS FOR THINGS TO ARRIVE, NOT FOR THINGS TO NOT HAVE LEFT. A
//    predicate that is true in the state you are leaving is not a predicate
//    about arriving -- "the mint button exists" is true one millisecond after
//    the click, and reported a mint that had not begun. `until` is for the
//    arrival; two of them in a row is how you wait for something to finish.
//
// ── WHAT IT IS HONESTLY BLIND TO ─────────────────────────────────────────────
//
// It sees the DOM and the pixels of a window nobody is looking at. It cannot
// see a pointer, a hover, a drag, a scroll under momentum, or anything a
// compositor does differently when a window has focus. A `click()` is not a
// press: it skips hit-testing, so an element covered by an overlay still
// answers. Said here rather than implied, because an instrument that is quiet
// for a reason nobody wrote down is the next thing to be trusted too far.
//
// ── ESM, WITH ONE `createRequire` FOR THE APP'S OWN BUILD ────────────────────
//
// The repo is `"type": "module"` and its other tool is ESM, so this one is too.
// What it loads out of `app/dist/electron/` is NOT: that build is CommonJS, and
// it is loaded by an absolute path composed at runtime, which is a `require`
// either way. One bridge, named, rather than a file that is the other thing.
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { app, BrowserWindow } from 'electron';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));

function options(argv) {
  const read = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  return {
    library: read('library'),
    walk: read('walk'),
    project: read('project'),
    tag: read('tag') ?? 'walk',
    hosted: argv.includes('--hosted'),
  };
}

const say = (what) => process.stdout.write(`PROBE ${JSON.stringify(what)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/*
 * A FAILED WALK MUST NOT PUT A DIALOG ON SOMEBODY'S SCREEN.
 *
 * This runs offscreen so that measuring the app never interrupts the person
 * using the machine — and Electron's default handler for an uncaught exception
 * in MAIN is `showErrorBox`, a modal, in front of whatever they were doing. It
 * happened: a `require` in an ESM file put a stack trace over Owen's desk.
 *
 * The window being invisible was never the promise. The promise is that running
 * this costs the machine's owner nothing, and a modal is not nothing — so the
 * failure goes to stdout, where every other answer from this tool goes, and the
 * process leaves.
 */
for (const fatal of ['uncaughtException', 'unhandledRejection']) {
  process.on(fatal, (err) => {
    say({ [fatal]: String(err && err.stack ? err.stack : err) });
    process.exit(1);
  });
}

/*
 * WHAT IS ON SCREEN, NAMED BY ELEMENT. Never by prose: a walk that matched on a
 * sentence would go green the day somebody rewrote the sentence, and red the day
 * they improved it. A component's selector is its identity.
 */
const WHERE = '(() => ({'
  + ' home: !!document.querySelector("app-home"),'
  + ' capture: !!document.querySelector("app-capture-view"),'
  + ' pdf: !!document.querySelector("app-pdf-view"),'
  + ' book: !!document.querySelector("app-book-view"),'
  + ' held: !!document.querySelector(".held"),'
  + ' tabs: document.querySelectorAll("app-open-documents .card").length,'
  + '}))()';

/*
 * ── LOADED BEFORE THE APP IS READY, WHICH IS NOT A STYLE CHOICE ─────────────
 *
 * `mount.js` calls `protocol.registerSchemesAsPrivileged` AT MODULE LOAD, and
 * Electron refuses that call once the app is ready — `foundry-file://` has to be
 * declared privileged before the first renderer exists or nothing can be served
 * through it. So the app's build is required here, at module scope, and the
 * userData path is set here too because it must be set before anything reads it.
 *
 * Everything below the ready gate is therefore about a Foundry that is already
 * loaded and not yet mounted, which is the same order `app/electron/main.ts`
 * uses and the reason this works at all.
 */
const opts = options(process.argv);
const usable = opts.library !== null && opts.walk !== null;
const library = usable ? path.resolve(opts.library) : '';
const walkFile = usable ? path.resolve(opts.walk) : '';
const appDir = path.resolve(here, '..', 'app');
if (usable) {
  const store = path.join(library, '.open-and-measure');
  fs.mkdirSync(store, { recursive: true });
  app.setPath('userData', store);
}
const mount = usable ? require(path.join(appDir, 'dist', 'electron', 'mount.js')) : null;
const projects = usable ? require(path.join(appDir, 'dist', 'electron', 'projects.js')) : null;

async function main() {
  if (!usable) {
    say({ refused: 'usage: electron tools/open-and-measure.js --library <dir> --walk <file.js>' });
    app.exit(2);
    return;
  }
  const userData = app.getPath('userData');

  if (opts.hosted) {
    /*
     * A HOST IS A LIBRARY AND A WAY OUT. `hosted()` in main is `host !== null`
     * and nothing reads a member of it but `libraryDir` unless an export lands,
     * so this is a whole host as far as any question about hosted BEHAVIOUR is
     * concerned -- the same switch BookForge flips, reached the same way,
     * without BookForge.
     */
    mount.mountFoundry({ libraryDir: library, onExport: () => undefined });
  } else {
    fs.writeFileSync(path.join(userData, 'app-settings.json'),
      JSON.stringify({ libraryDir: library }, null, 2));
    mount.mountFoundry();
  }

  // RULE 1, before there is a window to do anything with.
  const resolved = projects.projectsDir();
  const inside = path.resolve(resolved).toLowerCase().startsWith(library.toLowerCase());
  if (!inside) {
    say({ refused: `projectsDir() is ${resolved}, which is not under ${library}` });
    app.exit(3);
    return;
  }
  // RULE 2.
  say({ app: appDir, library, projectsDir: resolved, hosted: opts.hosted, tag: opts.tag });

  mount.openFoundryWindow(opts.project ?? undefined);
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined) {
    say({ refused: 'no window was made; a project with nothing openable in it opens none' });
    app.exit(4);
    return;
  }
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.showInactive();

  const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
  const until = async (expression, tries = 60, gap = 500) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const got = await evaluate(expression);
      if (got) return got;
      await sleep(gap);
    }
    return null;
  };
  await until('document.querySelector("app-workspace") ? true : null');

  const walk = require(walkFile);
  try {
    await walk({
      win,
      say,
      sleep,
      evaluate,
      until,
      where: () => evaluate(WHERE),
      press: (selector) => evaluate(
        `(() => { const it = document.querySelector(${JSON.stringify(selector)});`
        + ' if (!it) return false; it.click(); return true; })()'),
      shoot: async (name) => {
        const image = await win.webContents.capturePage();
        const file = path.join(path.dirname(walkFile), `${opts.tag}-${name}.png`);
        fs.writeFileSync(file, image.toPNG());
        return file;
      },
      dirs: { app: appDir, library, project: opts.project },
    });
    say({ done: true });
    app.exit(0);
  } catch (err) {
    say({ walkThrew: String(err && err.stack ? err.stack : err) });
    app.exit(1);
  }
}

app.whenReady().then(main).catch((err) => {
  say({ threw: String(err && err.stack ? err.stack : err) });
  app.exit(1);
});
