/**
 * doors-plan — the plan doors: what a press is aimed at, and the plan it composes.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */

import {
  readAppSettings
} from './app-settings';
import { admitted } from './openable';
import { foundryHost, hostPassOffer } from './host';
import {
  projectDirOf, readStepLedger
} from './projects';
import {
  identifyAnalysis, identifyCleanup, identifyExport, identifySimplification,
  identifyTranslation
} from './workspace';
import {
  ANALYSIS_CATEGORY_IDS
} from '../shared/analysis-categories';
import { positionOf } from '../shared/ledger';
import { deferralFor } from '../shared/pending';
import type { Deferral } from '../shared/pending';
import type {
  ConversionKind, LedgerStep, RewriteMode
} from '../shared/types';
import { rowsIn } from './doors-ledger';

/**
 * WHAT A PLAN IS AIMED AT — a real row, a promised one, or a refusal naming the id.
 *
 * ── The one resolution, made once for four doors ────────────────────────────
 *
 * Every plan door now takes an optional step id, because a person can press an act
 * on a card that is not the position: a landed row further up the tree, or — since
 * Owen's ruling — a row that has not landed at all. The three outcomes are decided
 * here so that the four doors cannot come to three answers about what an id means,
 * and so that the REFUSAL is spelled once.
 *
 * A LEDGER STEP answers `{ at: step }`, and the plan is composed against it exactly
 * as it would be against the position.
 *
 * A LIVE PROMISE answers `{ deferral }`, and the plan composes only what is
 * deterministic (`WorkspacePlan.deferred`).
 *
 * NEITHER IS A REFUSAL, and it names both halves of what it looked in. That
 * sentence is the one a person sees if they press an act on a card whose row left
 * the queue in the same instant — the derivation would have taken the card off the
 * screen a repaint later, and this is what happens if the press wins the race.
 *
 * NO `from` AT ALL IS THE POSITION, which is every press this app had before this
 * wave and is what the dock still sends.
 */
async function aimedAt(
  source: string,
  from?: string,
): Promise<{ at: LedgerStep | null; deferral?: Deferral }> {
  if (from === undefined || from.length === 0) return { at: null };
  const dir = projectDirOf(source);
  if (dir === null) {
    throw new Error(
      `This document does not belong to a project in this app’s library, so “${from}” cannot be a `
      + 'step of it.',
    );
  }
  const view = await readStepLedger(dir);
  if (view === null) {
    throw new Error(`${dir} is no longer a project in this app’s library.`);
  }
  const step = view.ledger.steps.find((row) => row.id === from) ?? null;
  if (step !== null) return { at: step };
  const deferral = deferralFor(view.ledger, rowsIn(dir), from);
  if (deferral === null) {
    throw new Error(
      `“${from}” is not a step of this book and no queued work will make it, so there is nothing to `
      + 'make this from. Click a step that exists and press again.',
    );
  }
  return { at: null, deferral };
}

/** `workspace:plan-export`. */
export async function planExportFrom(inputPath: string, kind: ConversionKind, from?: string) {
  const aim = await aimedAt(inputPath, from);
  return identifyExport(inputPath, kind, aim.deferral === undefined ? aim.at : aim.deferral.landed, aim.deferral);
}

/** `workspace:plan-translation`. */
export async function planTranslationFor(inputPath: string, targetLanguage: string, from?: string) {
  const source = admitted(inputPath);
  if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
  // THE ROW THIS IS AIMED AT — the position, a landed step the tree pressed on,
  // or a promise. See `aimedAt` and the export door above, where the widening
  // is argued in full.
  const aim = await aimedAt(source, from);
  const plan = await identifyTranslation(source, targetLanguage, aim.at, aim.deferral);
  return { ...plan, inputPath: plan.sourcePath };
}

/** `workspace:plan-simplify`. */
export async function planSimplificationFor(inputPath: string, mode: RewriteMode, from?: string) {
  const source = admitted(inputPath);
  if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
  const aim = await aimedAt(source, from);
  const plan = await identifySimplification(source, mode, aim.at, aim.deferral);
  return { ...plan, inputPath: plan.sourcePath };
}

/** `host-ops:pass-offer`: the host's section on the Clean text card. */
export async function hostPassOfferFor(inputPath: string, from?: string) {
  if (foundryHost()?.passOffer === undefined) return null;
  const source = admitted(inputPath);
  if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
  const dir = projectDirOf(source);
  if (dir === null) return null;
  const aim = await aimedAt(source, from);
  let at: string | null = null;
  if (aim.deferral === undefined) {
    if (aim.at !== null) at = aim.at.id;
    else {
      const view = await readStepLedger(dir);
      at = view === null ? null : positionOf(view.ledger)?.id ?? null;
    }
  }
  return hostPassOffer({ kind: 'clean', projectDir: dir, at, deferredFrom: aim.deferral?.from ?? null });
}

/** `workspace:plan-clean`. */
export async function planCleanupFor(inputPath: string, from?: string) {
  const source = admitted(inputPath);
  if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
  const aim = await aimedAt(source, from);
  const plan = await identifyCleanup(source, aim.at, aim.deferral);
  return { ...plan, inputPath: plan.sourcePath };
}

/** `workspace:plan-analysis`. */
export async function planAnalysisFor(inputPath: string, categories: string[]) {
  const source = admitted(inputPath);
  if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
  const asked = Array.isArray(categories) ? categories : [];
  const mine = readAppSettings().analysisCategories.map((one) => one.id);
  const known = [...ANALYSIS_CATEGORY_IDS, ...mine];
  const unknown = asked.filter((one) => !known.includes(one));
  if (unknown.length > 0) {
    throw new Error(
      `This build does not know a category called “${unknown[0]}”, so it cannot analyse against it.`,
    );
  }
  /*
   * IN PLAN ORDER, ALWAYS, and normalised here rather than trusted from the
   * window. The list is the step's own QUESTION (`PARAMS_OF.analysis`) and
   * `identityOf` compares it as JSON — so two spellings of one checklist would
   * be two questions, and a re-analysis would branch beside the row it meant to
   * refresh. One order, decided in one place, on the engine's own ordering —
   * with the user's own categories after the built-ins, in the order their
   * settings file holds them, which is the order they added them.
   */
  const ordered = known.filter((one) => asked.includes(one));
  if (ordered.length === 0) {
    throw new Error('Pick at least one category — an analysis with nothing to look for finds nothing.');
  }
  const plan = await identifyAnalysis(source, ordered);
  return { ...plan, inputPath: plan.sourcePath };
}
