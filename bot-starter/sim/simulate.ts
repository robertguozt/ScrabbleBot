// Offline simulator: a standalone, pure-TS re-implementation of the match
// rules (98-tile bag, 6-seat lobby, 1-round-per-tile Vickrey auctions,
// reserve 1, length-multiplier scoring), built from the same source the
// live module uses so it never drifts from server behavior:
//   - scoring.ts mirrors spacetimedb/src/letters.ts
//   - the sim-bot bid formulas below mirror spacetimedb/src/game.ts's
//     `decideBid`/`simulateBids` (the Human/Cheapskate/ValueBidder/
//     Aggressive strategies real matches get padded with)
//   - our own bot runs the *exact* strategy.ts + trackers.ts it runs live
//
// Run with `npm run sim` (see package.json). No network, no SpacetimeDB —
// pure computation, so this is where strategy.ts gets tuned before ever
// spending a live match (which also burns OpenSkill provisional-rating
// matches).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BAG, letterValue, totalReward } from "../src/scoring.js";
import { bestWord } from "../src/wordfinder.js";
import { MatchTracker } from "../src/trackers.js";
import { decideBid, chooseWord, type Participant } from "../src/strategy.js";

// ---------- Config ----------

const LOBBY_SIZE = 6;
const STARTING_RACK_SIZE = 5;
const STARTING_BALANCE = 100;
const AUCTION_RESERVE = 1;
const SIM_BID_JITTER = 2;
const OUR_BOT_ID = 0n;

type SimStrategy = "Human" | "Cheapskate" | "ValueBidder" | "Aggressive";

// Mirrors the real lobby pool's spirit (Cheapo, Valor, Brutus, Hagrid,
// Maverick, Snippet) without needing their exact (unpublished) strategy
// assignments: a representative mix of the four documented archetypes.
const DEFAULT_OPPONENTS: SimStrategy[] = [
  "ValueBidder",
  "ValueBidder",
  "Aggressive",
  "Aggressive",
  "Cheapskate",
];

// ---------- Dictionary ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dictionaryPath = path.join(__dirname, "..", "..", "spacetimedb", "wordlist.txt");
const DICTIONARY: string[] = fs
  .readFileSync(dictionaryPath, "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2);
// Longest-first — what the real sim bots' findBestPlayable relies on.
const DICTIONARY_BY_LEN_DESC = [...DICTIONARY].sort((a, b) => b.length - a.length);

// ---------- RNG (seedable for reproducible runs) ----------

function mulberry32(seed: number) {
  return function rng() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(rng: () => number, items: T[]): void {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

// ---------- Bag ----------

function freshBag(): Map<string, number> {
  return new Map(DEFAULT_BAG);
}

function bagTotal(bag: Map<string, number>): number {
  let total = 0;
  for (const n of bag.values()) total += n;
  return total;
}

function drawLetter(bag: Map<string, number>, rng: () => number): string | undefined {
  const total = bagTotal(bag);
  if (total === 0) return undefined;
  let idx = Math.floor(rng() * total);
  for (const [letter, remaining] of bag) {
    if (idx < remaining) {
      bag.set(letter, remaining - 1);
      return letter;
    }
    idx -= remaining;
  }
  return undefined;
}

// ---------- Sim-bot bidding (mirrors spacetimedb/src/game.ts: decideBid) ----------

function simDecideBid(
  strategy: SimStrategy,
  letter: string,
  balance: number,
  jitter: number,
): number {
  if (strategy === "Human") return 0;
  const value = letterValue(letter);
  const isVowel = "AEIOU".includes(letter);
  let base: number;
  switch (strategy) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

// Mirrors spacetimedb/src/dictionary.ts: findBestPlayable — longest
// playable word of at least `minLen`, same as what real sim bots play.
function findLongestPlayable(
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  let tiles = 0;
  for (const n of rack.values()) tiles += n;
  if (tiles < minLen) return undefined;
  for (const word of DICTIONARY_BY_LEN_DESC) {
    if (word.length < minLen) break;
    if (word.length > tiles) continue;
    if (canSpell(word, rack)) return word;
  }
  return undefined;
}

function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c] > (rack.get(c) ?? 0)) return false;
  }
  return true;
}

function spend(rack: Map<string, number>, word: string) {
  for (const c of word) {
    const have = rack.get(c) ?? 0;
    if (have <= 1) rack.delete(c);
    else rack.set(c, have - 1);
  }
}

// ---------- One bot's match-local state ----------

interface BotState {
  id: bigint;
  strategy: SimStrategy | "Ours";
  balance: number;
  score: number;
  rack: Map<string, number>;
}

export interface MatchResult {
  ourScore: number;
  ourRank: number; // 1 = best, ties share the better rank
  ourBalanceLeft: number;
  ourStrandedValue: number; // reward left on the table in our unplayed rack
}

// ---------- One match ----------

export function runMatch(
  opponents: SimStrategy[],
  rng: () => number,
  auctionType: "Vickrey" | "FirstPrice" = "Vickrey",
): MatchResult {
  const bots: BotState[] = [
    { id: OUR_BOT_ID, strategy: "Ours", balance: STARTING_BALANCE, score: 0, rack: new Map() },
    ...opponents.map((strategy, i) => ({
      id: BigInt(i + 1),
      strategy,
      balance: STARTING_BALANCE,
      score: 0,
      rack: new Map<string, number>(),
    })),
  ];
  const us = bots[0]!;
  const bag = freshBag();
  const tracker = new MatchTracker();

  // Deal starting racks (not auctioned — straight from the bag, same as
  // startMatchWith).
  for (const bot of bots) {
    for (let n = 0; n < STARTING_RACK_SIZE; n++) {
      const letter = drawLetter(bag, rng);
      if (letter === undefined) break;
      bot.rack.set(letter, (bot.rack.get(letter) ?? 0) + 1);
    }
  }
  tracker.noteOwnStartingRack(us.rack);

  // Let a bot cash in every playable word it currently holds. Mirrors the
  // live client's loop of re-invoking chooseWord on every rack change
  // until nothing more is playable.
  function playOutOurs() {
    for (;;) {
      const word = chooseWord({
        myRack: us.rack,
        dictionary: DICTIONARY,
        myBalance: us.balance,
        bagTotal: bagTotal(bag),
      });
      if (!word) return;
      const reward = totalReward(word);
      spend(us.rack, word);
      us.balance += reward;
      us.score += reward;
      tracker.noteWordPlayed(us.id, word);
    }
  }

  function simPlay(bot: BotState) {
    const word = findLongestPlayable(bot.rack, 3);
    if (!word) return;
    const reward = totalReward(word);
    spend(bot.rack, word);
    bot.balance += reward;
    bot.score += reward;
    tracker.noteWordPlayed(bot.id, word);
  }

  playOutOurs();

  // Auction loop — one auction per tile that ever gets drawn into one.
  while (bagTotal(bag) > 0) {
    const letter = drawLetter(bag, rng)!;
    tracker.noteAuctionOpened(letter);
    const roundsLeft = bagTotal(bag); // matches matchState.bagTotal's timing

    const bidAmounts = new Map<bigint, number>();
    for (const bot of bots) {
      if (bot.balance <= 0) continue;
      if (bot.strategy === "Ours") {
        const participants: Participant[] = bots.map((b) => ({
          botId: b.id,
          balance: b.balance,
          score: b.score,
        }));
        const amount = decideBid({
          letter,
          myBalance: bot.balance,
          myRack: bot.rack,
          dictionary: DICTIONARY,
          remainingBag: tracker.remainingBag(),
          bagTotal: roundsLeft,
          auctionType,
          participants,
        });
        if (amount > 0) bidAmounts.set(bot.id, amount);
      } else {
        const jitter = Math.floor(rng() * (2 * SIM_BID_JITTER + 1)) - SIM_BID_JITTER;
        const amount = simDecideBid(bot.strategy, letter, bot.balance, jitter);
        if (amount > 0) bidAmounts.set(bot.id, amount);
      }
    }

    const bidders = [...bidAmounts.entries()].map(([botId, amount]) => ({ botId, amount }));
    shuffle(rng, bidders); // ties broken at random, same as the server
    bidders.sort((a, b) => b.amount - a.amount);
    const [first, second] = bidders;

    if (first) {
      const paid =
        auctionType === "FirstPrice"
          ? first.amount
          : second
            ? second.amount
            : Math.min(AUCTION_RESERVE, first.amount);
      const winner = bots.find((b) => b.id === first.botId)!;
      winner.balance -= paid;
      winner.rack.set(letter, (winner.rack.get(letter) ?? 0) + 1);
      tracker.noteAuctionWon(winner.id, letter);

      if (winner.id === OUR_BOT_ID) playOutOurs();
      else simPlay(winner);
    }
  }

  const scores = bots.map((b) => b.score).sort((a, b) => b - a);
  const ourRank = scores.indexOf(us.score) + 1;

  let strandedValue = 0;
  const strandedRack = new Map(us.rack);
  for (;;) {
    const best = bestWord(strandedRack, DICTIONARY);
    if (!best) break;
    strandedValue += best.reward;
    spend(strandedRack, best.word);
  }

  return {
    ourScore: us.score,
    ourRank,
    ourBalanceLeft: us.balance,
    ourStrandedValue: strandedValue,
  };
}

// ---------- Batch runner ----------

function runBatch(n: number, opponents: SimStrategy[], seed: number) {
  const rng = mulberry32(seed);
  const results: MatchResult[] = [];
  for (let i = 0; i < n; i++) results.push(runMatch(opponents, rng));

  const avg = (f: (r: MatchResult) => number) =>
    results.reduce((sum, r) => sum + f(r), 0) / results.length;
  const wins = results.filter((r) => r.ourRank === 1).length;

  console.log(`\n${n} matches, opponents: [${opponents.join(", ")}]`);
  console.log(`  avg score:            ${avg((r) => r.ourScore).toFixed(1)}`);
  console.log(`  avg rank (1=best):    ${avg((r) => r.ourRank).toFixed(2)} / ${opponents.length + 1}`);
  console.log(`  win rate:             ${((wins / n) * 100).toFixed(1)}%`);
  console.log(`  avg balance left:     ${avg((r) => r.ourBalanceLeft).toFixed(1)} (want ~0)`);
  console.log(`  avg stranded value:   ${avg((r) => r.ourStrandedValue).toFixed(1)} (want ~0)`);
}

function main() {
  // Fixed by default so two runs are directly comparable when tuning
  // strategy.ts — override with SIM_SEED to sanity-check across seeds.
  const n = Number(process.env.SIM_MATCHES ?? process.argv[2] ?? 500);
  const seed = Number(process.env.SIM_SEED ?? 1);
  runBatch(n, DEFAULT_OPPONENTS, seed);
  // A few other opponent mixes, to avoid overfitting to one lobby shape.
  runBatch(n, ["Aggressive", "Aggressive", "Aggressive", "Aggressive", "Aggressive"], seed);
  runBatch(n, ["Cheapskate", "Cheapskate", "Cheapskate", "Cheapskate", "Cheapskate"], seed);
  runBatch(n, ["Human", "Human", "ValueBidder", "ValueBidder", "Aggressive"], seed);
}

main();
