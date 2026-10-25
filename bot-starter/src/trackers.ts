// Per-match state reconstructed entirely from already-public tables: the
// remaining bag composition and every opponent's current rack. Nothing
// here needs a private table — `auction.letter` is public the instant an
// auction opens, `auction_result` and `word_play` are public archives.
// (The spectator UI does the same trick for opponent racks in
// src/util.ts: reconstructRacks().)

import { DEFAULT_BAG } from "./scoring.js";

export class MatchTracker {
  private bag = new Map<string, number>(DEFAULT_BAG);
  private opponentRacks = new Map<bigint, Map<string, number>>();
  private ownRackCaptured = false;

  // Call once, as soon as our own starting rack is visible (the first
  // myRack rows for this match). Later calls are ignored — this is only
  // meant to seed the bag estimate once.
  noteOwnStartingRack(rack: ReadonlyMap<string, number>) {
    if (this.ownRackCaptured) return;
    this.ownRackCaptured = true;
    for (const [letter, count] of rack) this.deplete(letter, count);
  }

  // Every auction reveals its letter the moment it opens, win or not —
  // that tile has left the undrawn bag either way.
  noteAuctionOpened(letter: string) {
    this.deplete(letter, 1);
  }

  // `botId` won `letter`. (The bag was already depleted for this tile by
  // `noteAuctionOpened`; this just credits the winner's reconstructed rack.)
  noteAuctionWon(botId: bigint, letter: string) {
    const rack = this.rackFor(botId);
    rack.set(letter, (rack.get(letter) ?? 0) + 1);
  }

  // `botId` played `word`. This is also how we retroactively learn the
  // composition of a bot's hidden starting-rack tiles, once played.
  noteWordPlayed(botId: bigint, word: string) {
    const rack = this.rackFor(botId);
    for (const c of word) {
      const have = rack.get(c) ?? 0;
      if (have <= 1) rack.delete(c);
      else rack.set(c, have - 1);
    }
  }

  private rackFor(botId: bigint): Map<string, number> {
    let rack = this.opponentRacks.get(botId);
    if (!rack) {
      rack = new Map();
      this.opponentRacks.set(botId, rack);
    }
    return rack;
  }

  private deplete(letter: string, n: number) {
    const remaining = this.bag.get(letter) ?? 0;
    this.bag.set(letter, Math.max(0, remaining - n));
  }

  // Best estimate of what's left in the bag, by letter. Exact except for
  // the (shrinking over the match) set of opponents' starting-rack tiles
  // they haven't played yet — those already left the physical bag but
  // can't be attributed to a specific letter until played, so this
  // slightly overcounts scarce letters early in a match.
  remainingBag(): ReadonlyMap<string, number> {
    return this.bag;
  }

  // Best-known current rack for one opponent — a lower bound, missing any
  // still-unplayed starting-rack letters we can't see.
  opponentRack(botId: bigint): ReadonlyMap<string, number> {
    return this.rackFor(botId);
  }
}

// One MatchTracker per live match. Call `drop` when a match ends so a
// long-running bot process doesn't accumulate state forever.
export class Trackers {
  private byMatch = new Map<bigint, MatchTracker>();

  forMatch(matchId: bigint): MatchTracker {
    let t = this.byMatch.get(matchId);
    if (!t) {
      t = new MatchTracker();
      this.byMatch.set(matchId, t);
    }
    return t;
  }

  drop(matchId: bigint) {
    this.byMatch.delete(matchId);
  }
}
