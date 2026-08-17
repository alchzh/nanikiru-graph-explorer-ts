import { PystyleMahjongEngine } from "./analyzers.js";
import { ExpectedScoreCalculatorTs, type SerializedSubgraph } from "./expectedScoreCalculator.js";
import { TypeScriptScoreEngine } from "./scoreCalculator.js";
import type {
  ExpectedScoreCalculationRequest,
  ExpectedScoreSubcalcRequest,
  ExpectedScoreSubcalcResponse,
  ExpectedScoreWorkerRequest,
  ExpectedScoreWorkerResponse
} from "./workerProtocol.js";

const shantenEngine = new PystyleMahjongEngine();
const engine = new PystyleMahjongEngine({ scoring: new TypeScriptScoreEngine(shantenEngine) });
const calculator = new ExpectedScoreCalculatorTs();

const workerScope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<ExpectedScoreWorkerRequest>) => void): void;
  postMessage(message: ExpectedScoreWorkerResponse | ExpectedScoreSubcalcResponse): void;
};

// Hard cap so a machine reporting a very high core count doesn't spawn an excessive
// number of nested workers. Discard analyses have at most ~14 candidates anyway.
const MAX_POOL_WORKERS = 16;

interface WorkerPool {
  workers: Worker[];
}

interface PendingSubcalc {
  resolve(subgraph: SerializedSubgraph): void;
  reject(error: Error): void;
}

// undefined = not yet attempted, null = unavailable (single-threaded fallback).
let pool: WorkerPool | null | undefined;
const pendingSubcalcs = new Map<number, PendingSubcalc>();
let nextSubcalcId = 1;

function failAllPending(message: string): void {
  for (const [id, pending] of pendingSubcalcs) {
    pendingSubcalcs.delete(id);
    pending.reject(new Error(message));
  }
}

function teardownPool(): void {
  if (pool) {
    for (const worker of pool.workers) {
      worker.terminate();
    }
  }
  // Mark the pool permanently unavailable for this session so subsequent
  // analyses use the single-threaded path instead of respawning failing workers.
  pool = null;
}

/** Lazily create (once) the nested worker pool, or return null when unsupported. */
function getPool(): WorkerPool | null {
  if (pool !== undefined) {
    return pool;
  }
  try {
    const hardwareConcurrency = typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 1;
    const size = Math.min(Math.max(1, hardwareConcurrency), MAX_POOL_WORKERS);
    if (size <= 1) {
      pool = null;
      return pool;
    }

    const workers: Worker[] = [];
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(new URL(import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<ExpectedScoreSubcalcResponse>) => {
        const data = event.data;
        const pending = pendingSubcalcs.get(data.id);
        if (!pending) {
          return;
        }
        pendingSubcalcs.delete(data.id);
        if (data.ok) {
          pending.resolve(data.subgraph);
        } else {
          pending.reject(new Error(data.error));
        }
      });
      worker.addEventListener("error", (event: ErrorEvent) => {
        // A nested worker failing is unexpected; reject outstanding tasks so the
        // coordinator falls back to the single-threaded path, and tear the pool
        // down so later analyses don't keep retrying broken workers.
        failAllPending(event.message || "Expected score pool worker failed.");
        teardownPool();
      });
      workers.push(worker);
    }
    pool = { workers };
    return pool;
  } catch {
    pool = null;
    return pool;
  }
}

/** Dispatch one subcalc per candidate discard across the pool and await every subtree. */
function dispatchSubcalcs(
  activePool: WorkerPool,
  request: ExpectedScoreCalculationRequest,
  candidates: number[]
): Promise<SerializedSubgraph[]> {
  const { config, round, player, wall } = request;
  return Promise.all(
    candidates.map((discardTile, index) => {
      const id = nextSubcalcId;
      nextSubcalcId += 1;
      const worker = activePool.workers[index % activePool.workers.length]!;
      return new Promise<SerializedSubgraph>((resolve, reject) => {
        pendingSubcalcs.set(id, { resolve, reject });
        worker.postMessage({
          id,
          kind: "subcalc",
          config,
          round,
          player,
          wall,
          discardTile
        } satisfies ExpectedScoreSubcalcRequest);
      });
    })
  );
}

async function runCalculation(request: ExpectedScoreCalculationRequest) {
  const { config, round, player, wall, options } = request;

  // Only the 14-tile discard analysis splits into independent per-discard subtrees.
  let plan: ReturnType<ExpectedScoreCalculatorTs["planDiscardCandidates"]> = null;
  try {
    plan = calculator.planDiscardCandidates(config, round, player, engine, wall);
  } catch {
    plan = null;
  }

  if (plan && plan.candidates.length > 1) {
    const activePool = getPool();
    if (activePool) {
      try {
        const subgraphs = await dispatchSubcalcs(activePool, request, plan.candidates);
        return calculator.calc(config, round, player, engine, wall, {
          ...(options ?? {}),
          importedSubgraphs: subgraphs
        });
      } catch {
        // Any pool failure → fall through to the single-threaded build below.
      }
    }
  }

  return calculator.calc(config, round, player, engine, wall, options ?? {});
}

function runSubcalc(request: ExpectedScoreSubcalcRequest): ExpectedScoreSubcalcResponse {
  try {
    const subgraph = calculator.calcCandidateSubgraph(
      request.config,
      request.round,
      request.player,
      engine,
      request.wall,
      request.discardTile
    );
    return { id: request.id, ok: true, subgraph };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runCoordinatorRequest(request: ExpectedScoreWorkerRequest): Promise<void> {
  try {
    const result = request.kind === "calculate"
      ? await runCalculation(request)
      : request.kind === "snapshot"
        ? calculator.snapshotFromNode(request.rootNodeId, request.graphDepthLimit)
        : undefined;
    if (result === undefined) {
      return;
    }
    workerScope.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;

  // Pool workers only ever receive "subcalc" messages from the coordinator.
  if (request.kind === "subcalc") {
    workerScope.postMessage(runSubcalc(request));
    return;
  }

  void runCoordinatorRequest(request);
});
