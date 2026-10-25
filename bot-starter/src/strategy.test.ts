// Checks for the strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid, type Participant } from "./strategy.js";
import { DEFAULT_BAG } from "./scoring.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

const fullBag = () => new Map<string, number>(DEFAULT_BAG);

// ---------- chooseWord ----------

test("chooseWord picks the highest-reward word, not just the longest", () => {
  // TACT (T1+A1+C3+T1=6, x1.5 = 9) beats CAT (5, x1) and AT (2, x1).
  const dictionary = ["TACT", "CAT", "AT"];
  const word = chooseWord({
    myRack: rack("TACT"),
    dictionary,
    myBalance: 10, // low balance forces an immediate play
    bagTotal: 50,
  });
  assert.equal(word, "TACT");
});

test("chooseWord plays immediately once the bag enters the endgame window", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  const word = chooseWord({
    myRack: rack("CATX"),
    dictionary,
    myBalance: 100,
    bagTotal: 10, // below ENDGAME_BAG_THRESHOLD
  });
  assert.equal(word, "CAT");
});

test("chooseWord plays immediately once balance is low", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  const word = chooseWord({
    myRack: rack("CATX"),
    dictionary,
    myBalance: 10, // below LOW_BALANCE_FRACTION of starting 100
    bagTotal: 50,
  });
  assert.equal(word, "CAT");
});

test("chooseWord plays a word below the hold-length once it clears the reward floor", () => {
  // ZESTY: Z10+E1+S1+T1+Y4=17, x2 (5 letters) = 34 — well past either
  // reward floor, but only 5 letters, below HOLD_UNTIL_LEN. Uses the
  // whole rack (0 leftover tiles), so the small-rack floor applies too.
  const dictionary = ["ZESTY", "CAT", "AT"];
  const word = chooseWord({
    myRack: rack("ZESTY"),
    dictionary,
    myBalance: 100,
    bagTotal: 50,
  });
  assert.equal(word, "ZESTY");
});

test("chooseWord plays even a modest word once few tiles would be left idle", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  const word = chooseWord({
    // Best playable is CAT (reward 5), leaving only "X" (1 tile) idle —
    // at or below SMALL_LEFTOVER_TILES, so the low small-rack floor
    // applies and 5 clears it.
    myRack: rack("CATX"),
    dictionary,
    myBalance: 100,
    bagTotal: 50,
  });
  assert.equal(word, "CAT");
});

test("chooseWord holds a modest word when a large, mostly-idle rack suggests more is coming", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  const word = chooseWord({
    // Best playable is still just CAT (reward 5), but it leaves 4 tiles
    // (X, Y, Z, W) idle — above SMALL_LEFTOVER_TILES, so the higher
    // big-rack floor applies and 5 doesn't clear it.
    myRack: rack("CATXYZW"),
    dictionary,
    myBalance: 100,
    bagTotal: 50,
  });
  assert.equal(word, null);
});

test("chooseWord returns null with nothing playable", () => {
  const word = chooseWord({
    myRack: rack("CX"),
    dictionary: ["TACT", "CAT", "AT"],
    myBalance: 100,
    bagTotal: 50,
  });
  assert.equal(word, null);
});

test("chooseWord searches the whole wordlist well within an auction", () => {
  const dictionary = fs
    .readFileSync(
      new URL("../../spacetimedb/wordlist.txt", import.meta.url),
      "utf8",
    )
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2);
  // The largest rack an admin can set, with almost nothing to spell.
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  const start = performance.now();
  chooseWord({ myRack, dictionary, myBalance: 100, bagTotal: 50 });
  assert.ok(performance.now() - start < 200, "a search took 200 ms or more");
});

// ---------- decideBid ----------

const participants: Participant[] = [
  { botId: 1n, balance: 100, score: 0 },
  { botId: 2n, balance: 100, score: 0 },
];

test("decideBid bids more for a letter that completes a better word now", () => {
  // ARTISAN (A1+R1+T1+I1+S1+A1+N1=7, x3 for 7 letters = 21) is a large,
  // concrete payoff for "N" — big enough to clear the balance-scaled
  // baseline premium (~11-15 at balance 100) that every letter gets, so
  // the test actually measures the completion signal, not noise.
  const dictionary = ["ARTISAN", "CAT", "AT"];
  const withN = decideBid({
    letter: "N",
    myBalance: 100,
    myRack: rack("ARTISA"),
    dictionary,
    remainingBag: fullBag(),
    bagTotal: 50,
    auctionType: "Vickrey",
    participants,
  });
  // "Y" doesn't complete anything here — only the baseline premium applies.
  const withY = decideBid({
    letter: "Y",
    myBalance: 100,
    myRack: rack("ARTISA"),
    dictionary,
    remainingBag: fullBag(),
    bagTotal: 50,
    auctionType: "Vickrey",
    participants,
  });
  assert.ok(
    withN > withY,
    `expected a completion bid (${withN}) to beat a speculative one (${withY})`,
  );
});

test("decideBid in the endgame only pays for an immediate payoff", () => {
  const dictionary = ["CAT"];
  const noPayoff = decideBid({
    letter: "Z",
    myBalance: 100,
    myRack: rack("AT"),
    dictionary,
    remainingBag: fullBag(),
    bagTotal: 5, // inside ENDGAME_BAG_THRESHOLD
    auctionType: "Vickrey",
    participants,
  });
  assert.equal(noPayoff, 0);

  const payoff = decideBid({
    letter: "C",
    myBalance: 100,
    myRack: rack("AT"),
    dictionary,
    remainingBag: fullBag(),
    bagTotal: 5,
    auctionType: "Vickrey",
    participants,
  });
  assert.ok(payoff > 0);
});

test("decideBid never bids above current balance", () => {
  const bid = decideBid({
    letter: "Q",
    myBalance: 3,
    myRack: rack(""),
    dictionary: ["CAT"],
    remainingBag: fullBag(),
    bagTotal: 50,
    auctionType: "Vickrey",
    participants,
  });
  assert.ok(bid <= 3);
});

test("decideBid shades below value in a First-price auction", () => {
  const ctx = {
    letter: "C",
    myBalance: 100,
    myRack: rack("AT"),
    dictionary: ["CAT"],
    remainingBag: fullBag(),
    bagTotal: 50,
    participants,
  };
  const vickrey = decideBid({ ...ctx, auctionType: "Vickrey" as const });
  const firstPrice = decideBid({ ...ctx, auctionType: "FirstPrice" as const });
  assert.ok(firstPrice < vickrey);
});
