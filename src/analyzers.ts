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
import {
  ShantenTableRow,
  getShantenLookupTables,
  readDistanceFromRow,
  readDiscardMaskFromRow,
  readTableRow,
  readWaitMaskFromRow
} from "./shantenTableData.js";

const TANYAO_TILES = [
  Tile.Manzu2, Tile.Manzu3, Tile.Manzu4, Tile.Manzu5, Tile.Manzu6, Tile.Manzu7, Tile.Manzu8,
  Tile.Pinzu2, Tile.Pinzu3, Tile.Pinzu4, Tile.Pinzu5, Tile.Pinzu6, Tile.Pinzu7, Tile.Pinzu8,
  Tile.Souzu2, Tile.Souzu3, Tile.Souzu4, Tile.Souzu5, Tile.Souzu6, Tile.Souzu7, Tile.Souzu8
];

interface RegularTableAnalysis {
  shanten: number;
  maskLow: number;
  maskHigh: number;
}

interface MaskTileAnalysis extends ShantenAnalysis {
  maskLow: number;
  maskHigh: number;
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

export class PystyleMahjongEngine implements MahjongAnalysisEngine {
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
    const analysis = this.analyzeNecessaryMasks(hand, numMelds, type);
    return { shantenType: analysis.shantenType, shanten: analysis.shanten, tiles: this.maskToTiles(analysis.maskLow, analysis.maskHigh) };
  }

  analyzeNecessaryMasks(hand: Count, numMelds: number, type: number): MaskTileAnalysis {
    let bestType = ShantenFlag.Null;
    let bestShanten = 100;
    let maskLow = 0;
    let maskHigh = 0;

    if ((type & ShantenFlag.Regular) !== 0) {
      const regular = this.analyzeRegularNecessary(hand, numMelds);
      if (regular.shanten < bestShanten) {
        bestShanten = regular.shanten;
        bestType = ShantenFlag.Regular;
        maskLow = regular.maskLow;
        maskHigh = regular.maskHigh;
      } else if (regular.shanten === bestShanten) {
        bestType |= ShantenFlag.Regular;
        maskLow |= regular.maskLow;
        maskHigh |= regular.maskHigh;
      }
    }

    if ((type & ShantenFlag.SevenPairs) !== 0 && numMelds === 0) {
      const sevenPairs = this.analyzeSevenPairsNecessary(hand);
      if (sevenPairs.shanten < bestShanten) {
        bestShanten = sevenPairs.shanten;
        bestType = ShantenFlag.SevenPairs;
        maskLow = sevenPairs.maskLow;
        maskHigh = sevenPairs.maskHigh;
      } else if (sevenPairs.shanten === bestShanten) {
        bestType |= ShantenFlag.SevenPairs;
        maskLow |= sevenPairs.maskLow;
        maskHigh |= sevenPairs.maskHigh;
      }
    }

    if ((type & ShantenFlag.ThirteenOrphans) !== 0 && numMelds === 0) {
      const thirteenOrphans = this.analyzeThirteenOrphansNecessary(hand);
      if (thirteenOrphans.shanten < bestShanten) {
        bestShanten = thirteenOrphans.shanten;
        bestType = ShantenFlag.ThirteenOrphans;
        maskLow = thirteenOrphans.maskLow;
        maskHigh = thirteenOrphans.maskHigh;
      } else if (thirteenOrphans.shanten === bestShanten) {
        bestType |= ShantenFlag.ThirteenOrphans;
        maskLow |= thirteenOrphans.maskLow;
        maskHigh |= thirteenOrphans.maskHigh;
      }
    }

    return { shantenType: bestType, shanten: bestShanten, maskLow, maskHigh };
  }

  analyzeUnnecessary(hand: Count, numMelds: number, type: number): TileAnalysis {
    const analysis = this.analyzeUnnecessaryMasks(hand, numMelds, type);
    return { shantenType: analysis.shantenType, shanten: analysis.shanten, tiles: this.maskToTiles(analysis.maskLow, analysis.maskHigh) };
  }

  analyzeUnnecessaryMasks(hand: Count, numMelds: number, type: number): MaskTileAnalysis {
    let bestType = ShantenFlag.Null;
    let bestShanten = 100;
    let maskLow = 0;
    let maskHigh = 0;

    if ((type & ShantenFlag.Regular) !== 0) {
      const regular = this.analyzeRegularUnnecessary(hand, numMelds);
      if (regular.shanten < bestShanten) {
        bestShanten = regular.shanten;
        bestType = ShantenFlag.Regular;
        maskLow = regular.maskLow;
        maskHigh = regular.maskHigh;
      } else if (regular.shanten === bestShanten) {
        bestType |= ShantenFlag.Regular;
        maskLow |= regular.maskLow;
        maskHigh |= regular.maskHigh;
      }
    }

    if ((type & ShantenFlag.SevenPairs) !== 0 && numMelds === 0) {
      const sevenPairs = this.analyzeSevenPairsUnnecessary(hand);
      if (sevenPairs.shanten < bestShanten) {
        bestShanten = sevenPairs.shanten;
        bestType = ShantenFlag.SevenPairs;
        maskLow = sevenPairs.maskLow;
        maskHigh = sevenPairs.maskHigh;
      } else if (sevenPairs.shanten === bestShanten) {
        bestType |= ShantenFlag.SevenPairs;
        maskLow |= sevenPairs.maskLow;
        maskHigh |= sevenPairs.maskHigh;
      }
    }

    if ((type & ShantenFlag.ThirteenOrphans) !== 0 && numMelds === 0) {
      const thirteenOrphans = this.analyzeThirteenOrphansUnnecessary(hand);
      if (thirteenOrphans.shanten < bestShanten) {
        bestShanten = thirteenOrphans.shanten;
        bestType = ShantenFlag.ThirteenOrphans;
        maskLow = thirteenOrphans.maskLow;
        maskHigh = thirteenOrphans.maskHigh;
      } else if (thirteenOrphans.shanten === bestShanten) {
        bestType |= ShantenFlag.ThirteenOrphans;
        maskLow |= thirteenOrphans.maskLow;
        maskHigh |= thirteenOrphans.maskHigh;
      }
    }

    return { shantenType: bestType, shanten: bestShanten, maskLow, maskHigh };
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
    const tables = getShantenLookupTables();
    const manzu = readTableRow(tables.suits, this.suitsHash(hand, 0));
    const pinzu = readTableRow(tables.suits, this.suitsHash(hand, 9));
    const souzu = readTableRow(tables.suits, this.suitsHash(hand, 18));
    const honors = readTableRow(tables.honors, this.honorsHash(hand, 27));
    const maxMelds = 4 - numMelds;

    const distances = this.rowToDistances(manzu);
    this.addSuitDistances(distances, pinzu, maxMelds);
    this.addSuitDistances(distances, souzu, maxMelds);
    this.addHonorDistances(distances, honors, maxMelds);

    return distances[5 + maxMelds] - 1;
  }

  private analyzeRegularNecessary(hand: Count, numMelds: number): RegularTableAnalysis {
    return this.analyzeRegularWithTableMask(hand, numMelds, readWaitMaskFromRow);
  }

  private analyzeRegularUnnecessary(hand: Count, numMelds: number): RegularTableAnalysis {
    return this.analyzeRegularWithTableMask(hand, numMelds, readDiscardMaskFromRow);
  }

  private analyzeRegularWithTableMask(
    hand: Count,
    numMelds: number,
    readMask: (row: ShantenTableRow, slot: number) => number
  ): RegularTableAnalysis {
    const tables = getShantenLookupTables();
    const manzu = readTableRow(tables.suits, this.suitsHash(hand, 0));
    const pinzu = readTableRow(tables.suits, this.suitsHash(hand, 9));
    const souzu = readTableRow(tables.suits, this.suitsHash(hand, 18));
    const honors = readTableRow(tables.honors, this.honorsHash(hand, 27));
    const maxMelds = 4 - numMelds;

    const distances = this.rowToDistances(honors);
    const maskLows = this.rowToMaskLows(honors, readMask);
    const maskHighs = Array.from({ length: 10 }, () => 0);
    this.addSuitMaskedAnalysis(distances, maskLows, maskHighs, souzu, readMask, maxMelds);
    this.addSuitMaskedAnalysis(distances, maskLows, maskHighs, pinzu, readMask, maxMelds);
    this.addHonorMaskedAnalysis(distances, maskLows, maskHighs, manzu, readMask, maxMelds);

    return { shanten: distances[5 + maxMelds] - 1, maskLow: maskLows[5 + maxMelds], maskHigh: maskHighs[5 + maxMelds] };
  }

  private analyzeSevenPairsNecessary(hand: Count): RegularTableAnalysis {
    let numPairs = 0;
    let numTypes = 0;
    let count0Low = 0;
    let count0High = 0;
    let count1Low = 0;
    let count1High = 0;

    for (let tile = 0; tile < 34; tile += 1) {
      if (hand[tile] === 0) {
        if (tile < 27) count0Low |= 1 << tile;
        else count0High |= 1 << (tile - 27);
      } else if (hand[tile] === 1) {
        numTypes += 1;
        if (tile < 27) count1Low |= 1 << tile;
        else count1High |= 1 << (tile - 27);
      } else if (hand[tile] >= 2) {
        numPairs += 1;
        numTypes += 1;
      }
    }

    const shanten = 6 - numPairs + Math.max(0, 7 - numTypes);
    if (numTypes < 7) {
      return { shanten, maskLow: count0Low | count1Low, maskHigh: count0High | count1High };
    }
    if (numPairs === 7) {
      return { shanten, maskLow: 0, maskHigh: 0 };
    }
    return { shanten, maskLow: count1Low, maskHigh: count1High };
  }

  private analyzeSevenPairsUnnecessary(hand: Count): RegularTableAnalysis {
    let numPairs = 0;
    let numTypes = 0;
    let count1Low = 0;
    let count1High = 0;
    let countGe3Low = 0;
    let countGe3High = 0;

    for (let tile = 0; tile < 34; tile += 1) {
      if (hand[tile] === 1) {
        numTypes += 1;
        if (tile < 27) count1Low |= 1 << tile;
        else count1High |= 1 << (tile - 27);
      } else if (hand[tile] === 2) {
        numPairs += 1;
        numTypes += 1;
      } else if (hand[tile] >= 3) {
        numPairs += 1;
        numTypes += 1;
        if (tile < 27) countGe3Low |= 1 << tile;
        else countGe3High |= 1 << (tile - 27);
      }
    }

    const shanten = 6 - numPairs + Math.max(0, 7 - numTypes);
    return {
      shanten,
      maskLow: numTypes > 7 ? count1Low | countGe3Low : countGe3Low,
      maskHigh: numTypes > 7 ? count1High | countGe3High : countGe3High
    };
  }

  private analyzeThirteenOrphansNecessary(hand: Count): RegularTableAnalysis {
    let numPairs = 0;
    let numTypes = 0;
    let count0Low = 0;
    let count0High = 0;
    let count1Low = 0;
    let count1High = 0;

    for (const tile of THIRTEEN_ORPHANS_TILES) {
      if (hand[tile] === 0) {
        if (tile < 27) count0Low |= 1 << tile;
        else count0High |= 1 << (tile - 27);
      } else if (hand[tile] === 1) {
        if (tile < 27) count1Low |= 1 << tile;
        else count1High |= 1 << (tile - 27);
        numTypes += 1;
      } else if (hand[tile] >= 2) {
        numTypes += 1;
        numPairs += 1;
      }
    }

    return {
      shanten: 13 - numTypes - (numPairs > 0 ? 1 : 0),
      maskLow: numPairs > 0 ? count0Low : count0Low | count1Low,
      maskHigh: numPairs > 0 ? count0High : count0High | count1High
    };
  }

  private analyzeThirteenOrphansUnnecessary(hand: Count): RegularTableAnalysis {
    let numPairs = 0;
    let numTypes = 0;
    let tanyaoLow = 0;
    let count2Low = 0;
    let count2High = 0;
    let countGt2Low = 0;
    let countGt2High = 0;

    for (const tile of TANYAO_TILES) {
      if (hand[tile] > 0) {
        tanyaoLow |= 1 << tile;
      }
    }

    for (const tile of THIRTEEN_ORPHANS_TILES) {
      if (hand[tile] === 1) {
        numTypes += 1;
      } else if (hand[tile] === 2) {
        if (tile < 27) count2Low |= 1 << tile;
        else count2High |= 1 << (tile - 27);
        numTypes += 1;
        numPairs += 1;
      } else if (hand[tile] > 2) {
        if (tile < 27) countGt2Low |= 1 << tile;
        else countGt2High |= 1 << (tile - 27);
        numTypes += 1;
        numPairs += 1;
      }
    }

    return {
      shanten: 13 - numTypes - (numPairs > 0 ? 1 : 0),
      maskLow: numPairs >= 2 ? tanyaoLow | countGt2Low | count2Low : tanyaoLow | countGt2Low,
      maskHigh: numPairs >= 2 ? countGt2High | count2High : countGt2High
    };
  }

  private suitsHash(hand: Count, offset: number): number {
    let hash = 0;
    for (let i = 0; i < 9; i += 1) {
      hash = hash * 5 + hand[offset + i];
    }
    return hash;
  }

  private honorsHash(hand: Count, offset: number): number {
    let hash = 0;
    for (let i = 0; i < 7; i += 1) {
      hash = hash * 5 + hand[offset + i];
    }
    return hash;
  }

  private rowToDistances(row: ShantenTableRow): number[] {
    return Array.from({ length: 10 }, (_, index) => readDistanceFromRow(row, index));
  }

  private rowToMaskLows(row: ShantenTableRow, readMask: (row: ShantenTableRow, slot: number) => number): number[] {
    return Array.from({ length: 10 }, (_, index) => readMask(row, index));
  }

  private addSuitDistances(lhs: number[], rhs: ShantenTableRow, maxMelds: number): void {
    for (let i = maxMelds + 5; i >= 5; i -= 1) {
      let distance = Math.min(lhs[i] + readDistanceFromRow(rhs, 0), lhs[0] + readDistanceFromRow(rhs, i));
      for (let j = 5; j < i; j += 1) {
        distance = Math.min(distance, lhs[j] + readDistanceFromRow(rhs, i - j));
        distance = Math.min(distance, lhs[i - j] + readDistanceFromRow(rhs, j));
      }
      lhs[i] = distance;
    }

    for (let i = maxMelds; i >= 0; i -= 1) {
      let distance = lhs[i] + readDistanceFromRow(rhs, 0);
      for (let j = 0; j < i; j += 1) {
        distance = Math.min(distance, lhs[j] + readDistanceFromRow(rhs, i - j));
      }
      lhs[i] = distance;
    }
  }

  private addHonorDistances(lhs: number[], rhs: ShantenTableRow, maxMelds: number): void {
    const i = maxMelds + 5;
    let distance = Math.min(lhs[i] + readDistanceFromRow(rhs, 0), lhs[0] + readDistanceFromRow(rhs, i));
    for (let j = 5; j < i; j += 1) {
      distance = Math.min(distance, lhs[j] + readDistanceFromRow(rhs, i - j));
      distance = Math.min(distance, lhs[i - j] + readDistanceFromRow(rhs, j));
    }
    lhs[i] = distance;
  }

  private addSuitMaskedAnalysis(
    distances: number[],
    maskLows: number[],
    maskHighs: number[],
    rhs: ShantenTableRow,
    readMask: (row: ShantenTableRow, slot: number) => number,
    maxMelds: number
  ): void {
    for (let i = maxMelds + 5; i >= 5; i -= 1) {
      let distance = distances[i] + readDistanceFromRow(rhs, 0);
      let low = this.shiftLowBySuit(maskLows[i]) | readMask(rhs, 0);
      let high = this.shiftHighBySuit(maskLows[i], maskHighs[i]);
      let candidateDistance = distances[0] + readDistanceFromRow(rhs, i);
      let candidateLow = this.shiftLowBySuit(maskLows[0]) | readMask(rhs, i);
      let candidateHigh = this.shiftHighBySuit(maskLows[0], maskHighs[0]);
      if (distance === candidateDistance) {
        low |= candidateLow;
        high |= candidateHigh;
      } else if (distance > candidateDistance) {
        distance = candidateDistance;
        low = candidateLow;
        high = candidateHigh;
      }

      for (let j = 5; j < i; j += 1) {
        candidateDistance = distances[j] + readDistanceFromRow(rhs, i - j);
        candidateLow = this.shiftLowBySuit(maskLows[j]) | readMask(rhs, i - j);
        candidateHigh = this.shiftHighBySuit(maskLows[j], maskHighs[j]);
        if (distance === candidateDistance) {
          low |= candidateLow;
          high |= candidateHigh;
        } else if (distance > candidateDistance) {
          distance = candidateDistance;
          low = candidateLow;
          high = candidateHigh;
        }

        candidateDistance = distances[i - j] + readDistanceFromRow(rhs, j);
        candidateLow = this.shiftLowBySuit(maskLows[i - j]) | readMask(rhs, j);
        candidateHigh = this.shiftHighBySuit(maskLows[i - j], maskHighs[i - j]);
        if (distance === candidateDistance) {
          low |= candidateLow;
          high |= candidateHigh;
        } else if (distance > candidateDistance) {
          distance = candidateDistance;
          low = candidateLow;
          high = candidateHigh;
        }
      }

      distances[i] = distance;
      maskLows[i] = low;
      maskHighs[i] = high;
    }

    for (let i = maxMelds; i >= 0; i -= 1) {
      let distance = distances[i] + readDistanceFromRow(rhs, 0);
      let low = this.shiftLowBySuit(maskLows[i]) | readMask(rhs, 0);
      let high = this.shiftHighBySuit(maskLows[i], maskHighs[i]);

      for (let j = 0; j < i; j += 1) {
        const candidateDistance = distances[j] + readDistanceFromRow(rhs, i - j);
        const candidateLow = this.shiftLowBySuit(maskLows[j]) | readMask(rhs, i - j);
        const candidateHigh = this.shiftHighBySuit(maskLows[j], maskHighs[j]);
        if (distance === candidateDistance) {
          low |= candidateLow;
          high |= candidateHigh;
        } else if (distance > candidateDistance) {
          distance = candidateDistance;
          low = candidateLow;
          high = candidateHigh;
        }
      }

      distances[i] = distance;
      maskLows[i] = low;
      maskHighs[i] = high;
    }
  }

  private addHonorMaskedAnalysis(
    distances: number[],
    maskLows: number[],
    maskHighs: number[],
    rhs: ShantenTableRow,
    readMask: (row: ShantenTableRow, slot: number) => number,
    maxMelds: number
  ): void {
    const i = maxMelds + 5;
    let distance = distances[i] + readDistanceFromRow(rhs, 0);
    let low = this.shiftLowBySuit(maskLows[i]) | readMask(rhs, 0);
    let high = this.shiftHighBySuit(maskLows[i], maskHighs[i]);
    let candidateDistance = distances[0] + readDistanceFromRow(rhs, i);
    let candidateLow = this.shiftLowBySuit(maskLows[0]) | readMask(rhs, i);
    let candidateHigh = this.shiftHighBySuit(maskLows[0], maskHighs[0]);
    if (distance === candidateDistance) {
      low |= candidateLow;
      high |= candidateHigh;
    } else if (distance > candidateDistance) {
      distance = candidateDistance;
      low = candidateLow;
      high = candidateHigh;
    }

    for (let j = 5; j < i; j += 1) {
      candidateDistance = distances[j] + readDistanceFromRow(rhs, i - j);
      candidateLow = this.shiftLowBySuit(maskLows[j]) | readMask(rhs, i - j);
      candidateHigh = this.shiftHighBySuit(maskLows[j], maskHighs[j]);
      if (distance === candidateDistance) {
        low |= candidateLow;
        high |= candidateHigh;
      } else if (distance > candidateDistance) {
        distance = candidateDistance;
        low = candidateLow;
        high = candidateHigh;
      }

      candidateDistance = distances[i - j] + readDistanceFromRow(rhs, j);
      candidateLow = this.shiftLowBySuit(maskLows[i - j]) | readMask(rhs, j);
      candidateHigh = this.shiftHighBySuit(maskLows[i - j], maskHighs[i - j]);
      if (distance === candidateDistance) {
        low |= candidateLow;
        high |= candidateHigh;
      } else if (distance > candidateDistance) {
        distance = candidateDistance;
        low = candidateLow;
        high = candidateHigh;
      }
    }

    distances[i] = distance;
    maskLows[i] = low;
    maskHighs[i] = high;
  }

  private shiftLowBySuit(low: number): number {
    return (low & 0x3ffff) * 512;
  }

  private shiftHighBySuit(low: number, high: number): number {
    return high * 512 + Math.floor(low / 0x40000);
  }

  private maskToTiles(maskLow: number, maskHigh: number): number[] {
    const tiles: number[] = [];
    for (let tile = 0; tile < 27; tile += 1) {
      if ((maskLow & (1 << tile)) !== 0) {
        tiles.push(tile);
      }
    }
    for (let tile = 27; tile < 34; tile += 1) {
      if ((maskHigh & (1 << (tile - 27))) !== 0) {
        tiles.push(tile);
      }
    }
    return tiles;
  }
}
