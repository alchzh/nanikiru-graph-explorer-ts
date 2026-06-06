import {
  ScoreTitle,
  ShantenFlag,
  THIRTEEN_ORPHANS_TILES,
  Tile,
  WinFlag
} from "./constants.js";
import {
  Count,
  MahjongAnalysisEngine,
  Round,
  Player,
  ScoreResult,
  ScoringEngine,
  ShantenAnalysis,
  TileAnalysis
} from "./model.js";
import { cloneCount } from "./utils.js";

interface RegularState {
  minShanten: number;
}

export class FlatScoreEngine implements ScoringEngine {
  calcFast(_round: Round, player: Player, _winTile: number, winFlag: number, _shantenType: number): ScoreResult {
    const riichi = (winFlag & WinFlag.Riichi) !== 0 ? 1 : 0;
    const redDoraCount = player.hand[Tile.RedManzu5] + player.hand[Tile.RedPinzu5] + player.hand[Tile.RedSouzu5];
    return {
      success: true,
      score: [2000 + riichi * 1000 + redDoraCount * 500],
      scoreTitle: ScoreTitle.Null,
      han: 1 + riichi + redDoraCount,
      fu: 30
    };
  }

  getUpScores(_round: Round, _player: Player, result: ScoreResult, _winFlag: number, n: number): number[] {
    const base = result.score[0] ?? 0;
    return Array.from({ length: n + 1 }, (_, index) => base + index * 600);
  }
}

export class BruteForceMahjongEngine implements MahjongAnalysisEngine {
  readonly scoring?: ScoringEngine;
  readonly uradoraTable?: number[][];
  private readonly shantenMemo = new Map<string, ShantenAnalysis>();

  constructor(options: { scoring?: ScoringEngine; uradoraTable?: number[][] } = {}) {
    this.scoring = options.scoring;
    this.uradoraTable = options.uradoraTable;
  }

  calculateShanten(hand: Count, numMelds: number, type: number): ShantenAnalysis {
    const key = `${hand.slice(0, 34).join(",")}|${numMelds}|${type}`;
    const cached = this.shantenMemo.get(key);
    if (cached) {
      return cached;
    }

    let bestType = ShantenFlag.Null;
    let bestShanten = 100;

    if ((type & ShantenFlag.Regular) !== 0) {
      const shanten = this.calculateRegularShanten(hand, numMelds);
      if (shanten < bestShanten) {
        bestShanten = shanten;
        bestType = ShantenFlag.Regular;
      } else if (shanten === bestShanten) {
        bestType |= ShantenFlag.Regular;
      }
    }

    if ((type & ShantenFlag.SevenPairs) !== 0 && numMelds === 0) {
      const shanten = this.calculateSevenPairsShanten(hand);
      if (shanten < bestShanten) {
        bestShanten = shanten;
        bestType = ShantenFlag.SevenPairs;
      } else if (shanten === bestShanten) {
        bestType |= ShantenFlag.SevenPairs;
      }
    }

    if ((type & ShantenFlag.ThirteenOrphans) !== 0 && numMelds === 0) {
      const shanten = this.calculateThirteenOrphansShanten(hand);
      if (shanten < bestShanten) {
        bestShanten = shanten;
        bestType = ShantenFlag.ThirteenOrphans;
      } else if (shanten === bestShanten) {
        bestType |= ShantenFlag.ThirteenOrphans;
      }
    }

    const result = { shantenType: bestType, shanten: bestShanten };
    this.shantenMemo.set(key, result);
    return result;
  }

  analyzeNecessary(hand: Count, numMelds: number, type: number): TileAnalysis {
    const current = this.calculateShanten(hand, numMelds, type);
    const tiles: number[] = [];
    for (let tile = 0; tile < 34; tile += 1) {
      if (hand[tile] >= 4) {
        continue;
      }
      hand[tile] += 1;
      const next = this.calculateShanten(hand, numMelds, type);
      hand[tile] -= 1;
      if (next.shanten < current.shanten) {
        tiles.push(tile);
      }
    }
    return { ...current, tiles };
  }

  analyzeUnnecessary(hand: Count, numMelds: number, type: number): TileAnalysis {
    const current = this.calculateShanten(hand, numMelds, type);
    const tiles: number[] = [];
    for (let tile = 0; tile < 34; tile += 1) {
      if (hand[tile] <= 0) {
        continue;
      }
      hand[tile] -= 1;
      const next = this.calculateShanten(hand, numMelds, type);
      hand[tile] += 1;
      if (next.shanten === current.shanten) {
        tiles.push(tile);
      }
    }
    return { ...current, tiles };
  }

  private calculateSevenPairsShanten(hand: Count): number {
    let numTypes = 0;
    let numPairs = 0;
    for (let i = 0; i < 34; i += 1) {
      numTypes += hand[i] > 0 ? 1 : 0;
      numPairs += hand[i] >= 2 ? 1 : 0;
    }
    return 6 - numPairs + Math.max(0, 7 - numTypes);
  }

  private calculateThirteenOrphansShanten(hand: Count): number {
    let numTypes = 0;
    let hasPair = false;
    for (const tile of THIRTEEN_ORPHANS_TILES) {
      numTypes += hand[tile] > 0 ? 1 : 0;
      hasPair ||= hand[tile] >= 2;
    }
    return 13 - numTypes - (hasPair ? 1 : 0);
  }

  private calculateRegularShanten(hand: Count, numMelds: number): number {
    const working = cloneCount(hand).slice(0, 34);
    const state: RegularState = { minShanten: 8 };

    const dfs = (index: number, melds: number, pairs: number, taatsu: number): void => {
      while (index < 34 && working[index] === 0) {
        index += 1;
      }

      if (index >= 34) {
        const totalMelds = numMelds + melds;
        const effectiveTaatsu = Math.min(taatsu, 4 - totalMelds);
        const candidate = 8 - totalMelds * 2 - effectiveTaatsu - pairs;
        if (candidate < state.minShanten) {
          state.minShanten = candidate;
        }
        return;
      }

      if (working[index] >= 3) {
        working[index] -= 3;
        dfs(index, melds + 1, pairs, taatsu);
        working[index] += 3;
      }

      if (index < 27 && index % 9 <= 6 && working[index + 1] > 0 && working[index + 2] > 0) {
        working[index] -= 1;
        working[index + 1] -= 1;
        working[index + 2] -= 1;
        dfs(index, melds + 1, pairs, taatsu);
        working[index] += 1;
        working[index + 1] += 1;
        working[index + 2] += 1;
      }

      if (pairs < 1 && working[index] >= 2) {
        working[index] -= 2;
        dfs(index, melds, pairs + 1, taatsu);
        working[index] += 2;
      }

      if (working[index] >= 2) {
        working[index] -= 2;
        dfs(index, melds, pairs, taatsu + 1);
        working[index] += 2;
      }

      if (index < 27 && index % 9 <= 7 && working[index + 1] > 0) {
        working[index] -= 1;
        working[index + 1] -= 1;
        dfs(index, melds, pairs, taatsu + 1);
        working[index] += 1;
        working[index + 1] += 1;
      }

      if (index < 27 && index % 9 <= 6 && working[index + 2] > 0) {
        working[index] -= 1;
        working[index + 2] -= 1;
        dfs(index, melds, pairs, taatsu + 1);
        working[index] += 1;
        working[index + 2] += 1;
      }

      dfs(index + 1, melds, pairs, taatsu);
    };

    dfs(0, 0, 0, 0);
    return state.minShanten;
  }
}
