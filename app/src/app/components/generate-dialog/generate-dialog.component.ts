/**
 * THE OLD NAME OF THE EXPORT DIALOG, kept alive for exactly one import.
 *
 * Generate became Export — a different landing, a different ruling, and the word
 * is gone from the window (docs/WORKBENCH.md §6). The component moved with it,
 * to `../export-dialog/export-dialog.component`, and everything about it is
 * there.
 *
 * WHAT IS LEFT HERE IS A SEAM AND NOT A CONVENIENCE. The shell mounts the dialog
 * and routes Escape to it (`app.ts`), and that file belongs to the unit that
 * rebuilds the pane chrome — which runs after this one. A rename that took the
 * module path with it would have left the app unable to compile in between, so
 * the path answers to the new class under the old name, and the component
 * answers to the old tag as well as the new one.
 *
 * THIS FILE IS MEANT TO BE DELETED. When `app.ts` is next opened it imports
 * `ExportDialogComponent` from its own directory and writes `<app-export-dialog />`,
 * and then this line, the second selector on the component, and the two aliases
 * on `UiService` all go together. A re-export that outlives its reason is how a
 * codebase ends up with two names for one thing and nobody sure which is real.
 */
export { ExportDialogComponent as GenerateDialogComponent } from '../export-dialog/export-dialog.component';
