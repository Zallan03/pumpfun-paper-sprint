// Tide Runner v2 — pump.fun paper sprint bot (pumpfun-replay/v2).
//
// v1 graded on the dev window at -1.67 SOL: it bought nearly every coin
// that ticked +5% with four buyers, and most of those coins then died —
// 79 of 492 coins positive, median coin -0.0045 SOL. Worse, one huge-supply
// coin left a position the harness refuses to sell in one order (a sell
// whose SOL proceeds exceed the curve's real SOL reserve is rejected with
// max_order_size), so the bot re-sent the same sell 17,853 times.
//
// v2 fixes both, on principle rather than by tuning to the dev coins:
//   - Entry is two-stage and far more selective. A coin first has to prove
//     demand (10+ trades, 6+ distinct buyers, buy volume at least twice
//     sell volume, real reserves of 2+ SOL) and cross +5%; it only becomes
//     a buy when, at least 10 slots later, its price is still at or above
//     that first-cross price and still within +8%..+30% of create. A coin
//     that spikes and instantly dumps never gets bought.
//   - Exits are faster: take half at +20%, the rest at +60% or breakeven,
//     stop-loss -10%, time-stop 1800 slots. Losers are cut sooner and the
//     five slots rotate faster.
//   - Sells are chunked: no single sell may take more than a quarter of
//     the curve's real SOL reserve out, so a huge-token position is sold
//     down over several batches instead of being rejected forever.
// Every decision is still a pure function of the hello message and the
// batches seen so far, so two runs of the same replay produce
// byte-identical orders (no randomness, no clock).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;

// ---- sizing ---------------------------------------------------------------
const STAKE_LAMPORTS = SOL / 10n; // 0.10 SOL per coin
const MIN_BUY_LAMPORTS = SOL / 100n; // 0.01 SOL — the guardrail's round-trip floor
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- entry filters ----------------------------------------------------------
const MIN_TRADES = 10;
const MIN_DISTINCT_BUYERS = 6;
const WATCH_RISE_BPS = 500; // +5% over create price: start watching
const WATCH_MIN_AGE_SLOTS = 10; // buy only this many slots after the watch
const ENTRY_MIN_RISE_BPS = 800; // +8% over create price
const ENTRY_MAX_RISE_BPS = 3000; // +30% over create price
const MIN_REAL_RESERVE_LAMPORTS = 2n * SOL; // real money must be in the curve
const ENTRY_MAX_AGE_SLOTS = 1800; // only young coins (~12 min of slots)

// ---- exit rules ---------------------------------------------------------------
const TAKE_PROFIT_1_BPS = 2000; // +20%: sell half
const TAKE_PROFIT_2_BPS = 6000; // +60%: sell the rest
const STOP_LOSS_BPS = 1000; // -10% from average cost: sell all
const TIME_STOP_SLOTS = 1800; // ~12 min of slots: sell all

// One sell may take at most this share of the curve's real SOL reserve out;
// the harness rejects a sell whose proceeds exceed the real reserve.
const MAX_SELL_PROCEEDS_SHARE_NUM = 1n;
const MAX_SELL_PROCEEDS_SHARE_DEN = 4n;

interface Tape {
  createQuote: bigint;
  createTokens: bigint;
  createdSlot: number;
  trades: number;
  buyers: Set<string>;
  buyVolume: bigint;
  sellVolume: bigint;
  decided: boolean;
  watchSlot: number | null;
  watchQuote: bigint;
  watchTokens: bigint;
}

interface Held {
  firstSeenSlot: number;
  tookProfit: boolean;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();

// Price ratio in bps: (quoteA / tokensA) relative to (quoteB / tokensB),
// minus 10000. Pure bigint math, no floats anywhere.
function riseBps(
  quoteA: bigint,
  tokensA: bigint,
  quoteB: bigint,
  tokensB: bigint,
): bigint {
  if (tokensA <= 0n || tokensB <= 0n || quoteB <= 0n) return -10_000n;
  const scaled = (quoteA * tokensB * 10_000n) / (quoteB * tokensA);
  return scaled - 10_000n;
}

// Largest token amount whose estimated SOL proceeds stay within the allowed
// share of the curve's real SOL reserve. Zero when nothing can be sold yet.
function maxSellTokens(
  want: bigint,
  virtualQuote: bigint,
  virtualTokens: bigint,
  realQuote: bigint,
): bigint {
  const allowed = (realQuote * MAX_SELL_PROCEEDS_SHARE_NUM) / MAX_SELL_PROCEEDS_SHARE_DEN;
  if (allowed <= 0n) return 0n;
  if (virtualQuote <= allowed) return want;
  const cap = (allowed * virtualTokens) / (virtualQuote - allowed);
  if (cap <= 0n) return 0n;
  return cap < want ? cap : want;
}

function observeEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      if (!tapes.has(e.mint)) {
        tapes.set(e.mint, {
          createQuote: BigInt(e.virtual_quote_reserves),
          createTokens: BigInt(e.virtual_token_reserves),
          createdSlot: e.slot,
          trades: 0,
          buyers: new Set<string>(),
          buyVolume: 0n,
          sellVolume: 0n,
          decided: false,
          watchSlot: null,
          watchQuote: 0n,
          watchTokens: 1n,
        });
      }
      continue;
    }
    if (e.event !== "TradeEvent") continue;
    let tape = tapes.get(e.mint);
    if (tape === undefined) {
      // First sight through a trade (no CreateEvent in this window): use
      // this trade's reserves as the reference price.
      tape = {
        createQuote: BigInt(e.virtual_quote_reserves),
        createTokens: BigInt(e.virtual_token_reserves),
        createdSlot: e.slot,
        trades: 0,
        buyers: new Set<string>(),
        buyVolume: 0n,
        sellVolume: 0n,
        decided: false,
        watchSlot: null,
        watchQuote: 0n,
        watchTokens: 1n,
      };
      tapes.set(e.mint, tape);
    }
    tape.trades += 1;
    const volume = BigInt(e.sol_amount);
    if (e.is_buy) {
      tape.buyers.add(e.user);
      tape.buyVolume += volume;
    } else {
      tape.sellVolume += volume;
    }
  }
}

function pendingSellMints(state: BotState): Set<string> {
  const mints = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === "sell") mints.add(p.order.mint);
  }
  return mints;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    observeEvents(batch);
    const orders: Array<BuyInput | SellInput> = [];
    const txFee = state.txFeeLamports();
    const { caps } = state.hello;
    const selling = pendingSellMints(state);

    // ---- exits first: free a slot before deciding new entries ------------
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (selling.has(mint)) continue;
      let rec = held.get(mint);
      if (rec === undefined) {
        rec = { firstSeenSlot: batch.slot, tookProfit: false };
        held.set(mint, rec);
      }
      const value = (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      const gainBps = riseBps(value, 1n, pos.cost_lamports, 1n);
      const age = batch.slot - rec.firstSeenSlot;
      let want = 0n;
      if (!rec.tookProfit) {
        if (gainBps >= TAKE_PROFIT_1_BPS) {
          want = pos.token_amount / 2n;
          rec.tookProfit = true;
        } else if (gainBps <= -STOP_LOSS_BPS || age > TIME_STOP_SLOTS) {
          want = pos.token_amount;
          held.delete(mint);
        }
      } else {
        // Half already banked: let the rest run to +60%, or cut it at
        // breakeven / on the time stop.
        if (gainBps >= TAKE_PROFIT_2_BPS || gainBps <= 0n || age > TIME_STOP_SLOTS) {
          want = pos.token_amount;
          held.delete(mint);
        }
      }
      if (want > 0n) {
        const amount = maxSellTokens(
          want,
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          curve.real_quote_reserves,
        );
        if (amount > 0n) {
          orders.push({
            side: "sell",
            mint,
            token_amount: amount,
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
        }
      }
    }
    // Drop tracking for coins no longer held (sold, completed, flattened).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // ---- entries: young coins whose tape shows real, holding demand ------
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const tape = tapes.get(e.mint);
      if (tape === undefined || tape.decided) continue;
      if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        tape.decided = true;
        continue;
      }
      if (batch.slot - tape.createdSlot > ENTRY_MAX_AGE_SLOTS) {
        tape.decided = true;
        continue;
      }
      const rise = riseBps(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        tape.createQuote,
        tape.createTokens,
      );
      // Stage one: first cross of +5% arms the watch; a coin that spikes
      // and instantly dumps never gets bought.
      if (tape.watchSlot === null) {
        if (rise < WATCH_RISE_BPS) continue;
        tape.watchSlot = batch.slot;
        tape.watchQuote = curve.virtual_quote_reserves;
        tape.watchTokens = curve.virtual_token_reserves;
        continue;
      }
      // Stage two: buy only if the price held up since the watch, the tape
      // is strong, and the rise is still in range.
      if (batch.slot - tape.watchSlot < WATCH_MIN_AGE_SLOTS) continue;
      const heldRise = riseBps(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        tape.watchQuote,
        tape.watchTokens,
      );
      if (heldRise < 0n) {
        tape.decided = true;
        continue;
      }
      if (rise < ENTRY_MIN_RISE_BPS || rise > ENTRY_MAX_RISE_BPS) continue;
      if (tape.trades < MIN_TRADES) continue;
      if (tape.buyers.size < MIN_DISTINCT_BUYERS) continue;
      if (tape.buyVolume <= tape.sellVolume * 2n) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      // Only mark the coin decided once the buy is actually placed: if
      // cash is short this batch, it stays eligible for a later batch.
      if (free < amount + txFee) continue;
      tape.decided = true;
      orders.push({
        side: "buy",
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      slots -= 1;
    }
    return orders;
  },
});
