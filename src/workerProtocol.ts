import type { SerializedSubgraph } from "./expectedScoreCalculator.js";
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

/**
 * Internal request sent from the coordinator worker to a pool worker, asking it to build
 * the search subtree for a single candidate discard tile on its own thread.
 */
export interface ExpectedScoreSubcalcRequest extends ExpectedScoreCalculationPayload {
  id: number;
  kind: "subcalc";
  discardTile: number;
}

export type ExpectedScoreWorkerRequest =
  | ExpectedScoreCalculationRequest
  | ExpectedScoreSnapshotRequest
  | ExpectedScoreSubcalcRequest;

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

/** Reply from a pool worker carrying the serialized subtree for one candidate discard. */
export type ExpectedScoreSubcalcResponse =
  | {
      id: number;
      ok: true;
      subgraph: SerializedSubgraph;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };
