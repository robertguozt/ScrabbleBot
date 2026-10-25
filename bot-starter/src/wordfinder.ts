// Reward-maximizing word search over the shared dictionary. Replaces the
// starter's "first word in longest-first order" with "highest totalReward
// playable word" — those aren't always the same word (a short word of
// high-value letters can beat a long word of cheap ones).
//
// Keep this fast: decideBid calls this (twice) on *every* auction, and
// chooseWord calls it on every rack change (debounced 500ms) — both must
// finish well within a 1-second auction window. The dictionary (~173k
// words) is compiled once per distinct `dictionary` array into flat
// Int8Array letter-count rows, so a lookup is a few thousand integer
// comparisons instead of per-word object allocation + string iteration.

import { totalReward } from "./scoring.js";

export interface WordMatch {
  word: string;
  reward: number;
}

interface Compiled {
  words: readonly string[];
  lengths: Int32Array;
  rewards: Int32Array;
  // Row i, 26 entries: letter counts for words[i]. Flattened for locality.
  counts: Int8Array;
}

const A = "A".charCodeAt(0);
const cache = new WeakMap<readonly string[], Compiled>();

function compile(dictionary: readonly string[]): Compiled {
  const cached = cache.get(dictionary);
  if (cached) return cached;

  const n = dictionary.length;
  const lengths = new Int32Array(n);
  const rewards = new Int32Array(n);
  const counts = new Int8Array(n * 26);

  for (let i = 0; i < n; i++) {
    const word = dictionary[i]!;
    lengths[i] = word.length;
    rewards[i] = totalReward(word);
    const base = i * 26;
    for (let j = 0; j < word.length; j++) {
      const slot = word.charCodeAt(j) - A;
      if (slot >= 0 && slot < 26) counts[base + slot]!++;
    }
  }

  const compiled: Compiled = { words: dictionary, lengths, rewards, counts };
  cache.set(dictionary, compiled);
  return compiled;
}

function rackToCounts(rack: ReadonlyMap<string, number>): {
  counts: Int32Array;
  total: number;
} {
  const counts = new Int32Array(26);
  let total = 0;
  for (const [letter, n] of rack) {
    const slot = letter.charCodeAt(0) - A;
    if (slot >= 0 && slot < 26) {
      counts[slot] += n;
      total += n;
    }
  }
  return { counts, total };
}

function bestFromCounts(
  compiled: Compiled,
  rackCounts: Int32Array,
  rackTotal: number,
): WordMatch | null {
  const { words, lengths, rewards, counts } = compiled;
  let bestIdx = -1;
  let bestReward = -1;

  for (let i = 0; i < words.length; i++) {
    if (lengths[i]! > rackTotal) continue;
    if (rewards[i]! <= bestReward) continue; // can't improve on current best
    const base = i * 26;
    let playable = true;
    for (let j = 0; j < 26; j++) {
      if (counts[base + j]! > rackCounts[j]!) {
        playable = false;
        break;
      }
    }
    if (!playable) continue;
    bestReward = rewards[i]!;
    bestIdx = i;
  }

  return bestIdx < 0 ? null : { word: words[bestIdx]!, reward: bestReward };
}

// The single best playable word from `rack`, or null if nothing fits.
export function bestWord(
  rack: ReadonlyMap<string, number>,
  dictionary: readonly string[],
): WordMatch | null {
  const { counts, total } = rackToCounts(rack);
  if (total === 0) return null;
  return bestFromCounts(compile(dictionary), counts, total);
}

// The best playable word if we additionally held one more `letter`, or
// null if still nothing fits. Used to value a letter by how much it
// improves on what's already playable.
export function bestWordWith(
  rack: ReadonlyMap<string, number>,
  letter: string,
  dictionary: readonly string[],
): WordMatch | null {
  const { counts, total } = rackToCounts(rack);
  const slot = letter.charCodeAt(0) - A;
  if (slot >= 0 && slot < 26) counts[slot]! += 1;
  return bestFromCounts(compile(dictionary), counts, total + 1);
}
