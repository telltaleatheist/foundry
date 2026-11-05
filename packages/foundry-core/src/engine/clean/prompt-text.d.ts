/**
 * `prompt.ts` imports the two prompt files with `{ type: 'text' }` so the
 * compiled binary carries them as strings. Bun resolves that at build time;
 * tsc knows nothing about .txt imports, so the shape is declared here.
 *
 * The precedent is `src/vlm/py-text.d.ts`, for the same reason: foundry ships
 * ONE FILE (ARCHITECTURE §1), and a prompt read off disk at run time is a path
 * that exists in the checkout and nowhere on a user's machine.
 */
declare module '*.txt' {
  const source: string;
  export default source;
}
