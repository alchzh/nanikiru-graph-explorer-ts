import {
  BlockType,
  RuleFlag,
  ScoreTitle,
  ShantenFlag,
  Tile,
  TO_DORA,
  WaitType,
  WinFlag
} from "./constants.js";
import { Block, Count, Player, Round, ScoreResult, ScoringEngine } from "./model.js";
import { isClosed, isHonor, isReddora, isTerminalOrHonor, toNoReddora } from "./utils.js";

type Yaku = bigint;

const YAKU = {
  Null: 0n,
  Tsumo: 1n << 0n,
  Riichi: 1n << 1n,
  Ippatsu: 1n << 2n,
  Tanyao: 1n << 3n,
  Pinfu: 1n << 4n,
  PureDoubleSequence: 1n << 5n,
  RobbingAKong: 1n << 6n,
  AfterAKong: 1n << 7n,
  UnderTheSea: 1n << 8n,
  UnderTheRiver: 1n << 9n,
  Dora: 1n << 10n,
  UraDora: 1n << 11n,
  RedDora: 1n << 12n,
  WhiteDragon: 1n << 13n,
  GreenDragon: 1n << 14n,
  RedDragon: 1n << 15n,
  SelfWindEast: 1n << 16n,
  SelfWindSouth: 1n << 17n,
  SelfWindWest: 1n << 18n,
  SelfWindNorth: 1n << 19n,
  RoundWindEast: 1n << 20n,
  RoundWindSouth: 1n << 21n,
  RoundWindWest: 1n << 22n,
  RoundWindNorth: 1n << 23n,
  DoubleRiichi: 1n << 24n,
  SevenPairs: 1n << 25n,
  AllTriplets: 1n << 26n,
  ThreeConcealedTriplets: 1n << 27n,
  TripleTriplets: 1n << 28n,
  MixedTripleSequence: 1n << 29n,
  AllTerminalsAndHonors: 1n << 30n,
  PureStraight: 1n << 31n,
  HalfOutsideHand: 1n << 32n,
  LittleThreeDragons: 1n << 33n,
  ThreeKongs: 1n << 34n,
  HalfFlush: 1n << 35n,
  FullyOutsideHand: 1n << 36n,
  TwicePureDoubleSequence: 1n << 37n,
  NagashiMangan: 1n << 38n,
  FullFlush: 1n << 39n,
  BlessingOfHeaven: 1n << 40n,
  BlessingOfEarth: 1n << 41n,
  HandOfMan: 1n << 42n,
  AllGreen: 1n << 43n,
  BigThreeDragons: 1n << 44n,
  LittleFourWinds: 1n << 45n,
  AllHonors: 1n << 46n,
  ThirteenOrphans: 1n << 47n,
  NineGates: 1n << 48n,
  FourConcealedTriplets: 1n << 49n,
  AllTerminals: 1n << 50n,
  FourKongs: 1n << 51n,
  SingleWaitFourConcealedTriplets: 1n << 52n,
  BigFourWinds: 1n << 53n,
  TrueNineGates: 1n << 54n,
  ThirteenWaitThirteenOrphans: 1n << 55n
} as const;

const YAKU_ORDER: Yaku[] = [
  YAKU.Tsumo, YAKU.Riichi, YAKU.Ippatsu, YAKU.Tanyao, YAKU.Pinfu,
  YAKU.PureDoubleSequence, YAKU.RobbingAKong, YAKU.AfterAKong, YAKU.UnderTheSea,
  YAKU.UnderTheRiver, YAKU.Dora, YAKU.UraDora, YAKU.RedDora, YAKU.WhiteDragon,
  YAKU.GreenDragon, YAKU.RedDragon, YAKU.SelfWindEast, YAKU.SelfWindSouth,
  YAKU.SelfWindWest, YAKU.SelfWindNorth, YAKU.RoundWindEast, YAKU.RoundWindSouth,
  YAKU.RoundWindWest, YAKU.RoundWindNorth, YAKU.DoubleRiichi, YAKU.SevenPairs,
  YAKU.AllTriplets, YAKU.ThreeConcealedTriplets, YAKU.TripleTriplets,
  YAKU.MixedTripleSequence, YAKU.AllTerminalsAndHonors, YAKU.PureStraight,
  YAKU.HalfOutsideHand, YAKU.LittleThreeDragons, YAKU.ThreeKongs, YAKU.HalfFlush,
  YAKU.FullyOutsideHand, YAKU.TwicePureDoubleSequence, YAKU.NagashiMangan,
  YAKU.FullFlush, YAKU.BlessingOfHeaven, YAKU.BlessingOfEarth, YAKU.HandOfMan,
  YAKU.AllGreen, YAKU.BigThreeDragons, YAKU.LittleFourWinds, YAKU.AllHonors,
  YAKU.ThirteenOrphans, YAKU.NineGates, YAKU.FourConcealedTriplets, YAKU.AllTerminals,
  YAKU.FourKongs, YAKU.SingleWaitFourConcealedTriplets, YAKU.BigFourWinds,
  YAKU.TrueNineGates, YAKU.ThirteenWaitThirteenOrphans
];

const YAKU_HAN = new Map<Yaku, [number, number]>([
  [YAKU.Null, [0, 0]],
  [YAKU.Tsumo, [1, 0]],
  [YAKU.Riichi, [1, 0]],
  [YAKU.Ippatsu, [1, 0]],
  [YAKU.Tanyao, [1, 1]],
  [YAKU.Pinfu, [1, 0]],
  [YAKU.PureDoubleSequence, [1, 0]],
  [YAKU.RobbingAKong, [1, 1]],
  [YAKU.AfterAKong, [1, 1]],
  [YAKU.UnderTheSea, [1, 1]],
  [YAKU.UnderTheRiver, [1, 1]],
  [YAKU.Dora, [0, 0]],
  [YAKU.UraDora, [0, 0]],
  [YAKU.RedDora, [0, 0]],
  [YAKU.WhiteDragon, [1, 1]],
  [YAKU.GreenDragon, [1, 1]],
  [YAKU.RedDragon, [1, 1]],
  [YAKU.SelfWindEast, [1, 1]],
  [YAKU.SelfWindSouth, [1, 1]],
  [YAKU.SelfWindWest, [1, 1]],
  [YAKU.SelfWindNorth, [1, 1]],
  [YAKU.RoundWindEast, [1, 1]],
  [YAKU.RoundWindSouth, [1, 1]],
  [YAKU.RoundWindWest, [1, 1]],
  [YAKU.RoundWindNorth, [1, 1]],
  [YAKU.DoubleRiichi, [2, 0]],
  [YAKU.SevenPairs, [2, 0]],
  [YAKU.AllTriplets, [2, 2]],
  [YAKU.ThreeConcealedTriplets, [2, 2]],
  [YAKU.TripleTriplets, [2, 2]],
  [YAKU.MixedTripleSequence, [2, 1]],
  [YAKU.AllTerminalsAndHonors, [2, 2]],
  [YAKU.PureStraight, [2, 1]],
  [YAKU.HalfOutsideHand, [2, 1]],
  [YAKU.LittleThreeDragons, [2, 2]],
  [YAKU.ThreeKongs, [2, 2]],
  [YAKU.HalfFlush, [3, 2]],
  [YAKU.FullyOutsideHand, [3, 2]],
  [YAKU.TwicePureDoubleSequence, [3, 0]],
  [YAKU.NagashiMangan, [0, 0]],
  [YAKU.FullFlush, [6, 5]],
  [YAKU.BlessingOfHeaven, [1, 0]],
  [YAKU.BlessingOfEarth, [1, 0]],
  [YAKU.HandOfMan, [1, 0]],
  [YAKU.AllGreen, [1, 0]],
  [YAKU.BigThreeDragons, [1, 0]],
  [YAKU.LittleFourWinds, [1, 0]],
  [YAKU.AllHonors, [1, 0]],
  [YAKU.ThirteenOrphans, [1, 0]],
  [YAKU.NineGates, [1, 0]],
  [YAKU.FourConcealedTriplets, [1, 0]],
  [YAKU.AllTerminals, [1, 0]],
  [YAKU.FourKongs, [1, 0]],
  [YAKU.SingleWaitFourConcealedTriplets, [2, 0]],
  [YAKU.BigFourWinds, [2, 0]],
  [YAKU.TrueNineGates, [2, 0]],
  [YAKU.ThirteenWaitThirteenOrphans, [2, 0]]
]);

const NORMAL_YAKU =
  YAKU.Tsumo | YAKU.Riichi | YAKU.Ippatsu | YAKU.Tanyao | YAKU.Pinfu |
  YAKU.PureDoubleSequence | YAKU.RobbingAKong | YAKU.AfterAKong |
  YAKU.UnderTheSea | YAKU.UnderTheRiver | YAKU.Dora | YAKU.UraDora |
  YAKU.RedDora | YAKU.WhiteDragon | YAKU.GreenDragon | YAKU.RedDragon |
  YAKU.SelfWindEast | YAKU.SelfWindSouth | YAKU.SelfWindWest | YAKU.SelfWindNorth |
  YAKU.RoundWindEast | YAKU.RoundWindSouth | YAKU.RoundWindWest | YAKU.RoundWindNorth |
  YAKU.DoubleRiichi | YAKU.SevenPairs | YAKU.AllTriplets | YAKU.ThreeConcealedTriplets |
  YAKU.TripleTriplets | YAKU.MixedTripleSequence | YAKU.AllTerminalsAndHonors |
  YAKU.PureStraight | YAKU.HalfOutsideHand | YAKU.LittleThreeDragons |
  YAKU.ThreeKongs | YAKU.HalfFlush | YAKU.FullyOutsideHand |
  YAKU.TwicePureDoubleSequence | YAKU.FullFlush;

const YAKUMAN =
  YAKU.BlessingOfHeaven | YAKU.BlessingOfEarth | YAKU.HandOfMan | YAKU.AllGreen |
  YAKU.BigThreeDragons | YAKU.LittleFourWinds | YAKU.AllHonors |
  YAKU.ThirteenOrphans | YAKU.NineGates | YAKU.FourConcealedTriplets |
  YAKU.AllTerminals | YAKU.FourKongs | YAKU.SingleWaitFourConcealedTriplets |
  YAKU.BigFourWinds | YAKU.TrueNineGates | YAKU.ThirteenWaitThirteenOrphans;

const IS_MANGAN: boolean[][] = [
  [false, false, false, false],
  [false, false, false, false],
  [false, false, false, false],
  [false, false, false, true],
  [false, false, false, true],
  [false, false, false, true],
  [false, false, true, true],
  [false, false, true, true],
  [false, false, true, true],
  [false, false, true, true],
  [false, false, true, true]
];

const BELOW_MANGAN: number[][][] = [
  [
    [0, 0, 0, 0], [0, 2400, 4800, 9600], [1500, 2900, 5800, 11600], [2000, 3900, 7700, 0],
    [2400, 4800, 9600, 0], [2900, 5800, 11600, 0], [3400, 6800, 0, 0], [3900, 7700, 0, 0],
    [4400, 8700, 0, 0], [4800, 9600, 0, 0], [5300, 10600, 0, 0]
  ],
  [
    [0, 0, 0, 0], [0, 1600, 3200, 6400], [1000, 2000, 3900, 7700], [1300, 2600, 5200, 0],
    [1600, 3200, 6400, 0], [2000, 3900, 7700, 0], [2300, 4500, 0, 0], [2600, 5200, 0, 0],
    [2900, 5800, 0, 0], [3200, 6400, 0, 0], [3600, 7100, 0, 0]
  ],
  [
    [0, 700, 1300, 2600], [0, 0, 1600, 3200], [500, 1000, 2000, 3900], [700, 1300, 2600, 0],
    [800, 1600, 3200, 0], [1000, 2000, 3900, 0], [1200, 2300, 0, 0], [1300, 2600, 0, 0],
    [1500, 2900, 0, 0], [1600, 3200, 0, 0], [1800, 3600, 0, 0]
  ],
  [
    [0, 700, 1300, 2600], [0, 0, 1600, 3200], [500, 1000, 2000, 3900], [700, 1300, 2600, 0],
    [800, 1600, 3200, 0], [1000, 2000, 3900, 0], [1200, 2300, 0, 0], [1300, 2600, 0, 0],
    [1500, 2900, 0, 0], [1600, 3200, 0, 0], [1800, 3600, 0, 0]
  ],
  [
    [0, 400, 700, 1300], [0, 0, 800, 1600], [300, 500, 1000, 2000], [400, 700, 1300, 0],
    [400, 800, 1600, 0], [500, 1000, 2000, 0], [600, 1200, 0, 0], [700, 1300, 0, 0],
    [800, 1500, 0, 0], [800, 1600, 0, 0], [900, 1800, 0, 0]
  ]
];

const ABOVE_MANGAN: number[][] = [
  [12000, 18000, 24000, 36000, 48000, 48000, 96000, 144000, 192000, 240000, 288000],
  [8000, 12000, 16000, 24000, 32000, 32000, 64000, 96000, 128000, 160000, 192000],
  [4000, 6000, 8000, 12000, 16000, 16000, 32000, 48000, 64000, 80000, 96000],
  [4000, 6000, 8000, 12000, 16000, 16000, 32000, 48000, 64000, 80000, 96000],
  [2000, 3000, 4000, 6000, 8000, 8000, 16000, 24000, 32000, 40000, 48000]
];

const TILE1: number[] = [
  1 << 24, 1 << 21, 1 << 18, 1 << 15, 1 << 12, 1 << 9, 1 << 6, 1 << 3, 1,
  1 << 24, 1 << 21, 1 << 18, 1 << 15, 1 << 12, 1 << 9, 1 << 6, 1 << 3, 1,
  1 << 24, 1 << 21, 1 << 18, 1 << 15, 1 << 12, 1 << 9, 1 << 6, 1 << 3, 1,
  1 << 18, 1 << 15, 1 << 12, 1 << 9, 1 << 6, 1 << 3, 1
];

type MergedHand = [Count, number, number, number, number];
type Pattern = { blocks: Block[]; waitType: number };

interface ShantenLike {
  calculateShanten(hand: Count, numMelds: number, type: number): { shantenType: number; shanten: number };
}

export class TypeScriptScoreEngine implements ScoringEngine {
  constructor(private readonly shantenEngine: ShantenLike) {}

  calcFast(round: Round, player: Player, winTile: number, winFlag: number, shantenType: number): ScoreResult {
    const notPatternYaku = this.checkNotPatternYaku(round, player, winTile, winFlag, shantenType);

    if ((notPatternYaku & YAKU.NagashiMangan) !== 0n) {
      return this.aggregateYakumanLike(round, player, winTile, winFlag, YAKU.NagashiMangan);
    }
    if ((notPatternYaku & YAKUMAN) !== 0n) {
      return this.aggregateYakumanLike(round, player, winTile, winFlag, notPatternYaku & YAKUMAN);
    }

    const patternResult = this.checkPatternYaku(round, player, winTile, winFlag, shantenType);
    const yaku = notPatternYaku | patternResult.yaku;
    if (yaku === 0n) {
      return { success: false, score: [0], scoreTitle: ScoreTitle.Null, han: 0, fu: 0, errMsg: "No yaku is established." };
    }

    return this.aggregateNormal(round, player, winTile, winFlag, yaku, patternResult.fu, patternResult.blocks, patternResult.waitType);
  }

  getUpScores(round: Round, player: Player, result: ScoreResult, winFlag: number, n: number): number[] {
    if (!result.success) {
      return [];
    }
    if (result.scoreTitle >= ScoreTitle.CountedYakuman) {
      return [result.score[0] ?? 0];
    }
    const scores: number[] = [];
    for (let i = 0; i <= n; i += 1) {
      const han = result.han + i;
      const scoreTitle = this.getScoreTitle(result.fu, han);
      scores.push(this.calcPointScore(player.wind === Tile.East, (winFlag & WinFlag.Tsumo) !== 0, round.honba, round.kyotaku, scoreTitle, han, result.fu)[0]);
    }
    return scores;
  }

  calc(round: Round, player: Player, winTile: number, winFlag: number): ScoreResult {
    const check = this.checkArguments(player, winTile, winFlag);
    if (check) {
      return { success: false, score: [0], scoreTitle: ScoreTitle.Null, han: 0, fu: 0, errMsg: check };
    }
    const shanten = this.shantenEngine.calculateShanten(player.hand, player.melds.length, ShantenFlag.All);
    if (shanten.shanten !== -1) {
      return { success: false, score: [0], scoreTitle: ScoreTitle.Null, han: 0, fu: 0, errMsg: "The hand is not winning form." };
    }
    return this.calcFast(round, player, winTile, winFlag, shanten.shantenType);
  }

  private checkArguments(player: Player, winTile: number, winFlag: number): string | undefined {
    if (!player.hand[toNoReddora(winTile)]) {
      return "Win tile is not contained in the hand.";
    }
    if (!this.checkExclusive(winFlag & (WinFlag.Riichi | WinFlag.DoubleRiichi))) {
      return "Only one of Riichi and Double Riichi may be specified.";
    }
    if (!this.checkExclusive(winFlag & (WinFlag.RobbingAKong | WinFlag.AfterAKong | WinFlag.UnderTheSea | WinFlag.UnderTheRiver))) {
      return "Only one of RobbingAKong, AfterAKong, UnderTheSea, or UnderTheRiver may be specified.";
    }
    if (!this.checkExclusive(winFlag & (WinFlag.BlessingOfHeaven | WinFlag.BlessingOfEarth | WinFlag.HandOfMan))) {
      return "Only one of BlessingOfHeaven, BlessingOfEarth, or HandOfMan may be specified.";
    }
    if ((winFlag & (WinFlag.Riichi | WinFlag.DoubleRiichi)) !== 0 && !isClosed(player)) {
      return "Riichi and Double Riichi require a closed hand.";
    }
    if ((winFlag & WinFlag.Ippatsu) !== 0 && (winFlag & (WinFlag.Riichi | WinFlag.DoubleRiichi)) === 0) {
      return "Ippatsu requires riichi.";
    }
    if ((winFlag & (WinFlag.UnderTheSea | WinFlag.AfterAKong)) !== 0 && (winFlag & WinFlag.Tsumo) === 0) {
      return "UnderTheSea and AfterAKong require tsumo.";
    }
    return undefined;
  }

  private aggregateYakumanLike(round: Round, player: Player, winTile: number, winFlag: number, yaku: Yaku): ScoreResult {
    const yakuList: Array<[bigint, number]> = [];
    let scoreTitle = ScoreTitle.Mangan;
    let score: number[] = [];

    if ((yaku & YAKU.NagashiMangan) !== 0n) {
      yakuList.push([YAKU.NagashiMangan, 0]);
      score = this.calcPointScore(player.wind === Tile.East, true, round.honba, round.kyotaku, ScoreTitle.Mangan);
    } else {
      let n = 0;
      for (const bit of YAKU_ORDER) {
        if ((bit & YAKUMAN) !== 0n && (yaku & bit) !== 0n) {
          const han = YAKU_HAN.get(bit)![0];
          n += han;
          yakuList.push([bit, han]);
        }
      }
      scoreTitle = this.getYakumanScoreTitle(n);
      score = this.calcPointScore(player.wind === Tile.East, (winFlag & WinFlag.Tsumo) !== 0, round.honba, round.kyotaku, scoreTitle);
    }

    return { success: true, score, scoreTitle, han: 0, fu: 0, yakuList };
  }

  private aggregateNormal(round: Round, player: Player, winTile: number, winFlag: number, yaku: Yaku, fu: number, blocks: Block[], waitType: number): ScoreResult {
    let han = 0;
    const yakuList: Array<[bigint, number]> = [];
    for (const bit of YAKU_ORDER) {
      if ((bit & NORMAL_YAKU) !== 0n && (yaku & bit) !== 0n) {
        const [closedHan, openHan] = YAKU_HAN.get(bit)!;
        const yakuHan = isClosed(player) ? closedHan : openHan;
        yakuList.push([bit, yakuHan]);
        han += yakuHan;
      }
    }

    const numDora = this.countDora(player.hand, player.melds, round.doraIndicators);
    if (numDora > 0) {
      yakuList.push([YAKU.Dora, numDora]);
      han += numDora;
    }
    const numUradora = this.countDora(player.hand, player.melds, round.uradoraIndicators);
    if (numUradora > 0) {
      yakuList.push([YAKU.UraDora, numUradora]);
      han += numUradora;
    }
    const numReddora = this.countReddora((round.rules & RuleFlag.RedDora) !== 0, player.hand, player.melds);
    if (numReddora > 0) {
      yakuList.push([YAKU.RedDora, numReddora]);
      han += numReddora;
    }

    const scoreTitle = this.getScoreTitle(fu, han);
    const score = this.calcPointScore(player.wind === Tile.East, (winFlag & WinFlag.Tsumo) !== 0, round.honba, round.kyotaku, scoreTitle, han, fu);
    yakuList.sort((left, right) => Number(left[0] - right[0]));

    return { success: true, score, scoreTitle, han, fu, yakuList, blocks, waitType };
  }

  private countDora(hand: Count, melds: Player["melds"], indicators: number[]): number {
    let count = 0;
    for (const indicator of indicators) {
      const dora = TO_DORA[indicator];
      count += hand[dora];
      for (const meld of melds) {
        for (const tile of meld.tiles) {
          count += toNoReddora(tile) === dora ? 1 : 0;
        }
      }
    }
    return count;
  }

  private countReddora(enabled: boolean, hand: Count, melds: Player["melds"]): number {
    if (!enabled) {
      return 0;
    }
    let count = hand[Tile.RedManzu5] + hand[Tile.RedPinzu5] + hand[Tile.RedSouzu5];
    for (const meld of melds) {
      for (const tile of meld.tiles) {
        if (isReddora(tile)) {
          count += 1;
          break;
        }
      }
    }
    return count;
  }

  private getScoreTitle(fu: number, han: number): number {
    const fuIdx = this.fuToIndex(fu);
    const hanIdx = han - 1;
    if (han < 5) {
      return IS_MANGAN[fuIdx][hanIdx] ? ScoreTitle.Mangan : ScoreTitle.Null;
    }
    if (han === 5) return ScoreTitle.Mangan;
    if (han <= 7) return ScoreTitle.Haneman;
    if (han <= 10) return ScoreTitle.Baiman;
    if (han <= 12) return ScoreTitle.Sanbaiman;
    return ScoreTitle.CountedYakuman;
  }

  private getYakumanScoreTitle(n: number): number {
    if (n === 1) return ScoreTitle.Yakuman;
    if (n === 2) return ScoreTitle.DoubleYakuman;
    if (n === 3) return ScoreTitle.TripleYakuman;
    if (n === 4) return ScoreTitle.QuadrupleYakuman;
    if (n === 5) return ScoreTitle.QuintupleYakuman;
    if (n === 6) return ScoreTitle.SextupleYakuman;
    return ScoreTitle.Null;
  }

  private calcPointScore(isDealer: boolean, isTsumo: boolean, honba: number, kyotaku: number, scoreTitle: number, han = 0, fu = 0): number[] {
    const fuIdx = this.fuToIndex(fu);
    const hanIdx = han - 1;
    if (isTsumo && isDealer) {
      const playerPayment = (scoreTitle === ScoreTitle.Null ? BELOW_MANGAN[2][fuIdx][hanIdx] : ABOVE_MANGAN[2][scoreTitle]) + 100 * honba;
      return [1000 * kyotaku + playerPayment * 3, playerPayment];
    }
    if (isTsumo && !isDealer) {
      const dealerPayment = (scoreTitle === ScoreTitle.Null ? BELOW_MANGAN[3][fuIdx][hanIdx] : ABOVE_MANGAN[3][scoreTitle]) + 100 * honba;
      const playerPayment = (scoreTitle === ScoreTitle.Null ? BELOW_MANGAN[4][fuIdx][hanIdx] : ABOVE_MANGAN[4][scoreTitle]) + 100 * honba;
      return [1000 * kyotaku + dealerPayment + playerPayment * 2, dealerPayment, playerPayment];
    }
    if (!isTsumo && isDealer) {
      const payment = (scoreTitle === ScoreTitle.Null ? BELOW_MANGAN[0][fuIdx][hanIdx] : ABOVE_MANGAN[0][scoreTitle]) + 300 * honba;
      return [1000 * kyotaku + payment, payment];
    }
    const payment = (scoreTitle === ScoreTitle.Null ? BELOW_MANGAN[1][fuIdx][hanIdx] : ABOVE_MANGAN[1][scoreTitle]) + 300 * honba;
    return [1000 * kyotaku + payment, payment];
  }

  private checkNotPatternYaku(round: Round, player: Player, winTile: number, winFlag: number, shantenType: number): Yaku {
    let yaku = YAKU.Null;
    yaku |= (winFlag & WinFlag.Tsumo) !== 0 && isClosed(player) ? YAKU.Tsumo : YAKU.Null;
    yaku |= (winFlag & WinFlag.Riichi) !== 0 ? YAKU.Riichi : YAKU.Null;
    yaku |= (winFlag & WinFlag.Ippatsu) !== 0 ? YAKU.Ippatsu : YAKU.Null;
    yaku |= (winFlag & WinFlag.RobbingAKong) !== 0 ? YAKU.RobbingAKong : YAKU.Null;
    yaku |= (winFlag & WinFlag.AfterAKong) !== 0 ? YAKU.AfterAKong : YAKU.Null;
    yaku |= (winFlag & WinFlag.UnderTheSea) !== 0 ? YAKU.UnderTheSea : YAKU.Null;
    yaku |= (winFlag & WinFlag.UnderTheRiver) !== 0 ? YAKU.UnderTheRiver : YAKU.Null;
    yaku |= (winFlag & WinFlag.DoubleRiichi) !== 0 ? YAKU.DoubleRiichi : YAKU.Null;
    yaku |= (winFlag & WinFlag.NagashiMangan) !== 0 ? YAKU.NagashiMangan : YAKU.Null;
    yaku |= (winFlag & WinFlag.BlessingOfHeaven) !== 0 ? YAKU.BlessingOfHeaven : YAKU.Null;
    yaku |= (winFlag & WinFlag.BlessingOfEarth) !== 0 ? YAKU.BlessingOfEarth : YAKU.Null;
    yaku |= (winFlag & WinFlag.HandOfMan) !== 0 ? YAKU.HandOfMan : YAKU.Null;

    const merged = this.mergeHand(player);
    const noRedWinTile = toNoReddora(winTile);
    if ((shantenType & ShantenFlag.Regular) !== 0) {
      yaku |= this.checkAllGreen(merged);
      yaku |= this.checkThreeDragons(merged);
      yaku |= this.checkFourWinds(merged);
      yaku |= this.checkAllHonors(merged);
      yaku |= this.checkFourConcealedTriplets(player, merged, noRedWinTile, winFlag);
      yaku |= this.checkAllTerminals(merged);
      yaku |= this.checkKongs(player);
      yaku |= this.checkNineGates(player, merged, noRedWinTile);
      yaku |= this.checkTanyao(player, merged, (round.rules & RuleFlag.OpenTanyao) !== 0);
      yaku |= this.checkFlush(merged);
      yaku |= this.checkValueTile(round, player, merged);
    } else if ((shantenType & ShantenFlag.SevenPairs) !== 0) {
      yaku |= YAKU.SevenPairs;
      yaku |= this.checkAllHonors(merged);
      yaku |= this.checkAllTerminals(merged);
      yaku |= this.checkTanyao(player, merged, (round.rules & RuleFlag.OpenTanyao) !== 0);
      yaku |= this.checkFlush(merged);
    } else {
      yaku |= this.checkThirteenWaitThirteenOrphans(merged, noRedWinTile) ? YAKU.ThirteenWaitThirteenOrphans : YAKU.ThirteenOrphans;
    }
    return yaku;
  }

  private checkPatternYaku(round: Round, player: Player, winTile: number, winFlag: number, shantenType: number): { yaku: Yaku; fu: number; blocks: Block[]; waitType: number } {
    if (shantenType === ShantenFlag.SevenPairs) {
      return { yaku: YAKU.Null, fu: 25, blocks: [], waitType: WaitType.PairWait };
    }

    const patterns = this.separateHand(player, winTile, winFlag);
    let best: { han: number; fu: number; idx: number; yaku: Yaku } = { han: -1, fu: -1, idx: 0, yaku: YAKU.Null };
    for (let i = 0; i < patterns.length; i += 1) {
      const { blocks, waitType } = patterns[i];
      let yaku = YAKU.Null;
      const isPinfu = this.checkPinfu(blocks, waitType, round.wind, player.wind);
      if (isClosed(player)) {
        if (isPinfu) yaku |= YAKU.Pinfu;
        yaku |= this.checkPureDoubleSequence(blocks);
      }
      if (this.checkPureStraight(blocks)) yaku |= YAKU.PureStraight;
      else if (this.checkTripleTriplets(blocks)) yaku |= YAKU.TripleTriplets;
      else if (this.checkMixedTripleSequence(blocks)) yaku |= YAKU.MixedTripleSequence;
      yaku |= this.checkOutsideHand(blocks);
      yaku |= this.checkAllTriplets(blocks);
      yaku |= this.checkThreeConcealedTriplets(blocks);

      let han = 0;
      for (const bit of YAKU_ORDER) {
        if ((yaku & bit) !== 0n) {
          const [closedHan, openHan] = YAKU_HAN.get(bit) ?? [0, 0];
          han += isClosed(player) ? closedHan : openHan;
        }
      }
      const fu = this.calcFu(blocks, waitType, isClosed(player), (winFlag & WinFlag.Tsumo) !== 0, isPinfu, round.wind, player.wind);
      if (best.han < han || (best.han === han && best.fu < fu)) {
        best = { han, fu, idx: i, yaku };
      }
    }

    const finalPattern = patterns[best.idx];
    return {
      yaku: best.yaku,
      fu: Math.ceil(best.fu / 10) * 10,
      blocks: finalPattern.blocks,
      waitType: finalPattern.waitType
    };
  }

  private calcFu(blocks: Block[], waitType: number, closed: boolean, tsumo: boolean, pinfu: boolean, roundWind: number, seatWind: number): number {
    if (pinfu && tsumo && closed) return 20;
    if (pinfu && !tsumo && !closed) return 30;
    let fu = 20;
    if (closed && !tsumo) fu += 10;
    else if (tsumo) fu += 2;
    if (waitType === WaitType.ClosedWait || waitType === WaitType.EdgeWait || waitType === WaitType.PairWait) fu += 2;
    for (const block of blocks) {
      if ((block.type & (BlockType.Triplet | BlockType.Kong)) !== 0) {
        let blockFu = 0;
        if (block.type === (BlockType.Triplet | BlockType.Open)) blockFu = 2;
        else if (block.type === BlockType.Triplet) blockFu = 4;
        else if (block.type === (BlockType.Kong | BlockType.Open)) blockFu = 8;
        else if (block.type === BlockType.Kong) blockFu = 16;
        fu += isTerminalOrHonor(block.minTile) ? blockFu * 2 : blockFu;
      } else if ((block.type & BlockType.Pair) !== 0) {
        if (block.minTile === seatWind && block.minTile === roundWind) fu += 4;
        else if (block.minTile === seatWind || block.minTile === roundWind || block.minTile >= Tile.White) fu += 2;
      }
    }
    return fu;
  }

  private separateHand(player: Player, winTile: number, winFlag: number): Pattern[] {
    const openBlocks: Block[] = player.melds.map((meld) => {
      if (meld.type === 0) return { type: BlockType.Triplet | BlockType.Open, minTile: toNoReddora(meld.tiles[0]!) };
      if (meld.type === 1) return { type: BlockType.Sequence | BlockType.Open, minTile: toNoReddora(meld.tiles[0]!) };
      if (meld.type === 2) return { type: BlockType.Kong, minTile: toNoReddora(meld.tiles[0]!) };
      return { type: BlockType.Kong | BlockType.Open, minTile: toNoReddora(meld.tiles[0]!) };
    });

    const counts = player.hand.slice(0, 34);
    const rawPatterns: Block[][] = [];
    for (let pairTile = 0; pairTile < 34; pairTile += 1) {
      if (counts[pairTile] < 2) continue;
      counts[pairTile] -= 2;
      const blocks: Block[] = [...openBlocks, { type: BlockType.Pair, minTile: pairTile }];
      this.extractMeldPatterns(counts, blocks, rawPatterns);
      counts[pairTile] += 2;
    }

    const winPatterns: Pattern[] = [];
    for (const blocks of rawPatterns) {
      for (const variant of this.createWaitPatterns(blocks, toNoReddora(winTile), (winFlag & WinFlag.Tsumo) !== 0)) {
        winPatterns.push(variant);
      }
    }
    return winPatterns;
  }

  private extractMeldPatterns(counts: number[], blocks: Block[], output: Block[][]): void {
    let tile = 0;
    while (tile < 34 && counts[tile] === 0) tile += 1;
    if (tile === 34) {
      output.push(blocks.map((block) => ({ ...block })));
      return;
    }
    if (counts[tile] >= 3) {
      counts[tile] -= 3;
      blocks.push({ type: BlockType.Triplet, minTile: tile });
      this.extractMeldPatterns(counts, blocks, output);
      blocks.pop();
      counts[tile] += 3;
    }
    if (tile < 27 && tile % 9 <= 6 && counts[tile + 1] > 0 && counts[tile + 2] > 0) {
      counts[tile] -= 1;
      counts[tile + 1] -= 1;
      counts[tile + 2] -= 1;
      blocks.push({ type: BlockType.Sequence, minTile: tile });
      this.extractMeldPatterns(counts, blocks, output);
      blocks.pop();
      counts[tile] += 1;
      counts[tile + 1] += 1;
      counts[tile + 2] += 1;
    }
  }

  private createWaitPatterns(blocks: Block[], winTile: number, tsumo: boolean): Pattern[] {
    const patterns: Pattern[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]!;
      if ((block.type & BlockType.Open) !== 0) continue;

      let waitType = WaitType.Null;
      if ((block.type & (BlockType.Triplet | BlockType.Kong)) !== 0 && block.minTile === winTile) waitType = WaitType.TripletWait;
      else if (block.type === BlockType.Sequence && block.minTile + 1 === winTile) waitType = WaitType.ClosedWait;
      else if (block.type === BlockType.Sequence && block.minTile + 2 === winTile && [Tile.Manzu1, Tile.Pinzu1, Tile.Souzu1].includes(block.minTile)) waitType = WaitType.EdgeWait;
      else if (block.type === BlockType.Sequence && block.minTile === winTile && [Tile.Manzu7, Tile.Pinzu7, Tile.Souzu7].includes(block.minTile)) waitType = WaitType.EdgeWait;
      else if (block.type === BlockType.Sequence && (block.minTile === winTile || block.minTile + 2 === winTile)) waitType = WaitType.DoubleEdgeWait;
      else if (block.type === BlockType.Pair && block.minTile === winTile) waitType = WaitType.PairWait;
      else continue;

      const cloned = blocks.map((x) => ({ ...x }));
      if (!tsumo) {
        cloned[i] = { ...cloned[i]!, type: cloned[i]!.type | BlockType.Open };
      }
      patterns.push({ blocks: cloned, waitType });
    }
    return patterns;
  }

  private mergeHand(player: Player): MergedHand {
    const hand = player.hand.slice();
    for (const meld of player.melds) {
      const minTile = toNoReddora(meld.tiles[0]!);
      if (meld.type === 1) {
        hand[minTile] += 1;
        hand[minTile + 1] += 1;
        hand[minTile + 2] += 1;
      } else {
        hand[minTile] += 3;
      }
    }
    return [
      hand,
      this.hashSlice(hand, 0, 9),
      this.hashSlice(hand, 9, 18),
      this.hashSlice(hand, 18, 27),
      this.hashSlice(hand, 27, 34)
    ];
  }

  private checkPinfu(blocks: Block[], waitType: number, roundWind: number, seatWind: number): boolean {
    if (waitType !== WaitType.DoubleEdgeWait) return false;
    for (const block of blocks) {
      if ((block.type & (BlockType.Triplet | BlockType.Kong)) !== 0) return false;
      if ((block.type & BlockType.Pair) !== 0 && (block.minTile === roundWind || block.minTile === seatWind || block.minTile >= Tile.White)) return false;
    }
    return true;
  }

  private checkPureDoubleSequence(blocks: Block[]): Yaku {
    const count = Array.from({ length: 34 }, () => 0);
    for (const block of blocks) if ((block.type & BlockType.Sequence) !== 0) count[block.minTile] += 1;
    let doubleSeq = 0;
    for (const value of count) {
      if (value === 4) doubleSeq += 2;
      else if (value >= 2) doubleSeq += 1;
    }
    if (doubleSeq === 1) return YAKU.PureDoubleSequence;
    if (doubleSeq === 2) return YAKU.TwicePureDoubleSequence;
    return YAKU.Null;
  }

  private checkAllTriplets(blocks: Block[]): Yaku {
    return blocks.some((block) => (block.type & BlockType.Sequence) !== 0) ? YAKU.Null : YAKU.AllTriplets;
  }

  private checkThreeConcealedTriplets(blocks: Block[]): Yaku {
    let triplets = 0;
    for (const block of blocks) if (block.type === BlockType.Triplet || block.type === BlockType.Kong) triplets += 1;
    return triplets === 3 ? YAKU.ThreeConcealedTriplets : YAKU.Null;
  }

  private checkTripleTriplets(blocks: Block[]): boolean {
    const count = Array.from({ length: 34 }, () => 0);
    for (const block of blocks) if ((block.type & (BlockType.Triplet | BlockType.Kong)) !== 0) count[block.minTile] += 1;
    for (let i = 0; i < 9; i += 1) if (count[i] && count[i + 9] && count[i + 18]) return true;
    return false;
  }

  private checkMixedTripleSequence(blocks: Block[]): boolean {
    const count = Array.from({ length: 34 }, () => 0);
    for (const block of blocks) if ((block.type & BlockType.Sequence) !== 0) count[block.minTile] += 1;
    for (let i = 0; i < 9; i += 1) if (count[i] && count[i + 9] && count[i + 18]) return true;
    return false;
  }

  private checkPureStraight(blocks: Block[]): boolean {
    const count = Array.from({ length: 34 }, () => 0);
    for (const block of blocks) if ((block.type & BlockType.Sequence) !== 0) count[block.minTile] += 1;
    return Boolean(
      (count[Tile.Manzu1] && count[Tile.Manzu4] && count[Tile.Manzu7]) ||
      (count[Tile.Pinzu1] && count[Tile.Pinzu4] && count[Tile.Pinzu7]) ||
      (count[Tile.Souzu1] && count[Tile.Souzu4] && count[Tile.Souzu7])
    );
  }

  private checkOutsideHand(blocks: Block[]): Yaku {
    let honorBlock = false;
    let sequenceBlock = false;
    for (const block of blocks) {
      if ((block.type & BlockType.Sequence) !== 0) {
        if (![Tile.Manzu1, Tile.Manzu7, Tile.Pinzu1, Tile.Pinzu7, Tile.Souzu1, Tile.Souzu7].includes(block.minTile)) return YAKU.Null;
        sequenceBlock = true;
      } else {
        if (!(block.minTile === Tile.Manzu1 || block.minTile === Tile.Manzu9 || block.minTile === Tile.Pinzu1 || block.minTile === Tile.Pinzu9 || block.minTile === Tile.Souzu1 || block.minTile === Tile.Souzu9 || block.minTile >= Tile.East)) return YAKU.Null;
        honorBlock ||= block.minTile >= Tile.East;
      }
    }
    if (honorBlock && sequenceBlock) return YAKU.HalfOutsideHand;
    if (!honorBlock && sequenceBlock) return YAKU.FullyOutsideHand;
    return YAKU.Null;
  }

  private checkAllGreen([, manzu, pinzu, souzu, honors]: MergedHand): Yaku {
    const souzuMask = 0b111000000000111000111000111;
    const honorsMask = 0b111111111111111000111;
    return manzu || pinzu || (souzu & souzuMask) || (honors & honorsMask) ? YAKU.Null : YAKU.AllGreen;
  }

  private checkThreeDragons([hand]: MergedHand): Yaku {
    const sum = hand[Tile.White] + hand[Tile.Green] + hand[Tile.Red];
    if (sum === 8) return YAKU.LittleThreeDragons;
    if (sum === 9) return YAKU.BigThreeDragons;
    return YAKU.Null;
  }

  private checkFourWinds([hand]: MergedHand): Yaku {
    const sum = hand[Tile.East] + hand[Tile.South] + hand[Tile.West] + hand[Tile.North];
    if (sum === 11) return YAKU.LittleFourWinds;
    if (sum === 12) return YAKU.BigFourWinds;
    return YAKU.Null;
  }

  private checkAllHonors([, manzu, pinzu, souzu]: MergedHand): Yaku {
    return manzu || pinzu || souzu ? YAKU.Null : YAKU.AllHonors;
  }

  private checkFourConcealedTriplets(player: Player, [hand]: MergedHand, winTile: number, winFlag: number): Yaku {
    if ((winFlag & WinFlag.Tsumo) === 0 || !isClosed(player)) return YAKU.Null;
    let triplets = 0;
    let pairs = 0;
    let singleWait = false;
    for (let i = 0; i < 34; i += 1) {
      if (hand[i] === 3) triplets += 1;
      else if (hand[i] === 2) {
        pairs += 1;
        singleWait = i === winTile;
      }
    }
    if (triplets === 4 && pairs === 1) return singleWait ? YAKU.SingleWaitFourConcealedTriplets : YAKU.FourConcealedTriplets;
    return YAKU.Null;
  }

  private checkAllTerminals([, manzu, pinzu, souzu, honors]: MergedHand): Yaku {
    const terminalsMask = 0b000111111111111111111111000;
    if (((manzu | pinzu | souzu) & terminalsMask) !== 0) return YAKU.Null;
    return honors ? YAKU.AllTerminalsAndHonors : YAKU.AllTerminals;
  }

  private checkKongs(player: Player): Yaku {
    let kongs = 0;
    for (const meld of player.melds) kongs += meld.type >= 2 ? 1 : 0;
    if (kongs === 4) return YAKU.FourKongs;
    if (kongs === 3) return YAKU.ThreeKongs;
    return YAKU.Null;
  }

  private checkNineGates(player: Player, [hand, manzu, pinzu, souzu]: MergedHand, winTile: number): Yaku {
    if (player.melds.length > 0) return YAKU.Null;
    const mask = 0b011001001001001001001001011;
    let valid = false;
    let pure = false;
    if (winTile <= Tile.Manzu9) {
      valid = hand[Tile.Manzu1] >= 3 && hand[Tile.Manzu2] > 0 && hand[Tile.Manzu3] > 0 && hand[Tile.Manzu4] > 0 && hand[Tile.Manzu5] > 0 && hand[Tile.Manzu6] > 0 && hand[Tile.Manzu7] > 0 && hand[Tile.Manzu8] > 0 && hand[Tile.Manzu9] >= 3;
      pure = manzu - TILE1[winTile] === mask;
    } else if (winTile <= Tile.Pinzu9) {
      valid = hand[Tile.Pinzu1] >= 3 && hand[Tile.Pinzu2] > 0 && hand[Tile.Pinzu3] > 0 && hand[Tile.Pinzu4] > 0 && hand[Tile.Pinzu5] > 0 && hand[Tile.Pinzu6] > 0 && hand[Tile.Pinzu7] > 0 && hand[Tile.Pinzu8] > 0 && hand[Tile.Pinzu9] >= 3;
      pure = pinzu - TILE1[winTile] === mask;
    } else if (winTile <= Tile.Souzu9) {
      valid = hand[Tile.Souzu1] >= 3 && hand[Tile.Souzu2] > 0 && hand[Tile.Souzu3] > 0 && hand[Tile.Souzu4] > 0 && hand[Tile.Souzu5] > 0 && hand[Tile.Souzu6] > 0 && hand[Tile.Souzu7] > 0 && hand[Tile.Souzu8] > 0 && hand[Tile.Souzu9] >= 3;
      pure = souzu - TILE1[winTile] === mask;
    }
    if (!valid) return YAKU.Null;
    return pure ? YAKU.TrueNineGates : YAKU.NineGates;
  }

  private checkThirteenWaitThirteenOrphans([, manzu, pinzu, souzu, honors]: MergedHand, winTile: number): boolean {
    const terminalsMask = 0b001000000000000000000000001;
    const honorsMask = 0b001001001001001001001;
    if (winTile <= Tile.Manzu9) return manzu - TILE1[winTile] === terminalsMask && pinzu === terminalsMask && souzu === terminalsMask && honors === honorsMask;
    if (winTile <= Tile.Pinzu9) return manzu === terminalsMask && pinzu - TILE1[winTile] === terminalsMask && souzu === terminalsMask && honors === honorsMask;
    if (winTile <= Tile.Souzu9) return manzu === terminalsMask && pinzu === terminalsMask && souzu - TILE1[winTile] === terminalsMask && honors === honorsMask;
    return manzu === terminalsMask && pinzu === terminalsMask && souzu === terminalsMask && honors - TILE1[winTile] === honorsMask;
  }

  private checkTanyao(player: Player, [, manzu, pinzu, souzu, honors]: MergedHand, openTanyao: boolean): Yaku {
    if (!openTanyao && !isClosed(player)) return YAKU.Null;
    const terminalsMask = 0b111000000000000000000000111;
    return (manzu & terminalsMask) || (pinzu & terminalsMask) || (souzu & terminalsMask) || honors ? YAKU.Null : YAKU.Tanyao;
  }

  private checkFlush([, manzu, pinzu, souzu, honors]: MergedHand): Yaku {
    const oneSuit = Number(manzu !== 0) + Number(pinzu !== 0) + Number(souzu !== 0) === 1;
    if (!oneSuit) return YAKU.Null;
    return honors ? YAKU.HalfFlush : YAKU.FullFlush;
  }

  private checkValueTile(round: Round, player: Player, [hand]: MergedHand): Yaku {
    let yaku = YAKU.Null;
    if (hand[Tile.White] === 3) yaku |= YAKU.WhiteDragon;
    if (hand[Tile.Green] === 3) yaku |= YAKU.GreenDragon;
    if (hand[Tile.Red] === 3) yaku |= YAKU.RedDragon;
    if (hand[round.wind] === 3) {
      if (round.wind === Tile.East) yaku |= YAKU.RoundWindEast;
      else if (round.wind === Tile.South) yaku |= YAKU.RoundWindSouth;
      else if (round.wind === Tile.West) yaku |= YAKU.RoundWindWest;
      else if (round.wind === Tile.North) yaku |= YAKU.RoundWindNorth;
    }
    if (hand[player.wind] === 3) {
      if (player.wind === Tile.East) yaku |= YAKU.SelfWindEast;
      else if (player.wind === Tile.South) yaku |= YAKU.SelfWindSouth;
      else if (player.wind === Tile.West) yaku |= YAKU.SelfWindWest;
      else if (player.wind === Tile.North) yaku |= YAKU.SelfWindNorth;
    }
    return yaku;
  }

  private fuToIndex(fu: number): number {
    switch (fu) {
      case 20: return 0;
      case 25: return 1;
      case 30: return 2;
      case 40: return 3;
      case 50: return 4;
      case 60: return 5;
      case 70: return 6;
      case 80: return 7;
      case 90: return 8;
      case 100: return 9;
      case 110: return 10;
      default: return -1;
    }
  }

  private hashSlice(hand: Count, start: number, end: number): number {
    let value = 0;
    for (let i = start; i < end; i += 1) value = value * 8 + hand[i];
    return value;
  }

  private checkExclusive(value: number): boolean {
    return value === 0 || (value & (value - 1)) === 0;
  }
}
