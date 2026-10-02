import { describe, expect, it } from "vitest";
import {
  ALL_RATINGS,
  createEmptyCard,
  FACTOR,
  FSRS,
  FSRS45_DEFAULT_WEIGHTS,
  FsrsValidationError,
  formatInterval,
  Rating,
  toCardRowUpdate,
  type SchedulingCard,
} from "@/services/fsrsEngine";

const DAY = 86_400_000;
const t0 = new Date("2026-01-01T09:00:00.000Z");
const noFuzz = new FSRS({ enableFuzz: false });

function graduate(engine: FSRS): SchedulingCard {
  let card = createEmptyCard(t0);
  let now = t0;
  for (let i = 0; i < 5 && card.state !== "review"; i++) {
    card = engine.review(card, Rating.Good, now).card;
    now = card.due;
  }
  return card;
}

describe("FSRS-4.5 core formulas", () => {
  it("uses the 17 published default weights", () => {
    expect(FSRS45_DEFAULT_WEIGHTS).toHaveLength(17);
    expect(FACTOR).toBeCloseTo(19 / 81, 12);
  });

  it("retrievability is exactly 0.9 when t equals S", () => {
    expect(noFuzz.forgettingCurve(10, 10)).toBeCloseTo(0.9, 10);
    expect(noFuzz.forgettingCurve(0, 3)).toBe(1);
  });

  it("interval equals stability at 90% requested retention", () => {
    expect(noFuzz.rawInterval(7.3)).toBeCloseTo(7.3, 10);
    expect(new FSRS({ requestRetention: 0.8, enableFuzz: false }).rawInterval(10)).toBeGreaterThan(10);
  });

  it("initial stability and difficulty follow w0..w5", () => {
    expect(noFuzz.initStability(1)).toBeCloseTo(0.4);
    expect(noFuzz.initStability(4)).toBeCloseTo(5.8);
    expect(noFuzz.initDifficulty(3)).toBeCloseTo(4.93);
    expect(noFuzz.initDifficulty(1)).toBeCloseTo(4.93 + 2 * 0.94);
    expect(noFuzz.initDifficulty(4)).toBeCloseTo(4.93 - 0.94);
  });

  it("difficulty mean-reverts and stays within [1, 10]", () => {
    let d = 9.9;
    for (let i = 0; i < 50; i++) d = noFuzz.nextDifficulty(d, 1);
    expect(d).toBeLessThanOrEqual(10);
    let e = 1.1;
    for (let i = 0; i < 50; i++) e = noFuzz.nextDifficulty(e, 4);
    expect(e).toBeGreaterThanOrEqual(1);
    expect(noFuzz.nextDifficulty(5, 3)).toBeCloseTo(0.01 * 4.93 + 0.99 * 5, 10);
  });

  it("recall stability grows with ordering hard < good < easy", () => {
    const hard = noFuzz.nextRecallStability(5, 10, 0.9, 2);
    const good = noFuzz.nextRecallStability(5, 10, 0.9, 3);
    const easy = noFuzz.nextRecallStability(5, 10, 0.9, 4);
    expect(hard).toBeGreaterThan(10);
    expect(good).toBeGreaterThan(hard);
    expect(easy).toBeGreaterThan(good);
  });

  it("forget stability never exceeds prior stability", () => {
    expect(noFuzz.nextForgetStability(5, 30, 0.9)).toBeLessThan(30);
    expect(noFuzz.nextForgetStability(1, 0.5, 0.2)).toBeLessThanOrEqual(0.5);
  });
});

describe("FSRS scheduler state machine", () => {
  it("new card → learning steps → review", () => {
    const first = noFuzz.review(createEmptyCard(t0), Rating.Good, t0);
    expect(first.card.state).toBe("learning");
    expect(first.card.due.getTime() - t0.getTime()).toBe(10 * 60_000);
    expect(first.card.stability).toBeCloseTo(2.4);
    expect(first.card.difficulty).toBeCloseTo(4.93);

    const second = noFuzz.review(first.card, Rating.Good, first.card.due);
    expect(second.card.state).toBe("review");
    expect(second.card.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(second.card.reps).toBe(2);
  });

  it("Easy graduates a new card immediately with a w3-based interval", () => {
    const res = noFuzz.review(createEmptyCard(t0), Rating.Easy, t0);
    expect(res.card.state).toBe("review");
    expect(res.card.scheduledDays).toBe(Math.round(5.8));
  });

  it("Again on a review card lapses into relearning and reduces stability", () => {
    const card = graduate(noFuzz);
    const res = noFuzz.review(card, Rating.Again, card.due);
    expect(res.card.state).toBe("relearning");
    expect(res.card.lapses).toBe(card.lapses + 1);
    expect(res.card.stability ?? Number.POSITIVE_INFINITY).toBeLessThan(card.stability ?? 0);
    const relearned = noFuzz.review(res.card, Rating.Good, res.card.due);
    expect(relearned.card.state).toBe("review");
  });

  it("review intervals are ordered hard ≤ good < easy and capped", () => {
    const engine = new FSRS({ maximumInterval: 365 });
    let card = graduate(engine);
    for (let i = 0; i < 12; i++) {
      const preview = engine.schedule(card, card.due);
      const hard = preview[2].card.scheduledDays;
      const good = preview[3].card.scheduledDays;
      const easy = preview[4].card.scheduledDays;
      expect(hard).toBeLessThanOrEqual(good);
      expect(good).toBeLessThanOrEqual(easy);
      expect(easy).toBeLessThanOrEqual(365);
      card = preview[3].card;
    }
  });

  it("preview matches review exactly (deterministic fuzz)", () => {
    const engine = new FSRS();
    const card = graduate(engine);
    const at = new Date(card.due.getTime() + 2 * DAY);
    const preview = engine.schedule(card, at);
    for (const rating of ALL_RATINGS) {
      expect(engine.review(card, rating, at).card.due.getTime()).toBe(preview[rating].card.due.getTime());
    }
  });

  it("overdue recall yields a larger stability gain than on-time recall", () => {
    const card = graduate(noFuzz);
    const onTime = noFuzz.review(card, Rating.Good, card.due).card.stability ?? 0;
    const late = noFuzz.review(card, Rating.Good, new Date(card.due.getTime() + 20 * DAY)).card.stability ?? 0;
    expect(late).toBeGreaterThan(onTime);
  });

  it("rejects invalid ratings, weights and timestamps", () => {
    expect(() => noFuzz.review(createEmptyCard(t0), 0, t0)).toThrow(FsrsValidationError);
    expect(() => noFuzz.review(createEmptyCard(t0), 5, t0)).toThrow(FsrsValidationError);
    expect(() => new FSRS({ weights: [1, 2, 3] })).toThrow(FsrsValidationError);
    expect(() => new FSRS({ requestRetention: 1.2 })).toThrow(FsrsValidationError);
    expect(() => noFuzz.schedule(createEmptyCard(t0), new Date("invalid"))).toThrow(FsrsValidationError);
  });

  it("serializes reviewed cards to DB row updates", () => {
    const row = toCardRowUpdate(noFuzz.review(createEmptyCard(t0), Rating.Good, t0).card);
    expect(row.state).toBe("learning");
    expect(row.last_review).toBe(t0.toISOString());
    expect(() => toCardRowUpdate(createEmptyCard(t0))).toThrow(FsrsValidationError);
  });

  it("formats intervals for the 4-button UI", () => {
    expect(formatInterval(60_000)).toBe("1m");
    expect(formatInterval(10 * 60_000)).toBe("10m");
    expect(formatInterval(3 * DAY)).toBe("3d");
    expect(formatInterval(45 * DAY)).toBe("1.5mo");
    expect(formatInterval(730 * DAY)).toBe("2y");
  });
});
