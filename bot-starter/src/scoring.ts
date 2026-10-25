// Mirrors spacetimedb/src/letters.ts exactly, so local reward estimates
// never drift from what the server actually pays.

export function letterValue(c: string): number {
  switch (c) {
    case "A":
    case "E":
    case "I":
    case "O":
    case "U":
    case "L":
    case "N":
    case "S":
    case "T":
    case "R":
      return 1;
    case "D":
    case "G":
      return 2;
    case "B":
    case "C":
    case "M":
    case "P":
      return 3;
    case "F":
    case "H":
    case "V":
    case "W":
    case "Y":
      return 4;
    case "K":
      return 5;
    case "J":
    case "X":
      return 8;
    case "Q":
    case "Z":
      return 10;
    default:
      return 0;
  }
}

// Standard Scrabble distribution, no blanks. 98 tiles total.
export const BAG_SIZE = 98;
export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9],
  ["B", 2],
  ["C", 2],
  ["D", 4],
  ["E", 12],
  ["F", 2],
  ["G", 3],
  ["H", 2],
  ["I", 9],
  ["J", 1],
  ["K", 1],
  ["L", 4],
  ["M", 2],
  ["N", 6],
  ["O", 8],
  ["P", 2],
  ["Q", 1],
  ["R", 6],
  ["S", 4],
  ["T", 6],
  ["U", 4],
  ["V", 2],
  ["W", 2],
  ["X", 1],
  ["Y", 2],
  ["Z", 1],
];

// Length-based reward multiplier as [numerator, denominator]; the server
// computes totalReward = baseScore * num / denom with integer (bigint)
// division. We mirror that with plain numbers and Math.floor so our
// estimate matches the server's rounding, not just its ratio.
export function lengthMultiplierRatio(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function baseScore(word: string): number {
  let total = 0;
  for (const c of word) total += letterValue(c);
  return total;
}

// Integer division matching the server's bigint math (floor toward zero,
// which for non-negative scores is the same as Math.floor).
export function totalReward(word: string): number {
  const base = baseScore(word);
  const [num, denom] = lengthMultiplierRatio(word.length);
  return Math.floor((base * num) / denom);
}
