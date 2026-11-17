[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Kuyukbot1/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Kuyukbot1/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

An entry for the [make.fun bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01).

# GTA VI Twitch CCU forecast — gta6-twitch-ccu-forecast-01

A program that forecasts, hour by hour, how many people watch Grand Theft
Auto VI live on Twitch over the 24 UTC hours of its release day
(2026-11-19), from everything recorded up to the end of the day's first
hour, as five quantiles an hour.

## What it does

- `main.ts` (Node 22, standard library only, deterministic) reads one case
  JSON per run and writes `<id>.out` with 23 rows (hours 2–24), each five
  quantiles `[q05, q25, q50, q75, q95]`. It runs offline, no network, in
  about 0.25 s per case.
- The model is fitted at run time from the case file's own comparables —
  nothing is fitted to the final case, which nobody can see:
  1. **Pool:** past launches whose tier is `comparable`, whose platforms
     list no PC (console-only, rolling midnight unlock), with a complete
     24-hour release-day curve and an hour-1 print of at least 1000
     viewers. PC-simultaneous launches are left out: their global PC
     unlock puts the peak in hour 1, which looks nothing like a console
     rolling launch.
  2. **Shape:** for each hour, the median across the pool of
     `log(viewers_h / viewers_1)` — the launch-day curve in units of the
     first hour's print, which anchors the level.
  3. **Rise-vs-midnight effect:** for hours 9–24 the log-ratio correlates
     about −0.7 to −0.86 with `log(hour-1)` (slope ≈ −0.3): a launch whose
     midnight hour is already huge has less headroom left to rise. One
     pooled regression slope adjusts the median for the case's own
     hour-1 print.
  4. **Spread:** per hour, the interquartile range of the residuals
     divided by 1.349, floored at 0.10 log units and scaled by 1.4.
     Quantiles are `p1 * exp(median + z_tau * sigma)`.
  5. If fewer than 3 launches qualify for the pool, it falls back to the
     house persistence forecast instead of failing.

## Why this shape

A console launch does not spike once at midnight. It unlocks region by
region — New Zealand at 11:00Z the day before, central Europe at 23:00Z,
the UK at 00:00Z, the US east coast at 05:00Z, the west coast at 08:00Z —
so the UTC day holds several waves: a dip in hours 2–4 (night in
Europe/Asia, the US not yet in), a jump at hour 5–6 (US East), a midday
sag, then a steady climb to the evening prime-time peak at hours 18–22.
The comparables show this pattern again and again; the model reads it off
them instead of assuming a flat line.

## Validation

Practice answers were fetched once from SullyGnome's public chart API,
the source the kit's `NOTICE.txt` names (the case files hold no answers).
Mean pinball loss on the log scale, mine vs the house persistence baseline:

| case | mine | persistence |
| --- | --- | --- |
| p00 Marvel's Wolverine | 0.359 | 0.744 |
| p01 Red Dead Redemption 2 | 0.149 | 0.287 |
| p02 God of War Ragnarök | 0.097 | 0.215 |
| p03 Marvel's Spider-Man 2 | 0.160 | 0.303 |
| **mean** | **0.191** | **0.387** |

Leave-one-out over the 7 pool launches: 6 of 7 beat persistence
(mean 0.160 vs 0.344). Full numbers, rejected alternatives and the
determinism check are in `BUILD_LOG.md` in the bounty folder (not part of
the entry).

## Run it

```bash
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Two runs of one case write byte-identical output.
