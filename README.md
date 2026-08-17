# Riichi Mahjong Game Tree Explorer

This is a TypeScript reimplementation of [麻雀何切るシミュレーター](https://pystyle.info/apps/mahjong-nanikiru-simulator/) based on the source code in https://github.com/nekobean/mahjong-cpp/. See the original repository for references to the algorithm.

The results view has been replaced by a graph allowing for deep exploration of the game tree with the evaluated draws and discards decisions.

## Calculation modes

The **Model** selector picks which expected-score model the calculator evaluates
(`Config.calcMode`):

- **Improved** (`"improved"`, the default) — riichi locks the hand: once declared, every
  non-winning draw is forced tsumogiri and wins are scored on self-loop edges. Draw
  ("chance") and discard ("decision") transitions are kept as separate edge sets, and the
  graph carries the extra per-tile breakdowns the explorer displays.
- **Reference** (`"reference"`) — a faithful port of `ExpectedScoreCalculator` from
  [mahjong-cpp](https://github.com/nekobean/mahjong-cpp/)
  (`src/mahjong/core/expected_score_calculator.cpp`). Riichi only disables tegawari and
  shanten-down, a completed hand emits no discard edges, and each transition is a single
  draw → discard edge read forwards as a draw and backwards as a discard. For the same
  inputs it reproduces the C++ tenpai probability, win probability, and expected score to
  floating-point rounding.

Both modes share everything else: the shanten and scoring engines, the iterative
(non-recursive) graph build, the worker/thread-pool split, and the graph explorer.

Tiles are displayed using the [Japanese Mahjong Font with OpenType](https://github.com/rutopio/Japanese-Mahjong-Font-with-OpenType) under the terms of the SIL Open Font license.

## License

The code in this repository is licensed under the terms of GNU General Public License v3
