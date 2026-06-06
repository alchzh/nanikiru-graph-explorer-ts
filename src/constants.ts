export enum Tile {
  Null = -1,
  Manzu1,
  Manzu2,
  Manzu3,
  Manzu4,
  Manzu5,
  Manzu6,
  Manzu7,
  Manzu8,
  Manzu9,
  Pinzu1,
  Pinzu2,
  Pinzu3,
  Pinzu4,
  Pinzu5,
  Pinzu6,
  Pinzu7,
  Pinzu8,
  Pinzu9,
  Souzu1,
  Souzu2,
  Souzu3,
  Souzu4,
  Souzu5,
  Souzu6,
  Souzu7,
  Souzu8,
  Souzu9,
  East,
  South,
  West,
  North,
  White,
  Green,
  Red,
  RedManzu5,
  RedPinzu5,
  RedSouzu5,
  Length
}

export enum MeldType {
  Null = -1,
  Pon,
  Chii,
  Ankan,
  Minkan,
  Kakan,
  Length
}

export enum BlockType {
  Null = 0,
  Triplet = 1,
  Sequence = 2,
  Kong = 4,
  Pair = 8,
  Open = 16
}

export enum PlayerType {
  Null = -1,
  Player0,
  Player1,
  Player2,
  Player3,
  Length
}

export enum RuleFlag {
  Null = 0,
  RedDora = 1,
  OpenTanyao = 2
}

export enum ShantenFlag {
  Null = 0,
  Regular = 1,
  SevenPairs = 2,
  ThirteenOrphans = 4,
  All = Regular | SevenPairs | ThirteenOrphans
}

export enum WinFlag {
  Null = 0,
  Tsumo = 1 << 1,
  Riichi = 1 << 2,
  Ippatsu = 1 << 3,
  RobbingAKong = 1 << 4,
  AfterAKong = 1 << 5,
  UnderTheSea = 1 << 6,
  UnderTheRiver = 1 << 7,
  DoubleRiichi = 1 << 8,
  NagashiMangan = 1 << 9,
  BlessingOfHeaven = 1 << 10,
  BlessingOfEarth = 1 << 11,
  HandOfMan = 1 << 12
}

export enum ScoreTitle {
  Null = -1,
  Mangan,
  Haneman,
  Baiman,
  Sanbaiman,
  CountedYakuman,
  Yakuman,
  DoubleYakuman,
  TripleYakuman,
  QuadrupleYakuman,
  QuintupleYakuman,
  SextupleYakuman,
  Length
}

export enum WaitType {
  Null = -1,
  DoubleEdgeWait,
  EdgeWait,
  ClosedWait,
  TripletWait,
  PairWait,
  Length
}

export const TILE_NAMES: string[] = [
  "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m",
  "1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p",
  "1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s",
  "1z", "2z", "3z", "4z", "5z", "6z", "7z",
  "0m", "0p", "0s"
];

export const TILE_NAME_TO_ID = new Map<string, number>(
  TILE_NAMES.map((name, index) => [name, index])
);

export const TO_INDICATOR: number[] = [
  Tile.Manzu9, Tile.Manzu1, Tile.Manzu2, Tile.Manzu3, Tile.Manzu4, Tile.Manzu5,
  Tile.Manzu6, Tile.Manzu7, Tile.Manzu8, Tile.Pinzu9, Tile.Pinzu1, Tile.Pinzu2,
  Tile.Pinzu3, Tile.Pinzu4, Tile.Pinzu5, Tile.Pinzu6, Tile.Pinzu7, Tile.Pinzu8,
  Tile.Souzu9, Tile.Souzu1, Tile.Souzu2, Tile.Souzu3, Tile.Souzu4, Tile.Souzu5,
  Tile.Souzu6, Tile.Souzu7, Tile.Souzu8, Tile.North, Tile.East, Tile.South,
  Tile.West, Tile.Red, Tile.White, Tile.Green, Tile.Manzu4, Tile.Pinzu4, Tile.Souzu4
];

export const TO_DORA: number[] = [
  Tile.Manzu2, Tile.Manzu3, Tile.Manzu4, Tile.Manzu5, Tile.Manzu6, Tile.Manzu7,
  Tile.Manzu8, Tile.Manzu9, Tile.Manzu1, Tile.Pinzu2, Tile.Pinzu3, Tile.Pinzu4,
  Tile.Pinzu5, Tile.Pinzu6, Tile.Pinzu7, Tile.Pinzu8, Tile.Pinzu9, Tile.Pinzu1,
  Tile.Souzu2, Tile.Souzu3, Tile.Souzu4, Tile.Souzu5, Tile.Souzu6, Tile.Souzu7,
  Tile.Souzu8, Tile.Souzu9, Tile.Souzu1, Tile.South, Tile.West, Tile.North,
  Tile.East, Tile.Green, Tile.Red, Tile.White, Tile.Manzu6, Tile.Pinzu6, Tile.Souzu6
];

export const THIRTEEN_ORPHANS_TILES = [
  Tile.Manzu1, Tile.Manzu9, Tile.Pinzu1, Tile.Pinzu9, Tile.Souzu1, Tile.Souzu9,
  Tile.East, Tile.South, Tile.West, Tile.North, Tile.White, Tile.Green, Tile.Red
];

export const TANYAO_TILES = [
  Tile.Manzu2, Tile.Manzu3, Tile.Manzu4, Tile.Manzu5, Tile.Manzu6, Tile.Manzu7, Tile.Manzu8,
  Tile.Pinzu2, Tile.Pinzu3, Tile.Pinzu4, Tile.Pinzu5, Tile.Pinzu6, Tile.Pinzu7, Tile.Pinzu8,
  Tile.Souzu2, Tile.Souzu3, Tile.Souzu4, Tile.Souzu5, Tile.Souzu6, Tile.Souzu7, Tile.Souzu8
];
