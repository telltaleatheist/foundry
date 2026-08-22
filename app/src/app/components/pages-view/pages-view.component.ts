import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import type { Tab } from '../../core/documents.service';
import { api } from '../../core/foundry';
import { NoticeService } from '../../core/notice.service';

/**
 * THE BOOK A MINT MADE — its pages, one under the next, scrolled like a PDF.
 *
 * ── What was asked for, and why nothing already answered it ─────────────────
 *
 * *"when i do finalize, it creates 'this book' in the worktree. correct. but
 * when i click it, i expected it to take me to a pdf-like layout (even if we
 * havent assembled into a pdf officially yet) where i can scroll through each
 * page as it would look in a pdf. then i can run OCR on it, then i can strike
 * things… thats what i expected."* (Owen, 2026-08-22.)
 *
 * The parenthesis is the whole reason this component exists rather than a route
 * into `app-pdf-view`. A mint used to assemble an image-only PDF and the next
 * thing that happened to it was a rasteriser turning it back into one image per
 * page, so Owen ruled the container out — *"i agree that this doesnt need to be
 * a pdf"* (`recordMint`, electron/projects.ts) — and what a capture project
 * holds now is a FOLDER of rectified page images in `archive/`. There is no file
 * for pdf.js to open, and there is not going to be one until somebody asks for
 * the export. So the pages are drawn as what they are.
 *
 * ── It is the third surface, and the thinnest of the three ─────────────────
 *
 * `app-book-view` draws blocks and edits them; `app-capture-view` arranges
 * photographs and writes a recipe. This one SHOWS, and holds nothing: no
 * gestures, no state that outlives a load, nothing to save. A scan is a
 * photograph and this app does not edit one (docs/RENDERER.md §0 A1) — a minted
 * page is a photograph twice over, being a rectified crop of one — and what
 * turns it into something editable is a reading, which is OCR's job and lives in
 * the dock where every other act does.
 *
 * ── THE TAB IS A DIRECTORY, SO THE LOAD LIVES IN AN EFFECT ─────────────────
 *
 * `Tab.path` is the project directory (`pathIsProject`, documents.service), so
 * nothing arrives through `document:opened` and there is no file to read. The
 * pages come from `capture:pages-load`, asked for whenever the tab OR its
 * revision changes — an input can be re-pointed at another project without this
 * component being rebuilt, and the revision is how the position tells this
 * surface that the pointer moved onto a different mint (`showPages`,
 * core/position-sync.service.ts). A project can hold two mints and they are two
 * different books behind one tab path; main reads the pointer to decide which.
 *
 * ── A REFUSAL IS DRAWN HERE, NOT ONLY ANNOUNCED ────────────────────────────
 *
 * Main refuses a project with no mint, or one whose page folder has been moved,
 * in the app's own voice. That sentence goes BOTH to the notice (where every
 * other refusal in this app is said) and onto this surface, because a viewer
 * that drew an empty scroller would look like a book with no pages in it — and
 * the person is standing in front of it, not watching the strip.
 */
@Component({
  selector: 'app-pages-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (refused(); as said) {
      <p class="refused">{{ said }}</p>
    } @else if (leaves().length === 0) {
      <p class="waiting">{{ nothingYet() }}</p>
    } @else {
      <div class="viewport">
        <div class="reel">
          @for (leaf of leaves(); track leaf.url) {
            <figure class="page">
              <!--
                LAZY, AND THE RESERVED BOX IS WHAT MAKES LAZY MEAN ANYTHING. A
                photographed book is hundreds of pages of full-size JPEG, and an
                image with no height yet is an image inside the viewport — so
                without a box reserved before the bytes arrive the browser would
                decide every page was on screen and fetch the whole shoot at
                once. \`aspect-ratio: auto <ratio>\` is the exact tool: the ratio
                holds the slot open until the picture loads and the picture's own
                proportions take over the moment they are known, which matters
                because a mint rectifies each page to its own corners and no two
                need be the same shape.
              -->
              <img [src]="leaf.url" [alt]="leaf.said" loading="lazy" decoding="async" />
              <figcaption>{{ leaf.said }}</figcaption>
            </figure>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }

    .viewport { width: 100%; height: 100%; overflow: auto; }
    .reel {
      display: flex; flex-direction: column; align-items: center;
      gap: 22px; padding: 22px 14px 40px;
    }

    /*
      THE PAPER IS WHITE AND THE SHADOW IS THE PDF VIEWER'S, deliberately: the
      person asked for a layout that looks like a PDF, and the only honest way to
      answer that is for a page here and a page there to sit on the same
      furniture. The width is capped rather than natural — a rectified page can
      be four thousand pixels across, and a viewer that made you scroll sideways
      to read one is not the thing that was asked for.
    */
    .page { width: 100%; max-width: 880px; margin: 0; }

    /*
      THE PAPER IS THE PICTURE and not the figure around it, which is the one
      thing worth getting right here: the figure also holds the caption, so a
      white background on IT would paint a slab of paper behind a line of chrome
      text. The white is under the image alone, where a page's own margins are.
    */
    .page img {
      display: block; width: 100%; height: auto; aspect-ratio: auto 1 / 1.4;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    /*
      The number sits UNDER the page rather than on it. A minted page is a
      photograph of somebody's book and anything painted over it is a mark on
      their book; the caption is chrome, so it lives on the chrome's ground.
    */
    .page figcaption {
      padding: 8px 2px 0;
      color: var(--text-tertiary); font-size: 11px; letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums; text-align: center;
    }

    .refused, .waiting {
      margin: 0; padding: 40px 32px;
      color: var(--text-secondary); font-size: 13px; text-align: center;
      max-width: 46ch; margin-inline: auto;
    }
    .waiting { color: var(--text-tertiary); font-style: italic; }
  `],
})
export class PagesViewComponent {
  readonly tab = input.required<Tab>();

  private readonly notices = inject(NoticeService);

  /** The door token and the page names, as main last answered them. */
  private readonly held = signal<{ token: string; pages: string[] }>({ token: '', pages: [] });
  protected readonly refused = signal<string | null>(null);

  /**
   * WHICH ANSWER IS THE CURRENT ONE, because a load can be overtaken.
   *
   * Clicking down a history — the light table's row, then a mint, then the one
   * before it — issues one of these per move, and main answers them in whatever
   * order the disk feels like. Without a generation the surface could settle on
   * the pages of a row nobody is standing on any more and stay there until the
   * next click. It is the ticket idiom `showPosition` uses for the same hazard,
   * and it is the whole of the care this component needs.
   */
  private generation = 0;

  constructor() {
    effect(() => {
      const dir = this.tab().path;
      // READ AND NOT USED: the revision is how the position says "the pointer
      // moved onto a different mint" for a tab whose path never changes. See
      // `showPages`.
      void this.tab().revision;
      void this.load(dir);
    });
  }

  /**
   * Every page as something the template can draw.
   *
   * THE URL IS COMPOSED HERE AND THE NAME NEVER LEAVES IT. A page's basename is
   * bookkeeping — `page-0007.jpg` — and this app does not put filenames in front
   * of people (docs/PLAN.md §1). What it says is the number, counted off the
   * order the folder is in, which IS the reading order: the mint writes the names
   * zero-padded so that a plain sort is the book.
   */
  protected readonly leaves = computed(() => {
    const { token, pages } = this.held();
    if (token.length === 0) return [];
    return pages.map((name, index) => ({
      url: `foundry-file://capture/${token}/${encodeURIComponent(name)}`,
      said: `Page ${index + 1}`,
    }));
  });

  /**
   * What an empty reel says, and the two cases are not the same sentence.
   *
   * BEFORE THE ANSWER ARRIVES it is a round trip in flight, and the honest word
   * is that the pages are coming. AFTER an answer with nothing in it, the folder
   * this project filed its book in holds no picture anybody can draw — a mint
   * cannot produce that (`recordMint` refuses a fill that wrote nothing), so it
   * means somebody has been in the folder. Saying "fetching" forever would be
   * this surface waiting for a delivery that has already been made.
   */
  protected readonly nothingYet = computed(() => this.held().token.length === 0
    ? 'Fetching the pages…'
    : 'The folder this book was filed in holds no pages. Minting the photographs again makes them '
      + 'anew.');

  private async load(projectDir: string): Promise<void> {
    const mine = ++this.generation;
    if (!api) return;
    try {
      const answer = await api.capture.pagesLoad(projectDir);
      if (mine !== this.generation) return;
      this.refused.set(null);
      this.held.set({ token: answer.token, pages: answer.pages });
    } catch (err) {
      if (mine !== this.generation) return;
      const said = err instanceof Error ? err.message : String(err);
      /*
       * BOTH PLACES, and the duplication is the point. The strip is where this
       * app says everything it refuses, so a person who looked away still finds
       * it; the surface is where the person actually is, and a blank scroller
       * that said nothing would read as a book with no pages rather than as an
       * answer.
       */
      this.held.set({ token: '', pages: [] });
      this.refused.set(said);
      this.notices.notice.set(said);
    }
  }
}
