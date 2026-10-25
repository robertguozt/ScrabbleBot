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

test("chooseWord holds a short, unbonused word when there's no urgency", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  const word = chooseWord({
    myRack: rack("CATX"), // best playable is CAT, length 3: no multiplier
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
  // CARS (C3+A1+R1+S1=6, x1.5 = 9) is a concrete, large payoff for "C".
  const dictionary = ["CARS", "CAT", "AT"];
  const withC = decideBid({
    letter: "C",
    myBalance: 100,
    myRack: rack("ARS"),
    dictionary,
    remainingBag: fullBag(),
    bagTotal: 50,
    auctionType: "Vickrey",
    participants,
  });
  // "Y" (2 in the bag, not the last copy) doesn't complete anything here —
  // only scarcity/optionality apply. (Deliberately not a singleton letter
  // like Z/Q/J/X: those are correctly bid near full value on their one
  // and only appearance regardless, which isn't what this test checks.)
  const withY = decideBid({
    letter: "Y",
    myBalance: 100,
    myRack: rack("ARS"),
    dictionary,
    remainingBag: fullBag(),
    bagTotal: 50,
    auctionType: "Vickrey",
    participants,
  });
  assert.ok(
    withC > withY,
    `expected a completion bid (${withC}) to beat a speculative one (${withY})`,
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
