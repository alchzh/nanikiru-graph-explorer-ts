import { PystyleMahjongEngine } from "./analyzers.js";
import { ExpectedScoreCalculatorTs } from "./expectedScoreCalculator.js";
import { TypeScriptScoreEngine } from "./scoreCalculator.js";
import type { ExpectedScoreWorkerRequest, ExpectedScoreWorkerResponse } from "./workerProtocol.js";

const shantenEngine = new PystyleMahjongEngine();
const engine = new PystyleMahjongEngine({ scoring: new TypeScriptScoreEngine(shantenEngine) });
const calculator = new ExpectedScoreCalculatorTs();

const workerScope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<ExpectedScoreWorkerRequest>) => void): void;
  postMessage(message: ExpectedScoreWorkerResponse): void;
};

workerScope.addEventListener("message", (event) => {
  const request = event.data;

  try {
    const result = request.kind === "calculate"
      ? calculator.calc(
          request.config,
          request.round,
          request.player,
          engine,
          request.wall,
          request.options ?? {}
        )
      : calculator.snapshotFromNode(request.rootNodeId, request.graphDepthLimit);
    workerScope.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
