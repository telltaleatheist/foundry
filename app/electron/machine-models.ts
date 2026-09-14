/**
 * machine-models — every store of weights this app knows about on this machine,
 * with sizes, and the one of them Foundry is allowed to delete from.
 *
 * ── WHY THE ROW EXISTS AT ALL ───────────────────────────────────────────────
 *
 * Owen, 2026-09-14 (docs/SLOTS.md §5b): *"id really rather not have multiple
 * copies of gigantic models floating around… the models cant cross the wsl
 * barrier right?"* They can be reached across it and it does not help: ollama
 * holds its own quantised GGUF blobs, Crucible on WSL holds safetensors for
 * vLLM, Crucible on the Mac holds MLX weights. The 27B in each store is a
 * DIFFERENT FILE, so there is no sharing to arrange — only ownership to state,
 * and duplication to make visible. Hence §5b's last bullet: *"a 'Models on this
 * machine' settings row lists every store the app knows… with sizes, so
 * duplication is seen rather than discovered from a full disk."*
 *
 * ── ONE OWNER PER STORE, AND FOUNDRY OWNS EXACTLY ONE ───────────────────────
 *
 * **Foundry's own downloads** — the llama.cpp build and the two dots.ocr GGUF
 * files under `pageReaderDir()` — are the only things on this screen with a
 * Remove button, because they are the only things this app put there. The
 * removal deletes that directory and nothing else, and says the gigabytes it
 * freed (`removePageReader`, page-reader.ts).
 *
 * **Ollama is listed and never touched.** Owen: *"ollama has its own thing going
 * on and we should leave it be."* It is a model manager with its own store, its
 * own commands and its own idea of what is safe to delete; a Remove button here
 * would be this app reaching into somebody else's application data to save a
 * number on a screen. The sizes come from `/api/tags`, which reports them, and a
 * model it reports no size for is a null rather than a zero.
 *
 * **A local Crucible** is a line, and today it is a line saying there is none —
 * see `crucible-provider.ts` for why that is `unknown` and not `no`.
 *
 * ── AND THE RULE THAT IS BUILT BUT INERT ────────────────────────────────────
 *
 * §5b also says Foundry deletes the dots GGUF *"only when a LOCAL Crucible has
 * taken over that class (its capability record lists the class as served — not
 * merely 'a server was configured'), and never silently"*, and that *"a REMOTE
 * Crucible removes nothing… the settings row OFFERS removal with a number on it
 * and the sentence 'page reading will then need <server> to be reachable'."*
 * `pageReaderRemovalOffer` below is that rule, whole, computing what WOULD be
 * removed — and it cannot fire, because the provider seam answers `unknown`
 * until package C lands the registry and package E lands the settings surface.
 * It is written now, beside the inventory it belongs to, so that landing those
 * two is wiring a function up rather than rediscovering a ruling.
 */
import { readAppSettings } from './app-settings';
import { localCrucibleServes, localCrucibleSummary } from './crucible-provider';
import { LINEUP_PROVENANCE } from './llm-catalog';
import { probeOllama } from './ollama';
import {
  pageReaderDir,
  pageReaderFootprint,
  removePageReader,
} from './page-reader';
import type {
  MachineModelItem,
  MachineModels,
  MachineStore,
  RemovalOutcome,
} from '../shared/types';

/**
 * The whole inventory, measured now.
 *
 * NOTHING IS CACHED. Somebody who has just pulled a model in another window, or
 * deleted the page reader by hand, should see this screen say so the next time
 * they open it — and the cost is one directory walk plus one localhost request.
 */
export async function machineModels(): Promise<MachineModels> {
  const settings = readAppSettings();
  const ollama = await probeOllama(settings.ollamaUrl);

  const foundry = pageReaderFootprint();
  const foundryStore: MachineStore = {
    id: 'foundry',
    label: 'Foundry\'s own downloads',
    detail: foundry.items.length === 0
      ? `Nothing. Foundry has downloaded no weights to this machine; the page reader would go in ${pageReaderDir()}.`
      : `The local page reader, in ${pageReaderDir()}. Removing it here deletes these files and `
        + 'nothing else; installing it again downloads them back.',
    bytes: foundry.bytes,
    items: foundry.items,
    removable: foundry.items.length > 0,
  };

  const ollamaItems: MachineModelItem[] = ollama.holdings.map((held) => ({
    name: held.name,
    detail: 'Pulled through Ollama, which manages its own store.',
    bytes: held.bytes,
  }));
  const ollamaStore: MachineStore = {
    id: 'ollama',
    label: 'Ollama',
    detail: ollama.running
      ? `${ollama.detail} Foundry never removes anything from it — Ollama is its own model manager.`
      : ollama.detail,
    bytes: ollamaItems.reduce<number | null>(
      (sum, item) => (sum === null || item.bytes === null ? null : sum + item.bytes),
      0,
    ),
    items: ollamaItems,
    // NEVER, and it is not a capability this screen is waiting on. See the header.
    removable: false,
  };

  const crucibleSummary = localCrucibleSummary();
  const crucibleStore: MachineStore = {
    id: 'crucible',
    label: 'A Crucible on this machine',
    detail: crucibleSummary
      ?? 'None is configured. A Crucible serving a class takes over that class\'s weights, and this '
        + 'row will say which — the server registry lands with the slots (docs/SLOTS.md §6, '
        + 'package C).',
    bytes: null,
    items: [],
    removable: false,
  };

  return {
    stores: [foundryStore, ollamaStore, crucibleStore],
    generatedBy: LINEUP_PROVENANCE.generatedBy,
    generatedAt: LINEUP_PROVENANCE.generatedAt,
  };
}

/** Remove Foundry's own downloads. The one deletion this screen may perform. */
export function removeFoundryDownloads(): Promise<RemovalOutcome> {
  return removePageReader();
}

/** What §5b's rule would do about the page reader, and whether it may do it yet. */
export interface RemovalOffer {
  /** True only when a LOCAL Crucible is serving `pages`. `unknown` is not true. */
  automatic: boolean;
  /** The bytes it would free, measured. Null when the directory could not be walked. */
  bytes: number | null;
  /** The sentence the settings row shows. Always set, including "nothing to offer". */
  detail: string;
}

/**
 * SLOTS.md §5b, as a function: should the dots files go, and what would that cost?
 *
 * ── IT IS INERT, AND THAT IS THE DESIGN ─────────────────────────────────────
 *
 * `localCrucibleServes('pages')` answers `unknown` on every machine today
 * (crucible-provider.ts), and `unknown` takes the same branch as `no`: nothing
 * is removed and nothing is offered automatically. The three-valued answer
 * exists so that the day package C replaces that body, a silence cannot have
 * been quietly reading as a permission to delete three gigabytes.
 *
 * ── WHAT EACH ANSWER MEANS, WHEN THERE IS ONE ───────────────────────────────
 *
 * A **local** Crucible serving pages has taken over the class on this disk, so
 * the local reader's files are the duplicate and Foundry removes them — never
 * silently: the row says what went and what it freed.
 *
 * A **remote** Crucible removes NOTHING, and this function will not offer it
 * either, because `localCrucibleServes` is the only question it asks. Owen:
 * *"configured is not present — the local reader is what works when the Mac is
 * asleep."* The remote case is an OFFER with a number on it and a sentence about
 * what page reading will then depend on, and that offer is package E's surface
 * to draw: it needs the server's NAME, which lives in package C's registry.
 *
 * Nothing calls this yet. Package C/E wires it to the settings row.
 */
export function pageReaderRemovalOffer(): RemovalOffer {
  const footprint = pageReaderFootprint();
  if (footprint.items.length === 0) {
    return {
      automatic: false,
      bytes: 0,
      detail: 'Foundry has downloaded no page reader here, so there is nothing to remove.',
    };
  }

  if (localCrucibleServes('pages') === 'yes') {
    return {
      automatic: true,
      bytes: footprint.bytes,
      detail: 'A Crucible on this machine is reading pages, so Foundry\'s own copy of the reader is '
        + 'a duplicate and can be removed.',
    };
  }

  return {
    automatic: false,
    bytes: footprint.bytes,
    detail: 'Nothing else on this machine reads pages, so Foundry\'s copy is the one that works. '
      + 'Removing it is yours to ask for.',
  };
}
