# Foundry Mac API acceptance — 2026-09-16

Published Windows CLI Foundry 2.0.2 (`24f586b`) called the Mac's installed Crucible
0.6.2 engine over its authenticated API. The Mac reported `mlx-darwin`, API1 and
64 GiB unified memory. Credentials were captured privately over SSH, parsed by
the SDK and passed only through process environment; they are absent from artifacts.

## Input and scope

A disposable one-page born-digital PDF contains a visit to a library: opening at
nine, seventeen red apples carried to a blue house, three trees, and a yellow bird
beside a window. Local PyMuPDF extracted its text; a minimal EPUB carried it into
the actual CLI `vlm-book` command, producing two stable v3 book rows. CPU extraction
and EPUB wrapping are fixture preparation, not a new Foundry product feature.

This exercises real CLI book import, cleanup and translation via Crucible. It does
not exercise Electron's queue/UI, image OCR, a complete production book, or native
Windows inference. Mac `pages` is disabled because dots-ocr has no supported
mlx-darwin manifest. No model was downloaded and no server default was changed.

## Measured results

| Operation | Model | Requests | CLI duration | Result |
| --- | --- | ---: | ---: | --- |
| Cleanup, selected default | qwen3.5-9b | 2 | 10.3 s | 2 records and narration stamp; source preserved exactly |
| Spanish translation, explicit fixture model | qwen3.5-9b | 2 | 3.4 s | 2 records, no bank reuse |
| Spanish translation, explicit fixture model | qwen3.8-27b-4bit | 2 | 5.8 s | 2 records, no bank reuse |

Both translations returned the same text:

> Una visita a la biblioteca
>
> La biblioteca abre a las nueve de la mañana. María trae diecisiete manzanas
> rojas a la casa azul. El jardín tiene tres árboles. Un pequeño pájaro amarillo
> canta junto a la ventana.

Manual semantic review confirms all numbers, colors, objects and actions are
preserved. The tests asserted nonempty records and key vocabulary. Each inference
step used an explicit renewable model lease, released in finally; cleanup only
settled models loaded by this test. The final authenticated activity read showed
no resident model, warming, claim, lease, chat, running job or queued job, and
`acceptsWork=true`. The GPU was handed back to the parent audit at that point.

## Default readiness remains distinct

| Model | Backend supported | Installed | Selected role |
| --- | --- | --- | --- |
| dots-ocr | no | no | pages disabled |
| qwen3.5-9b | yes | yes | clean |
| qwen3.8-27b | yes | no | translate, simplify, analysis |
| qwen3.8-27b-4bit | yes | yes | explicit acceptance model only |

The initial default translation check correctly stopped before loading or pulling
because `qwen3.8-27b` is not installed. The later explicit-model tests prove the
route and outputs; they do not make the saved default ready. This is expected
for a lightweight Crucible upgrade that leaves app requirements to app setup.
Foundry must prepare the selected model or let the user change the selection;
it must not silently substitute the installed quantization.

## Retained artifacts

Local directory: `C:/Users/tellt/Projects/foundry/dist/acceptance-mac/`.
`PREPARED.md` describes the guarded reproduction runner. `run.ts`, fixture PDF,
extracted text/EPUB, book JSONL, records, narration stamp, per-operation logs,
selected-default refusal, both translation results and final activity snapshot
remain there. `artifact-sha256.json` identifies the exact bytes. No release asset
or application source was changed for this acceptance test.

Fixture PDF SHA256: `DB831E7D9D32EBBB529D6252ED7F219E6714D5817E6B16209E1BA16CD1D8AE41`.
Book JSONL SHA256: `7D514183C083E3305C0F4AF2FD45EB9C87143279D99CE2BC509264A0C49F248A`.
