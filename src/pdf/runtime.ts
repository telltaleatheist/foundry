/**
 * runtime — the ONE place that loads pdf.js, and the two shims that let it run
 * inside `bun build --compile`.
 *
 * pdf.js is the text-extraction path (`src/pdf/extract.ts`). It is pure
 * JavaScript, which is the hard constraint here — foundry ships as a single
 * `bun build --compile` executable and a native or wasm dependency simply does
 * not survive that (ARCHITECTURE §1). But the stock library does not start in a
 * compiled binary, for two reasons that are both about the environment rather
 * than about PDFs:
 *
 *  1. **`DOMMatrix` and `Path2D`.** pdf.js's canvas renderer constructs one of
 *     each at MODULE LOAD. In Node it obtains them from the optional
 *     `@napi-rs/canvas` package — a NATIVE module, which is exactly what cannot
 *     be embedded. So the two are stubbed here, before pdf.js is imported. They
 *     are never called: text extraction does not rasterize anything. The stubs
 *     exist so a module can be loaded, not so a page can be drawn, and anything
 *     that actually tries to draw gets the error rather than a wrong picture.
 *  2. **The worker.** pdf.js loads its worker with a dynamic
 *     `import('./pdf.worker.mjs')`, and a dynamic import of a path that only
 *     exists in node_modules is not bundled into the executable — the compiled
 *     binary fails with `Cannot find module './pdf.worker.mjs'`. The documented
 *     escape is `globalThis.pdfjsWorker`: when it carries a
 *     `WorkerMessageHandler`, pdf.js runs the worker in-process and never
 *     resolves a path. So the worker is imported STATICALLY, which is what puts
 *     it in the bundle.
 *
 * Both are verified by `test/pdf/compile.test.ts`, which builds a real binary
 * and runs it. A shim that works under `bun run` and not under `bun compile` is
 * the failure this file exists to prevent, and only a compiled binary can prove
 * it did not happen.
 *
 * The legacy build is used deliberately: it is the one pdf.js ships for
 * non-DOM runtimes.
 */
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfjsModule> | null = null;

function installShims(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  if (!g['DOMMatrix']) {
    g['DOMMatrix'] = class FoundryNoDOMMatrix {
      constructor() {
        // Constructed at module load by pdf.js's canvas layer; never used by
        // text extraction. Every METHOD throws (below) so a rendering path
        // that reached here fails loudly instead of drawing with an identity.
      }
      scaleSelf(): never { throw new Error('DOMMatrix: foundry does not render PDF pages, only reads their text'); }
      translateSelf(): never { throw new Error('DOMMatrix: foundry does not render PDF pages, only reads their text'); }
      multiplySelf(): never { throw new Error('DOMMatrix: foundry does not render PDF pages, only reads their text'); }
      invertSelf(): never { throw new Error('DOMMatrix: foundry does not render PDF pages, only reads their text'); }
    };
  }

  if (!g['Path2D']) {
    g['Path2D'] = class FoundryNoPath2D {
      addPath(): never { throw new Error('Path2D: foundry does not render PDF pages, only reads their text'); }
      moveTo(): never { throw new Error('Path2D: foundry does not render PDF pages, only reads their text'); }
      lineTo(): never { throw new Error('Path2D: foundry does not render PDF pages, only reads their text'); }
    };
  }

  // The in-process worker. Set BEFORE getDocument is ever called; pdf.js reads
  // it once and caches the handler.
  g['pdfjsWorker'] = pdfjsWorker;
}

/**
 * Load pdf.js, shimmed, once.
 *
 * The import is dynamic so the shims are installed first — pdf.js constructs a
 * `DOMMatrix` while its module body runs, so an import that hoisted above
 * `installShims()` would throw before a single line here executed.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (loading) return loading;
  loading = (async () => {
    installShims();
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return loading;
}
