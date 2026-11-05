/**
 * `bridge.ts` imports `vlm_page.py` with `{ type: 'text' }` so the compiled
 * binary carries the script's source as a string. Bun resolves that at build
 * time; tsc knows nothing about .py imports, so the shape is declared here.
 */
declare module '*.py' {
  const source: string;
  export default source;
}
