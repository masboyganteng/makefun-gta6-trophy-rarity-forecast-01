# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/masboyganteng/makefun-gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/masboyganteng/makefun-gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every Grand Theft Auto VI PlayStation 5 trophy's earn rate on Exophase at 2026-11-26T00:00:00Z, as five quantiles per trophy, from the house's recorded reads of the trophy page up to the deadline.

## Program

`main.ts` (Node 22, standard library only, no network) reads every `<id>.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes `<id>.out` to `$MAKEFUN_OUTPUT_DIR` (else `/output`):

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Deterministic and fast (~0.1 s per case, far under the 8 s cap): two runs on the same case write byte-identical output.

## Method

A trophy's rate is earners / players tracked, and both counts only grow, so each is fitted as a power law in log time, `ln(E + 0.5) ~ a + b·ln(1 + t)` and `ln P ~ c + d·ln(1 + t)`, `t` in hours since the release day began. The forecast rate is `E(T) / P(T)` at the target. A trophy whose earners outgrow the player base rises; one that lags it falls through dilution. Slopes shrink toward their tier median, and every fit pivots on its data centroid so shrinkage cannot bend the extrapolation.

Three predictions are made per trophy and the lowest (in logit space) is the median: the whole-history power law, the same fit on the last 24 hours only, and two quadratics in log time (on ln earners and on logit rate, curvatures halved) that catch a saturating trophy bending down. The whole-history law's failure mode is unbounded overshoot toward 100%, so the recent window and the quadratics cap it; the gap between the predictions widens the spread.

Two special cases come from the launch-night recording itself:

- **Stale page.** If players-tracked never moved in the whole history, Exophase has not refreshed the page once in the observed window, so a refresh before the target is expected and it dilutes every non-trivial rate. The first refresh took players 638 → 3,868 while trophies earned went 943 → 4,276, so the 3,230 new players held ~1 trophy each (the intro mission) and ~0.03 other trophies each: the median is the last rate × 0.22, with a wide spread for the unknown refresh size.
- **Intro mission.** The trophy at ≥ 99.9% stayed exactly 100% through the first refresh, so it is forecast at ~100% with a one-sided lower tail.

Spreads combine a random-walk term, the fits' residuals, refresh uncertainty, binomial count noise, an extrapolation penalty, and the disagreement between the three predictions. Story-ladder medians are kept ordered (Chapter 1 ≥ … ≥ final mission ≥ 100% completion ≥ platinum).

## Local validation

No local grade exists for this competition (scorer and reference stay on the server), so the practice cases were scored locally against answers reconstructed from the rules' published aggregates (players 638 → 3,868, earned 943 → 4,276, every rate but the 100% one lower), under seven scenarios for how the 103 new non-trivial trophy-earns distribute across trophies. That reconstruction reproduces the published house-baseline figures (loss ≈ 1.37–1.52, typical miss ≈ 0.68 points, coverage 0), which validates it.

| | this entry | house persistence baseline |
|---|---|---|
| practice loss (7 scenarios) | 0.108 – 0.198 | 1.37 – 1.52 |
| practice typical miss | 0.00 – 0.08 points | 0.68 points |
| practice 90% coverage | 0.98 | 0 |

On two synthetic final-like cases (2 days of 10-minute reads, 4.5-day horizon; one pure power-law world, one saturating world with slowing player growth and no refresh for 18 h before the target) the entry scores 0.197 and 0.259 against the baseline's 0.246 and 0.287.

## License

MIT — see `LICENSE`.
