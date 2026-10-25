// Bidding and word-choice strategy. See ../../DEVELOP.md and /docs for the
// game rules this is built against.
//
// Bidding: in a Vickrey auction (the default), sincere bidding of your
// true value for the item is weakly dominant — so the interesting problem
// isn't shading the bid, it's estimating the value accurately. That's what
// decideBid spends its effort on; the few knobs below exist for the parts
// Vickrey theory doesn't cover (a hard balance cap, a finite number of
// future auctions, and First-price tournaments where shading *is* correct).
//
// Word choice: the server pays zero for unplayed rack letters and zero for
// unspent balance at match end, so chooseWord has to balance "hold for a
// bigger multiplier" against "don't get stranded holding tiles when the
// bag runs out." Tune the constants below against `npm run sim` — it
// reports average balance-left and rack-left-unplayed, which should both
// trend toward zero.
//
// The values below were tuned this way against the documented sim-bot
// archetypes (see sim/simulate.ts): a naive "bid face value" baseline
// (closer to the starter's default) loses nearly every auction for a
// common letter to an opponent who pays a premium for it, which starves
// the whole rack — bidding a real premium on broadly useful letters, and
// holding out for the 3x-multiplier (7+ letter) tier before cashing in,
// is what actually won consistently across every opponent mix tried.
// Re-run `npm run sim` after changing any of them.

import { letterValue, DEFAULT_BAG } from "./scoring.js";
import { bestWord, bestWordWith } from "./wordfinder.js";

const ORIGINAL_COUNT = new Map<string, number>(DEFAULT_BAG);

// ---------- Tunable constants ----------

// Below this many tiles left in the bag, stop speculating: only bid on
// letters that pay off immediately, and play every playable word instead
// of holding out for a bigger one. Roughly "a few rounds per seat" for a
// 6-seat lobby.
export const ENDGAME_BAG_THRESHOLD = 15;

// Outside the endgame, don't let a single auction's "it might be useful
// later" component eat more than this fraction of current balance.
export const BID_PACING_FRACTION = 0.5;

// Multiplier applied to both the concrete marginal-reward signal and the
// speculative (scarcity/optionality) component. >1 bids more aggressively
// across the board; <1 more conservatively. 1.0 is "truthful" by this
// model's own value estimate.
export const AGGRESSION = 1.0;

// Play a word as soon as balance drops below this fraction of the 100
// starting balance, to refill cash for future bids.
export const LOW_BALANCE_FRACTION = 0.2;

// Outside the endgame, hold out for a word at least this long before
// cashing in (unless a low-balance or endgame trigger fires). 7 is the
// top reward tier (3x multiplier) — past that, length keeps adding base
// score but the multiplier itself can't improve further.
export const HOLD_UNTIL_LEN = 7;

// ---------- Context passed in from index.ts ----------

export interface Participant {
  botId: bigint;
  balance: number;
  score: number;
}

export interface BidContext {
  letter: string; // Letter being auctioned, e.g. "Q"
  myBalance: number; // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
  dictionary: string[]; // Shared wordlist
  remainingBag: ReadonlyMap<string, number>; // Best estimate, see trackers.ts
  bagTotal: number; // Tiles left undrawn in the match's bag (live, public)
  auctionType: "Vickrey" | "FirstPrice";
  participants: readonly Participant[]; // Every bot's live balance/score
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  myBalance: number;
  bagTotal: number;
}

// ---------- Bidding ----------

export function decideBid(ctx: BidContext): number {
  const current = bestWord(ctx.myRack, ctx.dictionary);
  const withLetter = bestWordWith(ctx.myRack, ctx.letter, ctx.dictionary);
  const marginalReward = Math.max(
    0,
    (withLetter?.reward ?? 0) - (current?.reward ?? 0),
  );

  const endgame = ctx.bagTotal <= ENDGAME_BAG_THRESHOLD;
  if (endgame) {
    // No rounds left to bank a speculative letter into a future word —
    // only pay for one that pays off right now.
    return clampToBalance(marginalReward, ctx.myBalance);
  }

  const have = ctx.myRack.get(ctx.letter) ?? 0;
  const original = ORIGINAL_COUNT.get(ctx.letter) ?? 1;
  const remaining = ctx.remainingBag.get(ctx.letter) ?? 0;
  const value = letterValue(ctx.letter);

  // Scarce letters are worth bidding near face value even with no
  // immediate use — you may not see another one.
  const scarcityThreshold = Math.max(2, Math.round(original * 0.15));
  const scarcityBonus =
    remaining <= 1 ? value : remaining <= scarcityThreshold ? value * 0.5 : 0;

  // Baseline "this is broadly useful raw material" value. Bidding bare
  // face value loses almost every auction for a cheap, common letter
  // (vowels especially) to any opponent who pays a premium for them —
  // and since currency has no other use, losing the vowel economy entirely
  // is worse than occasionally paying a bit over face value for one.
  // Vowels get the biggest premium: cheapest to win and needed in nearly
  // every word. Taper off once we're already holding a couple.
  const isVowel = "AEIOU".includes(ctx.letter);
  const genericPremium = isVowel ? 6 : 4;
  const optionalityFloor = have < 2 ? value + genericPremium : value * 0.3;

  const speculative = Math.min(
    Math.max(scarcityBonus, optionalityFloor) * AGGRESSION,
    Math.floor(ctx.myBalance * BID_PACING_FRACTION),
  );

  let bid = Math.round(Math.max(marginalReward * AGGRESSION, speculative));

  if (ctx.auctionType === "FirstPrice") {
    // Vickrey's truth-telling result doesn't hold here — shade toward the
    // standard symmetric first-price estimate to avoid the winner's curse.
    const activeBidders = Math.max(
      1,
      ctx.participants.filter((p) => p.balance > 0).length,
    );
    bid = Math.floor((bid * (activeBidders - 1)) / activeBidders);
  }

  return clampToBalance(bid, ctx.myBalance);
}

function clampToBalance(amount: number, balance: number): number {
  return Math.max(0, Math.min(amount, Math.floor(balance)));
}

// ---------- Word choice ----------

export function chooseWord(ctx: WordContext): string | null {
  const best = bestWord(ctx.myRack, ctx.dictionary);
  if (!best) return null;

  const endgame = ctx.bagTotal <= ENDGAME_BAG_THRESHOLD;
  const lowBalance = ctx.myBalance < 100 * LOW_BALANCE_FRACTION;
  const reachedTopTier = best.word.length >= HOLD_UNTIL_LEN;

  if (endgame || lowBalance || reachedTopTier) return best.word;

  // Comfortable balance, rounds still left, and nothing great on the rack
  // yet — hold and re-evaluate on the next rack change rather than cash
  // in a small, unbonused word early.
  return null;
}
