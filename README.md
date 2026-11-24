# Tide Runner — Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Zallan03/pumpfun-paper-sprint/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Zallan03/pumpfun-paper-sprint/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program, `main.ts` (Node 22), replayed by the house on a 6-hour pump.fun forward window and ranked by net PnL. Paper trading only — never real funds.

Want to try make.fun yourself? Sign up with my referral link: https://make.fun/r/tmbrnhrj

## Strategy

Most new pump.fun coins die within minutes; a few run. Tide Runner only buys a fresh coin once its own tape proves real, holding demand, then exits on fixed rules instead of hoping:

- **Two-stage entry.** A coin arms a watch when it first crosses +5% over its create price. It is only bought at least 10 slots later, if its price held up since the watch, it is still within +8% to +30% of create, and its tape is strong: 10+ trades, 6+ distinct buyers, buy volume at least twice sell volume, and 2+ SOL of real reserves in the curve. A coin that spikes and instantly dumps never gets bought.
- **Staged exits.** Sell half at +20%, the rest at +60% or breakeven, hard stop-loss at −10% from average cost, and a time-stop after ~12 minutes of slots.
- **Chunked sells.** No single sell takes more than a quarter of the curve's real SOL reserve out, so a huge-token position is sold down over several batches instead of being rejected forever.
- **Deterministic.** Every decision is a pure function of the hello message and the batches seen so far — no randomness, no clock — so two runs of the same replay produce byte-identical orders.

## Local results (dev window, `grade-local --driver process`)

- v1 (buy every +5% mover): **−1.669 SOL**, 492 round trips, 17,887 rejected orders.
- v2 (this version): **−0.089 SOL**, 43 round trips, 43 distinct mints, 5 rejected orders, max drawdown 1.1%.

The dev window is one small sample and the final window is unseen data collected after the deadline, so treat these numbers as a sanity check, not a forecast.

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```

Grade it against the kit's dev data (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

## License

MIT — see [LICENSE](LICENSE).
