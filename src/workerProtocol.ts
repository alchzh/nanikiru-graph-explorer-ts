import type { CalculationResult, Config, Count, NodeId, Player, Round, SearchNode } from "./model.js";

export interface ExpectedScoreCalculationOptions {
  graphDepthLimit?: number;
  startNode?: Pick<SearchNode, "phase" | "hand" | "wall" | "riichi" | "forcedDiscardTile">;
  originHand?: Count;
  originShanten?: number;
}

export interface ExpectedScoreCalculationPayload {
  config: Config;
  round: Round;
  player: Player;
  wall?: Count;
  options?: ExpectedScoreCalculationOptions;
}

export interface ExpectedScoreCalculationRequest extends ExpectedScoreCalculationPayload {
  id: number;
  kind: "calculate";
}

export interface ExpectedScoreSnapshotRequest {
  id: number;
  kind: "snapshot";
  rootNodeId: NodeId;
  graphDepthLimit?: number;
}

export type ExpectedScoreWorkerRequest = ExpectedScoreCalculationRequest | ExpectedScoreSnapshotRequest;

export type ExpectedScoreWorkerResponse =
  | {
      id: number;
      ok: true;
      result: CalculationResult;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };
