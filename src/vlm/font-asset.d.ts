/**
 * `pdf-layer.ts` imports `assets/DejaVuSans.ttf` with `{ type: 'file' }` so the
 * compiled binary CARRIES the font and hands back a path that reads back out of
 * its own filesystem. Bun resolves that at build time; tsc knows nothing about
 * .ttf imports, so the shape is declared here — the same seam, and for the same
 * reason, as `py-text.d.ts`.
 *
 * A path rather than the bytes, because a 757 KB font inlined as a string
 * literal is a 757 KB string literal every tool that touches this repo has to
 * carry through memory. `fs.readFileSync` off the returned path costs one read
 * per run and works identically on a `bun run` off the tree and inside a
 * `bun build --compile` binary, where the path is under `/$bunfs`.
 */
declare module '*.ttf' {
  const filePath: string;
  export default filePath;
}
