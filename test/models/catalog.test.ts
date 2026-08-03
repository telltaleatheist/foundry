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
    adapter: 'blocks',
    note: 'test entry',
    ...over,
  };
}

describe('the shipped catalog', () => {
  // Base + ocr + footnotes published Aug 2 2026 to owenmorgan/foundry-models,
  // sizes verified against the repo after upload. blocks is still training-gated.
  test('carries the published base and adapters', () => {
    expect(getModelDef('foundry:4b')?.bytes).toBe(8051285600);
    expect(defaultModelFor('ocr')?.id).toBe('foundry-ocr-v1-4b');
    expect(defaultModelFor('footnotes')?.id).toBe('foundry-footnotes-v1-4b');
    expect(requireDefaultModel('base').id).toBe('foundry:4b');
  });

  test('validates at module load', () => {
    expect(FOUNDRY_MODELS.length).toBeGreaterThan(0);
    expect(() => assertCatalogValid()).not.toThrow();
  });

  test('an unpublished stage still says unpublished, not missing', () => {
    // Two different problems with two different remedies. Conflating them sends
    // people looking in their own filesystem for something never uploaded.
    expect(defaultModelFor('blocks')).toBeUndefined();
    expect(() => requireDefaultModel('blocks')).toThrow(/blocks/);
  });
});

describe('parseModelId', () => {
  test('parses the base id', () => {
    expect(parseModelId('foundry:4b')).toEqual({ kind: 'base', sizeB: 4 });
  });

  test('parses an adapter id into stage, version and base size', () => {
    expect(parseModelId('foundry-footnotes-v2-4b')).toEqual({
      kind: 'adapter',
      adapter: 'footnotes',
      version: 2,
      sizeB: 4,
    });
  });

  test('all three stages parse', () => {
    for (const stage of ['blocks', 'ocr', 'footnotes'] as const) {
      expect(parseModelId(`foundry-${stage}-v1-4b`).adapter).toBe(stage);
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
      entry({ id: 'foundry:4b', kind: 'base', adapter: undefined, filename: 'base.gguf' }),
      entry(),
    ])).not.toThrow();
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
    expect(() => assertCatalogValid([entry({ kind: 'base' })])).toThrow(/parses as 'adapter'/);
  });

  test('rejects an adapter field that contradicts the id', () => {
    expect(() => assertCatalogValid([entry({ adapter: 'ocr' })])).toThrow(/but its id names 'blocks'/);
  });

  test('rejects a base that claims an adapter', () => {
    expect(() => assertCatalogValid([
      entry({ id: 'foundry:4b', kind: 'base', adapter: 'blocks' }),
    ])).toThrow(/must not name an adapter/);
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
      id: 'foundry-ocr-v1-4b', adapter: 'ocr', filename: 'o1.gguf',
      sha256: 'd'.repeat(64), rank: 99,
    }),
    entry({
      id: 'foundry:4b', kind: 'base', adapter: undefined, filename: 'base.gguf',
      sha256: 'e'.repeat(64), rank: 1,
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
      entry({ id: 'foundry-ocr-v2-4b', adapter: 'ocr', filename: 'x.gguf', sha256: HASH_B, rank: 5 }),
      entry({ id: 'foundry-ocr-v1-4b', adapter: 'ocr', filename: 'y.gguf', sha256: HASH_A, rank: 5 }),
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
