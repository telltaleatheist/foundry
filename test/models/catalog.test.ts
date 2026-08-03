/**
 * Catalog invariants.
 *
 * Most of this runs `assertCatalogValid` against synthetic entries: the
 * function is the thing being tested, and it is what will catch the copy-paste
 * that leaves the previous version's filename or hash in place when a new
 * entry lands. The shipped entries get their own pinned-facts checks below.
 */
import { describe, expect, test } from 'bun:test';

import {
  assertCatalogValid,
  defaultModelFor,
  FOUNDRY_MODELS,
  getModelDef,
  modelsFor,
  parseModelId,
  requireDefaultModel,
  type FoundryModelDef,
} from '../../src/models/catalog.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function entry(over: Partial<FoundryModelDef> = {}): FoundryModelDef {
  return {
    id: 'foundry-blocks-v1-4b',
    name: 'Page layout adapter',
    filename: 'foundry-blocks-v1-4b.gguf',
    url: 'https://huggingface.co/owenmorgan/foundry/resolve/main/foundry-blocks-v1-4b.gguf',
    sha256: HASH_A,
    bytes: 1024,
    rank: 10,
    kind: 'adapter',
    stage: 'blocks',
    promptVersion: 5,
    note: 'test entry',
    ...over,
  };
}

describe('the shipped catalog', () => {
  // Base + ocr + footnotes published Aug 2 2026, blocks Aug 3 2026, all to
  // owenmorgan/foundry-models and all verified against the repo after upload
  // (x-linked-size == bytes, x-linked-etag == sha256).
  test('every role resolves — a fresh machine can run the whole chain', () => {
    expect(requireDefaultModel('base').id).toBe('foundry:4b');
    expect(defaultModelFor('blocks')?.id).toBe('foundry-blocks-v1-4b');
    expect(defaultModelFor('ocr')?.id).toBe('foundry-ocr-v1-4b');
    expect(defaultModelFor('footnotes')?.id).toBe('foundry-footnotes-v1-4b');
  });

  test('the base is the pinned f16 cast', () => {
    expect(getModelDef('foundry:4b')?.bytes).toBe(8051285600);
    expect(getModelDef('foundry:4b')?.kind).toBe('base');
    expect(getModelDef('foundry:4b')?.stage).toBeUndefined();
  });

  test('the ocr and footnotes stages are adapters on that base', () => {
    for (const id of ['foundry-ocr-v1-4b', 'foundry-footnotes-v1-4b']) {
      expect(getModelDef(id)?.kind).toBe('adapter');
      // Tens of megabytes is the whole reason they are adapters.
      expect(getModelDef(id)!.bytes).toBeLessThan(200 * 1024 * 1024);
    }
  });

  test('blocks is a FULL fused checkpoint, pinned to the measured bytes', () => {
    // These three facts are the artifact. The file is byte-identical to
    // bookforge-rubric/rubric-v5-4b-f16.gguf — the weights every blocks number
    // was measured on — and re-quantizing it would be shipping a model nobody
    // has scored.
    const blocks = getModelDef('foundry-blocks-v1-4b')!;
    expect(blocks.kind).toBe('full');
    expect(blocks.bytes).toBe(8051285248);
    expect(blocks.sha256).toBe(
      '4b991fca888de5cf5926d15d67b4eac979fda16fb9d3078ffdcd9f816b7e9a9a',
    );
  });

  test('blocks declares PROMPT v5, which its release-v1 id does not say', () => {
    // The whole reason promptVersion exists. Foundry's stage lines restart at
    // v1; the blocks prompt format carried on from BookForge at v5. Read out of
    // the id, this would be 1 — the retired sixteen-class taxonomy, which does
    // not error and just scores worse.
    expect(getModelDef('foundry-blocks-v1-4b')?.promptVersion).toBe(5);
    expect(parseModelId('foundry-blocks-v1-4b').version).toBe(1);
  });

  test('every entry points at the foundry-models repo, over https', () => {
    for (const m of FOUNDRY_MODELS) {
      expect(m.url).toBe(
        `https://huggingface.co/owenmorgan/foundry-models/resolve/main/${m.filename}`,
      );
    }
  });

  test('validates at module load', () => {
    expect(FOUNDRY_MODELS.length).toBeGreaterThan(0);
    expect(() => assertCatalogValid()).not.toThrow();
  });

  test('an unpublished role still says unpublished, not missing', () => {
    // Two different problems with two different remedies. Conflating them sends
    // people looking in their own filesystem for something never uploaded.
    // Nothing in the shipped catalog is unpublished any more, so this is checked
    // against a catalog that is missing a role.
    const noFootnotes = FOUNDRY_MODELS.filter((m) => m.stage !== 'footnotes');
    expect(defaultModelFor('footnotes', noFootnotes)).toBeUndefined();
    expect(() => requireDefaultModel('footnotes', noFootnotes))
      .toThrow(/No footnotes model is published/);
  });
});

describe('parseModelId', () => {
  test('parses the base id', () => {
    expect(parseModelId('foundry:4b')).toEqual({ kind: 'base', sizeB: 4 });
  });

  test('parses a stage id into stage, version and base size', () => {
    expect(parseModelId('foundry-footnotes-v2-4b')).toEqual({
      kind: 'stage',
      stage: 'footnotes',
      version: 2,
      sizeB: 4,
    });
  });

  test('an id says WHICH STAGE, never whether the tune is a LoRA', () => {
    // blocks ships fused and ocr ships as an adapter, and their ids are the same
    // shape. Packaging is the catalog entry's `kind`, because a stage can switch
    // from one to the other without its ids changing.
    expect(parseModelId('foundry-blocks-v1-4b').kind).toBe('stage');
    expect(parseModelId('foundry-ocr-v1-4b').kind).toBe('stage');
    expect(getModelDef('foundry-blocks-v1-4b')?.kind).toBe('full');
    expect(getModelDef('foundry-ocr-v1-4b')?.kind).toBe('adapter');
  });

  test('all three stages parse', () => {
    for (const stage of ['blocks', 'ocr', 'footnotes'] as const) {
      expect(parseModelId(`foundry-${stage}-v1-4b`).stage).toBe(stage);
    }
  });

  test('an id without a version is rejected, not read as v1', () => {
    // This is the load-bearing case (ARCHITECTURE §3): a version-less id read as
    // v1 gets a prompt advertising a retired taxonomy. It does not error — it
    // just scores worse, and reads as an undertrained model.
    expect(() => parseModelId('foundry-blocks-4b')).toThrow(/version segment is load-bearing/);
  });

  test('an unknown stage is rejected', () => {
    expect(() => parseModelId('foundry-rubric-v1-4b')).toThrow(/Malformed model id/);
  });

  test('the old BookForge ids do not parse', () => {
    // rubric → blocks, galley/proof → ocr, dagger → footnotes. An id that
    // survived the rename would silently be an id nothing can serve.
    expect(() => parseModelId('rubric-v5-4b')).toThrow(/Malformed model id/);
    expect(() => parseModelId('dagger-v1-4b')).toThrow(/Malformed model id/);
  });
});

describe('assertCatalogValid', () => {
  test('accepts a well-formed catalog', () => {
    expect(() => assertCatalogValid([
      entry({
        id: 'foundry:4b', kind: 'base', stage: undefined,
        promptVersion: undefined, filename: 'base.gguf',
      }),
      entry(),
    ])).not.toThrow();
  });

  test('accepts a full fused checkpoint under a stage id', () => {
    // The shape blocks ships in. Same id grammar as an adapter; different `kind`,
    // which is what decides `-m <this>` against `-m <base> --lora-scaled <this>`.
    expect(() => assertCatalogValid([entry({ kind: 'full' })])).not.toThrow();
  });

  test('rejects a blocks entry that does not declare its prompt version', () => {
    // The silent one. Without it `blocksVersionFor` reads release v1 off the id
    // as PROMPT v1 and encodes a retired sixteen-class taxonomy: legal-looking
    // prompts, quietly worse answers, and it reads as an undertrained model.
    expect(() => assertCatalogValid([entry({ promptVersion: undefined })]))
      .toThrow(/must declare promptVersion/);
  });

  test('a non-blocks stage need not declare a prompt version', () => {
    // ocr and footnotes have one prompt, not a versioned family of them.
    expect(() => assertCatalogValid([
      entry({
        id: 'foundry-ocr-v1-4b', stage: 'ocr',
        filename: 'ocr.gguf', promptVersion: undefined,
      }),
    ])).not.toThrow();
  });

  test('rejects a non-positive prompt version', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => assertCatalogValid([entry({ promptVersion: bad })]))
        .toThrow(/non-positive promptVersion/);
    }
  });

  test('rejects duplicate ids', () => {
    expect(() => assertCatalogValid([
      entry(),
      entry({ filename: 'other.gguf', sha256: HASH_B }),
    ])).toThrow(/duplicate model id/);
  });

  test('rejects duplicate filenames', () => {
    // Two entries writing one file means the second reads as "already
    // installed" the moment the first is downloaded.
    expect(() => assertCatalogValid([
      entry(),
      entry({ id: 'foundry-blocks-v2-4b', sha256: HASH_B }),
    ])).toThrow(/duplicate filename/);
  });

  test('rejects a declared kind that contradicts the id', () => {
    // A stage id cannot be the base, and the base id cannot be a stage model.
    expect(() => assertCatalogValid([entry({ kind: 'base' })])).toThrow(/parses as 'stage'/);
    expect(() => assertCatalogValid([
      entry({ id: 'foundry:4b', kind: 'full', filename: 'base.gguf' }),
    ])).toThrow(/parses as 'base'/);
  });

  test('rejects a stage field that contradicts the id', () => {
    expect(() => assertCatalogValid([entry({ stage: 'ocr' })])).toThrow(/but its id names 'blocks'/);
    // …including for a full checkpoint, which is the newer shape.
    expect(() => assertCatalogValid([entry({ kind: 'full', stage: 'ocr' })]))
      .toThrow(/but its id names 'blocks'/);
  });

  test('rejects a base that claims a stage', () => {
    expect(() => assertCatalogValid([
      entry({ id: 'foundry:4b', kind: 'base', stage: 'blocks' }),
    ])).toThrow(/must not name a stage/);
  });

  test('rejects a placeholder hash', () => {
    // The specific trap: an entry committed ahead of the upload, with a made-up
    // hash, turns "not published yet" into a checksum mismatch on a stranger's
    // first run — which reads as a corrupt download.
    for (const bad of ['', 'TODO', HASH_A.toUpperCase(), HASH_A.slice(0, 63)]) {
      expect(() => assertCatalogValid([entry({ sha256: bad })]))
        .toThrow(/64 lowercase hex/);
    }
  });

  test('rejects a non-positive byte count', () => {
    expect(() => assertCatalogValid([entry({ bytes: 0 })])).toThrow(/non-positive byte count/);
  });

  test('rejects a non-https url', () => {
    expect(() => assertCatalogValid([entry({ url: 'http://example.com/m.gguf' })]))
      .toThrow(/non-https url/);
  });

  test('rejects a malformed id', () => {
    expect(() => assertCatalogValid([entry({ id: 'blocks' })])).toThrow(/Malformed model id/);
  });
});

describe('rank picks the default', () => {
  const catalog: FoundryModelDef[] = [
    entry({ id: 'foundry-blocks-v1-4b', filename: 'b1.gguf', sha256: HASH_A, rank: 10 }),
    entry({ id: 'foundry-blocks-v3-4b', filename: 'b3.gguf', sha256: HASH_B, rank: 30 }),
    entry({ id: 'foundry-blocks-v2-4b', filename: 'b2.gguf', sha256: HASH_C, rank: 20 }),
    entry({
      id: 'foundry-ocr-v1-4b', stage: 'ocr', filename: 'o1.gguf',
      sha256: 'd'.repeat(64), rank: 99,
    }),
    entry({
      id: 'foundry:4b', kind: 'base', stage: undefined, promptVersion: undefined,
      filename: 'base.gguf', sha256: 'e'.repeat(64), rank: 1,
    }),
  ];

  test('the catalog is valid to begin with', () => {
    expect(() => assertCatalogValid(catalog)).not.toThrow();
  });

  test('highest rank wins, not newest version or catalog order', () => {
    expect(defaultModelFor('blocks', catalog)?.id).toBe('foundry-blocks-v3-4b');
  });

  test('a superseded entry is still listed — nobody mid-book loses their install', () => {
    expect(modelsFor('blocks', catalog).map((m) => m.id)).toEqual([
      'foundry-blocks-v3-4b',
      'foundry-blocks-v2-4b',
      'foundry-blocks-v1-4b',
    ]);
  });

  test('a stage that is repackaged keeps both entries under the one role', () => {
    // The live case: blocks ships fused today and becomes a LoRA when it is
    // retrained against foundry:4b. Both are `blocks`, so the role must match on
    // `stage` and not on `kind` — otherwise the day the adapter lands, everyone
    // holding the fused model has an install nothing can find.
    const mixed: FoundryModelDef[] = [
      entry({ id: 'foundry-blocks-v1-4b', kind: 'full', filename: 'fused.gguf', rank: 10 }),
      entry({ id: 'foundry-blocks-v2-4b', kind: 'adapter', filename: 'lora.gguf', sha256: HASH_B, rank: 20 }),
    ];
    expect(modelsFor('blocks', mixed).map((m) => m.id)).toEqual([
      'foundry-blocks-v2-4b',
      'foundry-blocks-v1-4b',
    ]);
    expect(defaultModelFor('blocks', mixed)?.kind).toBe('adapter');
  });

  test('roles do not bleed into each other', () => {
    expect(modelsFor('ocr', catalog).map((m) => m.id)).toEqual(['foundry-ocr-v1-4b']);
    expect(modelsFor('footnotes', catalog)).toHaveLength(0);
    expect(modelsFor('base', catalog).map((m) => m.id)).toEqual(['foundry:4b']);
  });

  test('a higher-ranked adapter for another stage is not the blocks default', () => {
    expect(defaultModelFor('blocks', catalog)?.rank).toBe(30);
  });

  test('ordering is deterministic when ranks tie', () => {
    const tied: FoundryModelDef[] = [
      entry({ id: 'foundry-ocr-v2-4b', stage: 'ocr', filename: 'x.gguf', sha256: HASH_B, rank: 5 }),
      entry({ id: 'foundry-ocr-v1-4b', stage: 'ocr', filename: 'y.gguf', sha256: HASH_A, rank: 5 }),
    ];
    expect(modelsFor('ocr', tied).map((m) => m.id)).toEqual(
      modelsFor('ocr', [...tied].reverse()).map((m) => m.id),
    );
  });

  test('sorting does not mutate the catalog it was handed', () => {
    const order = catalog.map((m) => m.id);
    modelsFor('blocks', catalog);
    expect(catalog.map((m) => m.id)).toEqual(order);
  });

  test('requireDefaultModel returns the ranked default when one exists', () => {
    expect(requireDefaultModel('blocks', catalog).id).toBe('foundry-blocks-v3-4b');
    expect(() => requireDefaultModel('footnotes', catalog)).toThrow(/No footnotes model is published/);
  });
});
