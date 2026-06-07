import { MeldType, PlayerType, RuleFlag, ShantenFlag, Tile } from "./constants.js";

export type Count = number[];

export interface Meld {
  type: number;
  tiles: number[];
  discardedTile: number;
  from: number;
}

export interface Block {
  type: number;
  minTile: number;
}

export interface Player {
  hand: Count;
  melds: Meld[];
  wind: number;
}

export interface Round {
  rules: number;
  wind: number;
  kyoku: number;
  honba: number;
  kyotaku: number;
  doraIndicators: number[];
  uradoraIndicators: number[];
}

export interface Config {
  tMin: number;
  tMax: number;
  sum: number;
  extra: number;
  shantenType: number;
  enableReddora: boolean;
  enableUradora: boolean;
  enableShantenDown: boolean;
  enableTegawari: boolean;
  enableRiichi: boolean;
  calcStats: boolean;
}

export interface ScoreResult {
  success: boolean;
  score: number[];
  scoreTitle: number;
  han: number;
  fu: number;
  yakuList?: Array<[bigint, number]>;
  blocks?: Block[];
  waitType?: number;
  errMsg?: string;
}

export interface ShantenAnalysis {
  shantenType: number;
  shanten: number;
}

export interface TileAnalysis extends ShantenAnalysis {
  tiles: number[];
}

export interface ScoringEngine {
  calcFast(round: Round, player: Player, winTile: number, winFlag: number, shantenType: number): ScoreResult;
  getUpScores(round: Round, player: Player, result: ScoreResult, winFlag: number, n: number): number[];
}

export interface MahjongAnalysisEngine {
  calculateShanten(hand: Count, numMelds: number, type: number): ShantenAnalysis;
  analyzeNecessary(hand: Count, numMelds: number, type: number): TileAnalysis;
  analyzeUnnecessary(hand: Count, numMelds: number, type: number): TileAnalysis;
  scoring?: ScoringEngine;
  uradoraTable?: number[][];
}

export interface Stat {
  tile: number;
  tenpaiProb: number[];
  winProb: number[];
  expScore: number[];
  necessaryTiles: Array<[number, number]>;
  shanten: number;
  drawNodeId?: NodeId;
}

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type NodeId = Brand<number, "NodeId">;
export type EdgeId = Brand<number, "EdgeId">;
export type CacheKey = Brand<bigint, "CacheKey">;

export const enum NodePhase {
  Draw,
  Discard
}

export const enum EdgeKind {
  Chance,
  Decision
}

export const enum TileOutcome {
  HandChange,
  Win,
  Mixed
}

export interface EdgeTurnBreakdown {
  tile: number;
  targetNodeId: NodeId;
  weight: number;
  probability: number;
  immediateScore: number;
  baseScore: number;
  uradoraHitProbability: number;
  targetTenpai: number;
  targetWin: number;
  targetExpScore: number;
  contributionTenpai: number;
  contributionWin: number;
  contributionExpScore: number;
  realizedExpScore: number;
}

export interface DecisionTurnBreakdown {
  tile: number;
  sourceNodeId: NodeId;
  tenpai: number;
  win: number;
  expScore: number;
}

export interface TileBreakdown {
  tile: number;
  probability: number;
  evContribution: number;
  averageValue: number;
  winProbability: number;
  averageBaseValue: number;
  averageUradoraHitProbability: number;
  outcome: TileOutcome;
  targetNodeId?: NodeId;
}

export interface NodeTurnBreakdown {
  turn: number;
  remainingWallTiles: number;
  tenpai: number;
  win: number;
  expScore: number;
  chanceBranches?: EdgeTurnBreakdown[];
  decisionBranches?: DecisionTurnBreakdown[];
  tileBreakdowns?: TileBreakdown[];
  bestTenpaiTile?: number;
  bestWinTile?: number;
  bestExpScoreTile?: number;
}

export interface SearchNode {
  id: NodeId;
  phase: NodePhase;
  cacheKey: CacheKey;
  hand: Count;
  wall: Count;
  forcedDiscardTile?: number;
  shantenType: number;
  shanten: number;
  riichi: boolean;
  originDistance: number;
  allowTegawari: boolean;
  allowShantenDown: boolean;
  actionMask: bigint;
  outgoingEdgeIds: EdgeId[];
  incomingEdgeIds: EdgeId[];
  tenpaiProb: number[];
  winProb: number[];
  expScore: number[];
  turnBreakdowns: NodeTurnBreakdown[];
}

export interface SearchEdge {
  id: EdgeId;
  sourceId: NodeId;
  targetId: NodeId;
  tile: number;
  weight: number;
  score: number;
  baseScore: number;
  uradoraHitProbability: number;
  isWait: boolean;
  isDiscard: boolean;
  edgeKind: EdgeKind;
  riichiBefore: boolean;
  riichiAfter: boolean;
}

export interface SearchSummary {
  searchedVertices: number;
  searchedEdges: number;
  drawNodes: number;
  discardNodes: number;
  drawCacheHits: number;
  discardCacheHits: number;
}

export interface CalculationContext {
  originHand: Count;
  originShanten: number;
  graphDepthLimit: number;
  rootWallCount: number;
}

export interface CalculationResult {
  stats: Stat[];
  searched: number;
  search: SearchSummary;
  nodes: SearchNode[];
  edges: SearchEdge[];
  warnings: string[];
  rootNodeId?: NodeId;
  rootPhase?: NodePhase;
  context: CalculationContext;
}

export function createDefaultConfig(): Config {
  return {
    tMin: 1,
    tMax: 18,
    sum: 0,
    extra: 1,
    shantenType: ShantenFlag.All,
    enableReddora: true,
    enableUradora: true,
    enableShantenDown: true,
    enableTegawari: true,
    enableRiichi: true,
    calcStats: true
  };
}

export function createDefaultRound(): Round {
  return {
    rules: RuleFlag.RedDora | RuleFlag.OpenTanyao,
    wind: Tile.Null,
    kyoku: 1,
    honba: 0,
    kyotaku: 0,
    doraIndicators: [],
    uradoraIndicators: []
  };
}

export function createMeld(tiles: number[], type = MeldType.Null): Meld {
  return {
    type,
    tiles,
    discardedTile: tiles[0] ?? Tile.Null,
    from: PlayerType.Null
  };
}
