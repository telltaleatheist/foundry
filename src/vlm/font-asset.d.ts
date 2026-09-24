/**
 * `pdf-text.ts` imports the four `assets/DejaVuSerif*.ttf` faces with
 * `{ type: 'file' }`, which hands back a PATH to each face: Bun's own meaning
 * under `bun run`, and what tools/build-engine.mjs gives the engine bundle (the
 * faces are copied to `app/engine/assets/` beside it). Bun resolves it for itself;
 * tsc knows nothing about .ttf imports, so the shape is declared here — the
 * same seam, and for the same reason, as `py-text.d.ts`.
 *
 * A path rather than the bytes, because a 380 KB font inlined as a string
 * literal is a 380 KB string literal every tool that touches this repo has to
 * carry through memory. `fs.readFileSync` off the returned path costs one read
 * per face that is actually used, and works identically on a `bun run` off the
 * tree and in the engine bundle.
 */
declare module '*.ttf' {
  const filePath: string;
  export default filePath;
}
