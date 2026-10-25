// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseWord, decideBid, type Participant } from "./strategy.js";
import { Trackers } from "./trackers.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

// Watchdog: the SDK has no ping/heartbeat, so a connection that goes dead
// without a clean WebSocket close (observed live: 25+ minutes of silence,
// 0% CPU, no "disconnected" log, costing an entire match of missed
// auctions) never triggers onDisconnect or automatic reconnect — nothing
// tells the SDK the socket is gone. This is a cheap backstop: any global
// table event (there's a constant stream of them server-wide once
// subscribed, far more often than this timeout) resets the clock; if
// none arrive for too long, exit and let the process supervisor (run.sh)
// restart with a genuinely fresh connection instead of trying to revive
// a possibly half-open one in place.
let lastEventAt = Date.now();
const WATCHDOG_TIMEOUT_MS = 45_000;
setInterval(() => {
  if (Date.now() - lastEventAt > WATCHDOG_TIMEOUT_MS) {
    console.error(
      `[${BOT_NAME}] no events for ${WATCHDOG_TIMEOUT_MS}ms — connection likely dead, exiting for a clean restart`,
    );
    process.exit(1);
  }
}, 10_000).unref();

// Reconstructs the remaining bag + opponent racks per match from public
// tables — see trackers.ts. Keyed by matchId, dropped when a match ends.
const trackers = new Trackers();

type MatchStateRow = NonNullable<
  ReturnType<DbConnection["db"]["matchState"]["id"]["find"]>
>;

// subscribeToAllTables() replicates the ENTIRE shared database client-side
// — every match any bot has ever played server-wide (tens of thousands of
// rows in match_state / match_participant / auction / word_play, not just
// ours). The SDK's own "indexed" table accessors (`.id.find()`,
// `.mpByMatch.filter()`, etc.) are actually full table scans under the
// hood in this SDK version (see node_modules/spacetimedb: "TODO: this just
// scans the whole table; we should build proper index structures"), so a
// handler that runs on every auction/word-play event server-wide and calls
// one of those pegs the CPU once the table is large. These two maps are
// real O(1) local indexes, built incrementally from insert/update events
// instead, and pruned whenever a match ends (ours or not) so they stay
// bounded to currently-running matches rather than the game's whole
// history.
const matchStateById = new Map<bigint, MatchStateRow>();
const participantsByMatch = new Map<
  bigint,
  Map<bigint, { balance: number; score: number }>
>();
// Matches we're (or have been) a participant in — a small subset of
// participantsByMatch's keys, so loops like "am I in a running match"
// don't have to scan every match server-wide either.
const myMatchIds = new Set<bigint>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

// Every bot's live balance/score in a match — match_participant is a fully
// public table, so this isn't limited to our own bot.
function participantsForMatch(matchId: bigint): Participant[] {
  const byBot = participantsByMatch.get(matchId);
  if (!byBot) return [];
  return [...byBot.entries()].map(([botId, p]) => ({
    botId,
    balance: p.balance,
    score: p.score,
  }));
}

function participantForMatch(
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  return participantsByMatch.get(matchId)?.get(myBotId) ?? null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(matchId);
  if (!participant) return;
  const match = matchStateById.get(matchId);
  if (!match) return;
  const tracker = trackers.forMatch(matchId);
  tracker.noteOwnStartingRack(rackForMatch(conn, matchId));
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
    dictionary: DICTIONARY,
    remainingBag: tracker.remainingBag(),
    bagTotal: match.bagTotal,
    auctionType: match.auctionType.tag,
    participants: participantsForMatch(matchId),
  });
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const now = Date.now();
  for (const matchId of myMatchIds) {
    const match = matchStateById.get(matchId);
    if (match?.status.tag !== "Running") continue;
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const participant = participantForMatch(matchId);
    if (!participant) continue;
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
      myBalance: participant.balance,
      bagTotal: match.bagTotal,
    });
    if (!word) continue;
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  // Proof of life for the staleness watchdog above — auction_result fires
  // constantly server-wide (far more often than WATCHDOG_TIMEOUT_MS) any
  // time the connection is actually receiving data.
  conn.db.auctionResult.onInsert(() => {
    lastEventAt = Date.now();
  });

  // subscribeToAllTables() subscribes to the whole shared database — every
  // match any bot is playing server-wide, not just ours. These two keep
  // matchStateById / participantsByMatch (the real local indexes — see
  // their declaration above) current from every insert/update, O(1) per
  // event regardless of table size.
  conn.db.matchState.onInsert((_ctx, m) => {
    matchStateById.set(m.id, m);
  });
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    let byBot = participantsByMatch.get(p.matchId);
    if (!byBot) {
      byBot = new Map();
      participantsByMatch.set(p.matchId, byBot);
    }
    byBot.set(p.botId, { balance: Number(p.balance), score: Number(p.score) });
    if (myBotId !== null && p.botId === myBotId) myMatchIds.add(p.matchId);
  });
  conn.db.matchParticipant.onUpdate((_ctx, _old, neu) => {
    participantsByMatch
      .get(neu.matchId)
      ?.set(neu.botId, { balance: Number(neu.balance), score: Number(neu.score) });
  });

  // All of the handlers below check participantForMatch first so tracker
  // state and logging stay scoped to matches we're actually in; skipping
  // that check means touching (and logging) thousands of other bots'
  // matches too.
  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (!participantForMatch(a.matchId)) return;
    // Every auction reveals its letter the instant it opens, win or not —
    // feed the bag-reconstruction tracker regardless of whether we end up
    // bidding on it.
    trackers.forMatch(a.matchId).noteAuctionOpened(a.letter);
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (!participantForMatch(r.matchId)) return;
    if (r.winnerBotId !== undefined && r.winnerBotId !== null) {
      trackers.forMatch(r.matchId).noteAuctionWon(r.winnerBotId, r.letter);
    }
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });
  // Every bot's word plays in our matches are public — fold them in too,
  // so opponent racks (not just the bag) stay reconstructed.
  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (!participantForMatch(w.matchId)) return;
    trackers.forMatch(w.matchId).noteWordPlayed(w.botId, w.word);
  });

  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    matchStateById.set(neu.id, neu);
    if (old.status.tag === "Ended" || neu.status.tag !== "Ended") return;
    // A match just ended — ours or not. Prune it from every local index
    // regardless (no-op if it was never one of ours) so they stay bounded
    // to currently-running matches rather than the game's whole history.
    const wasIn = myMatchIds.delete(neu.id);
    trackers.drop(neu.id);
    participantsByMatch.delete(neu.id);
    matchStateById.delete(neu.id);
    if (myBotId !== null && wasIn) {
      console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
      joinLobby(conn);
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = [...myMatchIds].some(
    (matchId) => matchStateById.get(matchId)?.status.tag === "Running",
  );
  if (inRunning) return;
  const openLobby = [...conn.db.lobby.iter()].find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    [...conn.db.lobbyMember.iter()].some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  // matchParticipant.onInsert only adds to myMatchIds once myBotId is
  // known, but the initial bulk sync (thousands of historical rows) fires
  // before that — so backfill once here. participantsByMatch is already
  // fully populated regardless of myBotId timing, and bootstrapActivity
  // only runs after myBotId is resolved, so this is a one-time, bounded
  // scan over "every match ever" (not a repeated one).
  if (myBotId !== null) {
    for (const [matchId, byBot] of participantsByMatch) {
      if (byBot.has(myBotId)) myMatchIds.add(matchId);
    }
  }
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag !== "Open") continue;
    // conn.db.auction holds every open auction server-wide, not just ours.
    if (!participantForMatch(a.matchId)) continue;
    // A match already under way when we (re)connect: the tracker starts
    // fresh here, so its bag estimate won't reflect rounds before we
    // joined — acceptable for a bot that stays connected between matches.
    trackers.forMatch(a.matchId).noteAuctionOpened(a.letter);
    tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    // A silent connection drop mid-match is costly: this tournament
    // bidding/word-play loop only runs while connected, so every round
    // missed while reconnecting is lost outright (observed live: one
    // stall mid-match cost an entire match's worth of auctions). Retries
    // with exponential backoff; handlers and subscription state are
    // preserved and replayed automatically across a reconnect.
    .withAutomaticReconnect()
    .onConnect(onConnect)
    .onAutomaticReconnect((conn, identity, token) => {
      console.log(`[${BOT_NAME}] reconnected as ${identity.toHexString()}`);
      saveToken(token);
      // Catch up immediately on whatever's open right now rather than
      // waiting for the next insert event, same as the initial connect.
      bootstrapActivity(conn);
    })
    .onConnectError(
      (_ctx: ErrorContext, err: Error, nextAttempt?: number, nextDelayMs?: number) =>
        console.error(
          `[${BOT_NAME}] connect error: ${err.message}` +
            (nextAttempt !== undefined
              ? ` (retry ${nextAttempt} in ${nextDelayMs}ms)`
              : ""),
        ),
    )
    .onDisconnect(
      (_ctx: ErrorContext, err?: Error, nextAttempt?: number, nextDelayMs?: number) =>
        console.log(
          `[${BOT_NAME}] disconnected${err ? `: ${err.message}` : ""}` +
            (nextAttempt !== undefined
              ? ` (retry ${nextAttempt} in ${nextDelayMs}ms)`
              : ""),
        ),
    )
    .build();
}

main();
