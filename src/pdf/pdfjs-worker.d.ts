/**
 * pdf.js ships no types for its worker bundle, because nothing is meant to
 * import it directly — it is loaded by a URL in a browser and by a dynamic
 * import in Node. Foundry imports it statically anyway (see `runtime.ts`: a
 * dynamic import is not bundled into a compiled binary), so the module needs a
 * declaration. `WorkerMessageHandler` is the only export pdf.js looks for on
 * `globalThis.pdfjsWorker`, and its shape is pdf.js's own business.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
