import type { FSRSCard, FsrsState, RatingValue } from "@/types/schema";

/**
 * FSRS-4.5 (Free Spaced Repetition Scheduler) — pure, deterministic TypeScript implementation.
 *
 *   Retrievability   R(t, S) = (1 + FACTOR · t / S) ^ DECAY,   DECAY = -0.5, FACTOR = 19/81
 *   Interval         I(r, S) = S / FACTOR · (r^(1/DECAY) − 1)   (I = S when r = 0.9)
 *   Initial S        S0(G)   = w[G−1]
 *   Initial D        D0(G)   = w4 − (G − 3) · w5
 *   Next D           D'      = w7 · D0(3) + (1 − w7) · (D − w6 · (G − 3))       ∈ [1, 10]
 *   Recall S         S'r     = S · (e^w8 · (11 − D) · S^−w9 · (e^(w10·(1−R)) − 1) · hard · easy + 1)
 *                              hard = w15 if G = 2, easy = w16 if G = 4
 *   Forget S         S'f     = min(S, w11 · D^−w12 · ((S + 1)^w13 − 1) · e^(w14·(1−R)))
 *
 * As in the FSRS-4.5 reference scheduler, S and D are updated on every review (including
 * learning steps). Same-day reviews have t = 0 ⇒ R = 1, so a successful same-day review leaves
 * S unchanged while a lapse can still lower it. Review intervals are ordered
 * hard ≤ good < easy. Interval fuzz is seeded from the card's own state (not the clock), so the
 * 4-button preview always matches what `review()` later produces for that card.
 */

export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const satisfies Record<string, RatingValue>;
export type Rating = RatingValue;
export const ALL_RATINGS: readonly Rating[] = [1, 2, 3, 4];

/** Default FSRS-4.5 parameters (fsrs4anki v4.5 release). */
export const FSRS45_DEFAULT_WEIGHTS: readonly number[] = Object.freeze([
  0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61,
]);

export const DECAY = -0.5;
export const FACTOR = 19 / 81;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MIN_STABILITY = 0.01;

export interface FsrsParameters {
  readonly weights: readonly number[];
  readonly requestRetention: number;
  readonly maximumInterval: number;
  readonly enableFuzz: boolean;
  /** Learning steps (minutes) for new cards. */
  readonly learningSteps: readonly number[];
  /** Relearning steps (minutes) after a lapse. */
  readonly relearningSteps: readonly number[];
}

export const DEFAULT_PARAMETERS: FsrsParameters = Object.freeze({
  weights: FSRS45_DEFAULT_WEIGHTS,
  requestRetention: 0.9,
  maximumInterval: 36_500,
  enableFuzz: true,
  learningSteps: Object.freeze([1, 10]),
  relearningSteps: Object.freeze([10]),
});

export interface SchedulingCard {
  readonly stability: number | null;
  readonly difficulty: number | null;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly reps: number;
  readonly lapses: number;
  readonly learningStep: number;
  readonly state: FsrsState;
  readonly lastReview: Date | null;
  readonly due: Date;
}

export interface ReviewLogEntry {
  readonly rating: Rating;
  readonly stateBefore: FsrsState;
  readonly stabilityAfter: number;
  readonly difficultyAfter: number;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly retrievabilityBefore: number | null;
  readonly reviewedAt: Date;
}

export interface SchedulingResult {
  readonly card: SchedulingCard;
  readonly log: ReviewLogEntry;
}

export type SchedulingPreview = Readonly<Record<Rating, SchedulingResult>>;

export interface FsrsDependencies {
  /**
   * Optional uniform [0, 1) source for interval fuzz. When omitted, a deterministic PRNG seeded
   * from the card state is used so previews and reviews agree.
   */
  readonly random?: () => number;
}

export class FsrsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsrsValidationError";
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

function assertRating(rating: number): asserts rating is Rating {
  if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
    throw new FsrsValidationError(`Rating must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy); received ${rating}`);
  }
}

function validateParameters(params: FsrsParameters): void {
  if (params.weights.length !== 17 || params.weights.some((w) => !Number.isFinite(w))) {
    throw new FsrsValidationError("FSRS-4.5 requires exactly 17 finite weights");
  }
  if (!(params.requestRetention > 0.5 && params.requestRetention < 1)) {
    throw new FsrsValidationError("requestRetention must be in (0.5, 1)");
  }
  if (!Number.isInteger(params.maximumInterval) || params.maximumInterval < 1) {
    throw new FsrsValidationError("maximumInterval must be a positive integer");
  }
  for (const step of [...params.learningSteps, ...params.relearningSteps]) {
    if (!Number.isFinite(step) || step <= 0 || step >= 1440) {
      throw new FsrsValidationError("Learning steps must be positive minute values below one day");
    }
  }
}

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the card's identity-bearing state; stable across preview and review calls. */
function seedFromCard(card: SchedulingCard, rating: Rating): number {
  const material = [
    card.reps,
    card.lapses,
    card.lastReview?.getTime() ?? 0,
    card.due.getTime(),
    card.stability ?? 0,
    card.difficulty ?? 0,
    rating,
  ].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Creates a brand-new, never-reviewed card due immediately. */
export function createEmptyCard(now: Date = new Date()): SchedulingCard {
  return {
    stability: null,
    difficulty: null,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    learningStep: 0,
    state: "new",
    lastReview: null,
    due: new Date(now.getTime()),
  };
}

const FUZZ_RANGES: ReadonlyArray<{ start: number; end: number; factor: number }> = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Number.POSITIVE_INFINITY, factor: 0.05 },
];

interface MemoryState {
  readonly stability: number;
  readonly difficulty: number;
}

type StepDecision = { readonly kind: "step"; readonly step: number; readonly minutes: number } | { readonly kind: "graduate" };

export class FSRS {
  readonly params: FsrsParameters;
  private readonly w: readonly number[];
  private readonly injectedRandom: (() => number) | undefined;

  constructor(params: Partial<FsrsParameters> = {}, deps: FsrsDependencies = {}) {
    this.params = Object.freeze({ ...DEFAULT_PARAMETERS, ...params });
    validateParameters(this.params);
    this.w = this.params.weights;
    this.injectedRandom = deps.random;
  }

  private weight(index: number): number {
    const value = this.w[index];
    if (value === undefined) throw new FsrsValidationError(`Missing weight w${index}`);
    return value;
  }

  /** R(t, S): probability of recall after `elapsedDays` given stability `stability`. */
  forgettingCurve(elapsedDays: number, stability: number): number {
    return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
  }

  initStability(rating: Rating): number {
    return Math.max(this.weight(rating - 1), MIN_STABILITY);
  }

  initDifficulty(rating: Rating): number {
    return clamp(this.weight(4) - (rating - 3) * this.weight(5), 1, 10);
  }

  /** D' with mean reversion toward D0(Good). */
  nextDifficulty(difficulty: number, rating: Rating): number {
    const next = difficulty - this.weight(6) * (rating - 3);
    const reverted = this.weight(7) * this.initDifficulty(3) + (1 - this.weight(7)) * next;
    return clamp(reverted, 1, 10);
  }

  nextRecallStability(difficulty: number, stability: number, retrievability: number, rating: Exclude<Rating, 1>): number {
    const hardPenalty = rating === 2 ? this.weight(15) : 1;
    const easyBonus = rating === 4 ? this.weight(16) : 1;
    const growth =
      Math.exp(this.weight(8)) *
      (11 - difficulty) *
      Math.pow(stability, -this.weight(9)) *
      (Math.exp(this.weight(10) * (1 - retrievability)) - 1) *
      hardPenalty *
      easyBonus;
    return Math.max(stability * (growth + 1), MIN_STABILITY);
  }

  nextForgetStability(difficulty: number, stability: number, retrievability: number): number {
    const value =
      this.weight(11) *
      Math.pow(difficulty, -this.weight(12)) *
      (Math.pow(stability + 1, this.weight(13)) - 1) *
      Math.exp(this.weight(14) * (1 - retrievability));
    return clamp(value, MIN_STABILITY, stability);
  }

  /** Raw (unfuzzed, unrounded) interval in days achieving `requestRetention`. */
  rawInterval(stability: number): number {
    return (stability / FACTOR) * (Math.pow(this.params.requestRetention, 1 / DECAY) - 1);
  }

  /** Rounded interval in whole days, optionally fuzzed, clamped to [1, maximumInterval]. */
  nextInterval(stability: number, elapsedDays: number, random: (() => number) | null): number {
    const base = clamp(Math.round(this.rawInterval(stability)), 1, this.params.maximumInterval);
    if (random === null || !this.params.enableFuzz || base < 2.5) return base;
    let delta = 1;
    for (const range of FUZZ_RANGES) {
      delta += range.factor * Math.max(Math.min(base, range.end) - range.start, 0);
    }
    let minIvl = Math.max(2, Math.round(base - delta));
    const maxIvl = Math.min(Math.round(base + delta), this.params.maximumInterval);
    if (base > elapsedDays) minIvl = Math.max(minIvl, elapsedDays + 1);
    minIvl = Math.min(minIvl, maxIvl);
    return Math.floor(random() * (maxIvl - minIvl + 1) + minIvl);
  }

  /** Whole days between the last review and `now` (0 for same-day / unreviewed). */
  elapsedDaysSince(card: SchedulingCard, now: Date): number {
    if (card.lastReview === null) return 0;
    return Math.max(0, Math.floor((now.getTime() - card.lastReview.getTime()) / DAY_MS));
  }

  /** Current retrievability for display; `null` for unreviewed cards. */
  getRetrievability(card: SchedulingCard, now: Date = new Date()): number | null {
    if (card.state === "new" || card.stability === null || card.lastReview === null) return null;
    const elapsed = Math.max(0, (now.getTime() - card.lastReview.getTime()) / DAY_MS);
    return this.forgettingCurve(elapsed, card.stability);
  }

  private memoryAfter(card: SchedulingCard, rating: Rating, elapsedDays: number): MemoryState & { retrievability: number | null } {
    if (card.stability === null || card.difficulty === null || card.state === "new") {
      return { stability: this.initStability(rating), difficulty: this.initDifficulty(rating), retrievability: null };
    }
    const retrievability = this.forgettingCurve(elapsedDays, card.stability);
    const difficulty = this.nextDifficulty(card.difficulty, rating);
    const stability =
      rating === 1
        ? this.nextForgetStability(card.difficulty, card.stability, retrievability)
        : this.nextRecallStability(card.difficulty, card.stability, retrievability, rating);
    return { stability, difficulty, retrievability };
  }

  private randomFor(card: SchedulingCard, rating: Rating): (() => number) | null {
    if (!this.params.enableFuzz) return null;
    return this.injectedRandom ?? mulberry32(seedFromCard(card, rating));
  }

  /** Learning-step transition for (re)learning cards. */
  private decideStep(steps: readonly number[], currentStep: number, rating: Rating): StepDecision {
    if (steps.length === 0 || rating === 4) return { kind: "graduate" };
    const first = steps[0] as number;
    if (rating === 1) return { kind: "step", step: 0, minutes: first };
    const step = Math.min(currentStep, steps.length - 1);
    const current = steps[step] as number;
    if (rating === 2) {
      const second = steps[1];
      const minutes = step === 0 && second !== undefined ? (first + second) / 2 : step === 0 ? first * 1.5 : current;
      return { kind: "step", step, minutes };
    }
    const nextStep = step + 1;
    const next = steps[nextStep];
    return next === undefined ? { kind: "graduate" } : { kind: "step", step: nextStep, minutes: next };
  }

  /** Ordered review intervals: hard ≤ good < easy. */
  private reviewIntervals(
    memory: Readonly<Record<Rating, MemoryState>>,
    card: SchedulingCard,
    elapsedDays: number,
  ): Record<Rating, number> {
    const raw = (r: Rating) => this.nextInterval(memory[r].stability, elapsedDays, this.randomFor(card, r));
    const again = raw(1);
    const hard0 = raw(2);
    const good0 = raw(3);
    const easy0 = raw(4);
    const hard = Math.min(hard0, good0);
    const good = Math.min(Math.max(good0, hard + 1), this.params.maximumInterval);
    const easy = Math.min(Math.max(easy0, good + 1), this.params.maximumInterval);
    return { 1: again, 2: hard, 3: good, 4: easy };
  }

  /**
   * Computes the outcome of all four ratings at once. `review()` delegates here, guaranteeing the
   * preview on the 4-button UI is exactly what gets persisted.
   */
  schedule(card: SchedulingCard, now: Date = new Date()): SchedulingPreview {
    if (Number.isNaN(now.getTime())) throw new FsrsValidationError("Invalid review timestamp");
    const elapsedDays = this.elapsedDaysSince(card, now);
    const memory: Readonly<Record<Rating, MemoryState & { retrievability: number | null }>> = {
      1: this.memoryAfter(card, 1, elapsedDays),
      2: this.memoryAfter(card, 2, elapsedDays),
      3: this.memoryAfter(card, 3, elapsedDays),
      4: this.memoryAfter(card, 4, elapsedDays),
    };
    const intervals = this.reviewIntervals(memory, card, elapsedDays);
    const nowMs = now.getTime();

    const build = (
      rating: Rating,
      next: { state: FsrsState; learningStep: number; scheduledDays: number; lapses: number; dueMs: number },
    ): SchedulingResult => {
      const m = memory[rating];
      return {
        card: {
          stability: m.stability,
          difficulty: m.difficulty,
          elapsedDays,
          scheduledDays: next.scheduledDays,
          reps: card.reps + 1,
          lapses: next.lapses,
          learningStep: next.learningStep,
          state: next.state,
          lastReview: new Date(nowMs),
          due: new Date(next.dueMs),
        },
        log: {
          rating,
          stateBefore: card.state,
          stabilityAfter: m.stability,
          difficultyAfter: m.difficulty,
          elapsedDays,
          scheduledDays: next.scheduledDays,
          retrievabilityBefore: m.retrievability,
          reviewedAt: new Date(nowMs),
        },
      };
    };
    const toReview = (rating: Rating, lapses: number) =>
      build(rating, {
        state: "review",
        learningStep: 0,
        scheduledDays: intervals[rating],
        lapses,
        dueMs: nowMs + intervals[rating] * DAY_MS,
      });
    const toStep = (rating: Rating, state: FsrsState, step: number, minutes: number, lapses: number) =>
      build(rating, { state, learningStep: step, scheduledDays: 0, lapses, dueMs: nowMs + Math.round(minutes * MINUTE_MS) });

    if (card.state === "review") {
      const relearn = this.params.relearningSteps;
      const again =
        relearn.length === 0
          ? toReview(1, card.lapses + 1)
          : toStep(1, "relearning", 0, relearn[0] as number, card.lapses + 1);
      return { 1: again, 2: toReview(2, card.lapses), 3: toReview(3, card.lapses), 4: toReview(4, card.lapses) };
    }

    const steps = card.state === "relearning" ? this.params.relearningSteps : this.params.learningSteps;
    const stepState: FsrsState = card.state === "relearning" ? "relearning" : "learning";
    const outcome = (rating: Rating): SchedulingResult => {
      const decision = this.decideStep(steps, card.learningStep, rating);
      return decision.kind === "step"
        ? toStep(rating, stepState, decision.step, decision.minutes, card.lapses)
        : toReview(rating, card.lapses);
    };
    return { 1: outcome(1), 2: outcome(2), 3: outcome(3), 4: outcome(4) };
  }

  /** Applies a single rating (1 Again, 2 Hard, 3 Good, 4 Easy). */
  review(card: SchedulingCard, rating: number, now: Date = new Date()): SchedulingResult {
    assertRating(rating);
    return this.schedule(card, now)[rating];
  }

  /** Human-readable next-interval labels for the 4-button UI (e.g. "10m", "3d", "1.2mo"). */
  previewLabels(card: SchedulingCard, now: Date = new Date()): Readonly<Record<Rating, string>> {
    const preview = this.schedule(card, now);
    const label = (r: Rating) => formatInterval(preview[r].card.due.getTime() - now.getTime());
    return { 1: label(1), 2: label(2), 3: label(3), 4: label(4) };
  }
}

export function formatInterval(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  const days = ms / DAY_MS;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, "")}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

// ---------------------------------------------------------------------------
// Persistence mappers (domain DTO ⇄ scheduler card ⇄ DB row)
// ---------------------------------------------------------------------------

export function fromCardDto(dto: FSRSCard): SchedulingCard {
  return {
    stability: dto.stability,
    difficulty: dto.difficulty,
    elapsedDays: dto.elapsedDays,
    scheduledDays: dto.scheduledDays,
    reps: dto.reps,
    lapses: dto.lapses,
    learningStep: dto.learningStep,
    state: dto.state,
    lastReview: dto.lastReview === null ? null : new Date(dto.lastReview),
    due: new Date(dto.dueDate),
  };
}

export interface FsrsCardRowUpdate {
  readonly stability: number;
  readonly difficulty: number;
  readonly elapsed_days: number;
  readonly scheduled_days: number;
  readonly reps: number;
  readonly lapses: number;
  readonly learning_step: number;
  readonly state: FsrsState;
  readonly last_review: string;
  readonly due_date: string;
}

export function toCardRowUpdate(card: SchedulingCard): FsrsCardRowUpdate {
  if (card.stability === null || card.difficulty === null || card.lastReview === null) {
    throw new FsrsValidationError("Only reviewed cards can be persisted as a review update");
  }
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    reps: card.reps,
    lapses: card.lapses,
    learning_step: card.learningStep,
    state: card.state,
    last_review: card.lastReview.toISOString(),
    due_date: card.due.toISOString(),
  };
}

export const defaultFsrs = new FSRS();
