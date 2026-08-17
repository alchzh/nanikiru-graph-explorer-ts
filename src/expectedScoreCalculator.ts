import { ScoreTitle, Tile, TO_DORA, TO_INDICATOR, WinFlag } from "./constants.js";
import {
  CalculationResult,
  CacheKey,
  Config,
  Count,
  EdgeId,
  EdgeKind,
  MahjongAnalysisEngine,
  NodeId,
  NodePhase,
  NodeTurnBreakdown,
  Player,
  Round,
  SearchEdge,
  SearchNode,
  SearchSummary,
  Stat,
  TileBreakdown,
  TileOutcome
} from "./model.js";
import {
  addTileToMask,
  cloneCount,
  clonePlayer,
  isClosed,
  isReddora,
  numPlayerTiles,
  toNoReddora
} from "./utils.js";

type CountRed = Count;
const COUNT_PACK_BITS = 111n;
const COUNT_PACK_MASK = (1n << COUNT_PACK_BITS) - 1n;

interface CacheState {
  draw: Map<string, NodeId>;
  discard: Map<string, NodeId>;
}

interface NodeBuildInfo {
  shantenType: number;
  shanten: number;
  actionMask: bigint;
  actionMaskLow: number;
  actionMaskHigh: number;
  allowTegawari: boolean;
  allowShantenDown: boolean;
  forcedDiscardTile?: number;
}

interface CalculationOptions {
  graphDepthLimit?: number;
  startNode?: Pick<SearchNode, "phase" | "hand" | "wall" | "riichi" | "forcedDiscardTile">;
  originHand?: Count;
  originShanten?: number;
  /**
   * Pre-computed candidate sub-graphs (see {@link ExpectedScoreCalculatorTs.calcCandidateSubgraph}).
   * When supplied, the discard-root build reuses these nodes instead of expanding each
   * candidate draw subtree itself — this is how the multi-threaded path stitches together
   * work performed in parallel on separate worker threads.
   */
  importedSubgraphs?: SerializedSubgraph[];
}

/**
 * A serialized search sub-graph produced by {@link ExpectedScoreCalculatorTs.exportInternalGraph}.
 * Carries only the node metadata and edge data needed to rebuild the graph; per-turn stat
 * arrays are intentionally omitted because {@link ExpectedScoreCalculatorTs.calcStats}
 * re-derives them deterministically from the node/edge structure.
 */
export interface SerializedGraphNode {
  /** `${phase}:${handCacheKey}` — uniquely identifies a search state across sub-graphs. */
  key: string;
  phase: NodePhase;
  handCounts: number[];
  wallCounts: number[];
  forcedDiscardTile?: number;
  shantenType: number;
  shanten: number;
  riichi: boolean;
  originDistance: number;
  allowTegawari: boolean;
  allowShantenDown: boolean;
  actionMask: bigint;
  actionMaskLow: number;
  actionMaskHigh: number;
}

export interface SerializedGraphEdge {
  sourceKey: string;
  targetKey: string;
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

export interface SerializedSubgraph {
  nodes: SerializedGraphNode[];
  edges: SerializedGraphEdge[];
}

interface ScoreBreakdown {
  expectedScore: number;
  baseScore: number;
  uradoraHitProbability: number;
}

interface InternalDrawTileAggregate {
  probability: number;
  evContribution: number;
  valueContribution: number;
  winProbability: number;
  baseContribution: number;
  uradoraContribution: number;
  targetNodeId?: NodeId;
  targetContribution: number;
  hasHandChange: boolean;
  hasWin: boolean;
}

interface InternalTileBreakdown {
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

interface InternalSearchNode {
  id: NodeId;
  phase: NodePhase;
  stateKey?: CacheKey;
  wallSize: number;
  forcedDiscardTile?: number;
  shantenType: number;
  shanten: number;
  riichi: boolean;
  originDistance: number;
  allowTegawari: boolean;
  allowShantenDown: boolean;
  actionMask: bigint;
  actionMaskLow: number;
  actionMaskHigh: number;
  handCounts: CountRed;
  wallCounts: CountRed;
  outgoingEdgeIds: EdgeId[];
  incomingEdgeIds: EdgeId[];
  tenpaiProb: Float64Array;
  winProb: Float64Array;
  expScore: Float64Array;
}

interface InternalSearchEdge {
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

interface CalculationSnapshotState {
  config: Config;
  stats: Stat[];
  search: SearchSummary;
  warnings: string[];
  context: CalculationResult["context"];
}

interface BuildContext {
  config: Config;
  round: Round;
  engine: MahjongAnalysisEngine;
  caches: CacheState;
  handOrigin: CountRed;
  shantenOrigin: number;
  numMelds: number;
  isClosed: boolean;
  playerWind: number;
  playerMelds: Player["melds"];
}

interface BuildTask {
  phase: NodePhase;
  nodeId: NodeId;
  riichi: boolean;
  forcedDiscardTile?: number;
}

interface EnsureNodeResult {
  nodeId: NodeId;
  isNew: boolean;
}

interface MaskTileAnalysis {
  shantenType: number;
  shanten: number;
  maskLow: number;
  maskHigh: number;
}

interface MaskAnalysisEngine extends MahjongAnalysisEngine {
  analyzeNecessaryMasks?(hand: Count, numMelds: number, type: number): MaskTileAnalysis;
  analyzeUnnecessaryMasks?(hand: Count, numMelds: number, type: number): MaskTileAnalysis;
}

export class ExpectedScoreCalculatorTs {
  private readonly nodes: Array<InternalSearchNode | undefined> = [];
  private readonly edges: Array<InternalSearchEdge | undefined> = [];
  private readonly warnings: string[] = [];
  private readonly drawTileAggregateCache = new Map<number, InternalTileBreakdown[]>();
  private readonly sharedStatArrays = new Map<string, Float64Array>();
  /**
   * True while evaluating {@link Config.calcMode} `"reference"`, the faithful port of
   * mahjong-cpp's `ExpectedScoreCalculator`. Set by every public entry point before any
   * graph work; see {@link expandDrawNodeReference} for how the two models differ.
   */
  private referenceMode = false;
  private drawCacheHits = 0;
  private discardCacheHits = 0;
  private nodeCounter = 0;
  private edgeCounter = 0;
  private drawNodeCounter = 0;
  private discardNodeCounter = 0;
  private lastSnapshotState?: CalculationSnapshotState;

  calc(
    configInput: Config,
    round: Round,
    playerInput: Player,
    engine: MahjongAnalysisEngine,
    wallInput?: Count,
    options: CalculationOptions = {}
  ): CalculationResult {
    this.resetState();

    const graphDepthLimit = Math.max(0, options.graphDepthLimit ?? 2);
    const config: Config = { ...configInput };
    this.referenceMode = config.calcMode === "reference";
    const player = clonePlayer(playerInput);
    if (options.startNode) {
      player.hand = cloneCount(options.startNode.hand);
    }
    const wall = options.startNode
      ? cloneCount(options.startNode.wall)
      : wallInput
        ? cloneCount(wallInput)
        : this.createWall(round, playerInput, configInput.enableReddora);

    if (config.sum === 0) {
      config.sum = this.countBaseWallTiles(wall);
    }

    // config.enableRiichi = true;

    const handCounts = this.encode(player.hand, config.enableReddora);
    const wallCounts = this.encode(wall, config.enableReddora);
    const handOrigin = options.originHand
      ? this.encode(options.originHand, config.enableReddora)
      : cloneCount(handCounts);
    const shantenOrigin = options.originShanten
      ?? engine.calculateShanten(
        options.originHand ?? player.hand,
        player.melds.length,
        config.shantenType
      ).shanten;
    const numTiles = numPlayerTiles(player) + player.melds.length * 3;
    // Reference mode always enters the graph un-riichi (mahjong-cpp calls
    // `draw_node(false)` / `discard_node(false)`); riichi is declared later, inside the
    // discard expansion, on the tenpai discard itself.
    const riichi = options.startNode?.riichi
      ?? (!this.referenceMode && config.enableRiichi && isClosed(player) && shantenOrigin <= 0);
    const caches: CacheState = { draw: new Map(), discard: new Map() };
    if (options.importedSubgraphs && options.importedSubgraphs.length > 0) {
      this.seedImportedGraph(config, caches, options.importedSubgraphs);
    }
    const stats: Stat[] = [];
    let rootNodeId: NodeId | undefined;
    let rootPhase: NodePhase | undefined;

    if (!engine.scoring) {
      this.pushWarning("No scoring engine was provided. EV values will stay at 0 until a TS scorer is plugged in.");
    }

    if (options.startNode?.phase === NodePhase.Draw || (!options.startNode && numTiles === 13)) {
      rootNodeId = this.buildNodeGraph(
        config,
        round,
        player,
        engine,
        caches,
        handCounts,
        wallCounts,
        handOrigin,
        shantenOrigin,
        NodePhase.Draw,
        riichi
      );
      rootPhase = NodePhase.Draw;
      if (config.calcStats) {
        this.calcStats(config);
      }
      const rootId = caches.draw.get(this.createHandCacheKey(handCounts, riichi));
      if (rootId !== undefined) {
        const root = this.getNode(rootId)!;
        const necessary = this.getNecessaryTiles(config, player, wall, engine);
        stats.push({
          tile: Tile.Null,
          tenpaiProb: Array.from(root.tenpaiProb),
          winProb: Array.from(root.winProb),
          expScore: Array.from(root.expScore),
          necessaryTiles: necessary.necessaryTiles,
          shanten: necessary.shanten,
          drawNodeId: root.id
        });
      }
    } else {
      rootNodeId = this.buildNodeGraph(
        config,
        round,
        player,
        engine,
        caches,
        handCounts,
        wallCounts,
        handOrigin,
        shantenOrigin,
        NodePhase.Discard,
        riichi,
        options.startNode?.forcedDiscardTile
      );
      rootPhase = NodePhase.Discard;
      if (config.calcStats) {
        this.calcStats(config);
      }

      // Which draw node a candidate discard leads to depends on whether that discard
      // declares riichi. Reference mode re-derives the declaration per tile exactly as
      // mahjong-cpp's `calc_discard_hand` does; improved mode carries the root's flag.
      const rootDiscard = this.referenceMode
        ? this.analyzeUnnecessaryMasks(engine, player.hand, player.melds.length, config.shantenType)
        : undefined;
      const rootDiscardMask = rootDiscard
        ? this.extendMaskAnalysisWithRedFives(rootDiscard.maskLow, rootDiscard.maskHigh)
        : undefined;
      const playerIsClosed = isClosed(player);

      for (let tile = 0; tile < 37; tile += 1) {
        if (handCounts[tile] <= 0) {
          continue;
        }
        const statRiichi = rootDiscard && rootDiscardMask
          ? config.enableRiichi && playerIsClosed && rootDiscard.shanten === 0
            && this.maskHasBits(rootDiscardMask.low, rootDiscardMask.high, tile)
          : riichi;
        this.discard(player, handCounts, wallCounts, tile);
        const nodeId = caches.draw.get(this.createHandCacheKey(handCounts, statRiichi));
        if (nodeId !== undefined) {
          const node = this.getNode(nodeId)!;
          const necessary = this.getNecessaryTiles(config, player, wall, engine);
          stats.push({
            tile,
            tenpaiProb: Array.from(node.tenpaiProb),
            winProb: Array.from(node.winProb),
            expScore: Array.from(node.expScore),
            necessaryTiles: necessary.necessaryTiles,
            shanten: necessary.shanten,
            drawNodeId: node.id
          });
        }
        this.draw(player, handCounts, wallCounts, tile);
      }
    }

    const search: SearchSummary = {
      searchedVertices: this.nodeCounter,
      searchedEdges: this.edgeCounter,
      drawNodes: this.drawNodeCounter,
      discardNodes: this.discardNodeCounter,
      drawCacheHits: this.drawCacheHits,
      discardCacheHits: this.discardCacheHits
    };
    const context: CalculationResult["context"] = {
      originHand: this.decodeForDisplay(handOrigin),
      originShanten: shantenOrigin,
      graphDepthLimit,
      rootWallCount: this.countBaseWallTiles(wall)
    };
    this.lastSnapshotState = {
      config: { ...config },
      stats: this.cloneStats(stats),
      search,
      warnings: this.warnings.slice(),
      context
    };
    const snapshot = rootNodeId !== undefined && rootPhase !== undefined
      ? this.createGraphSnapshot(config, rootNodeId, rootPhase, graphDepthLimit)
      : { nodes: [], edges: [] };

    return {
      stats,
      searched: this.nodeCounter,
      search,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      warnings: this.warnings.slice(),
      rootNodeId,
      rootPhase,
      context
    };
  }

  snapshotFromNode(rootNodeId: NodeId, graphDepthLimit?: number): CalculationResult {
    if (!this.lastSnapshotState) {
      throw new Error("No calculated graph is available. Run analysis before requesting a graph snapshot.");
    }
    const root = this.getNode(rootNodeId);
    if (!root) {
      throw new Error(`Graph node is not available in the cached calculation: ${rootNodeId}`);
    }
    // The cached graph was built in whichever mode produced it; snapshotting must read it
    // back the same way (this instance may have served another mode in between).
    this.referenceMode = this.lastSnapshotState.config.calcMode === "reference";

    const depthLimit = Math.max(0, graphDepthLimit ?? this.lastSnapshotState.context.graphDepthLimit);
    const snapshot = this.createGraphSnapshot(
      this.lastSnapshotState.config,
      root.id,
      root.phase,
      depthLimit
    );
    return {
      stats: this.cloneStats(this.lastSnapshotState.stats),
      searched: this.lastSnapshotState.search.searchedVertices,
      search: { ...this.lastSnapshotState.search },
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      warnings: this.lastSnapshotState.warnings.slice(),
      rootNodeId: root.id,
      rootPhase: root.phase,
      context: {
        ...this.lastSnapshotState.context,
        graphDepthLimit: depthLimit
      }
    };
  }

  /**
   * Plan how a 14-tile discard analysis can be split into independent per-discard sub-tasks.
   * Returns the list of candidate discard tiles (encoded, red-fives separate) that the
   * discard-root expansion would visit, or `null` when the input is not a discard analysis
   * (in which case the caller should fall back to a single-threaded {@link calc}). The returned
   * candidate set mirrors the filtering performed by {@link expandDiscardNode} for the root node.
   */
  planDiscardCandidates(
    configInput: Config,
    round: Round,
    playerInput: Player,
    engine: MahjongAnalysisEngine,
    wallInput?: Count
  ): { candidates: number[]; riichi: boolean } | null {
    const config: Config = { ...configInput };
    this.referenceMode = config.calcMode === "reference";
    const player = clonePlayer(playerInput);
    const numTiles = numPlayerTiles(player) + player.melds.length * 3;
    if (numTiles !== 14) {
      return null;
    }
    const wall = wallInput
      ? cloneCount(wallInput)
      : this.createWall(round, playerInput, config.enableReddora);
    if (config.sum === 0) {
      config.sum = this.countBaseWallTiles(wall);
    }
    const handCounts = this.encode(player.hand, config.enableReddora);
    const shantenOrigin = engine.calculateShanten(player.hand, player.melds.length, config.shantenType).shanten;
    const riichi = !this.referenceMode && config.enableRiichi && isClosed(player) && shantenOrigin <= 0;
    const analysis = this.analyzeUnnecessaryMasks(engine, this.decodeForDisplay(handCounts), player.melds.length, config.shantenType);
    const mask = this.extendMaskAnalysisWithRedFives(analysis.maskLow, analysis.maskHigh);
    // originDistance is 0 at the root, so this matches ensureDiscardNode's allowShantenDown.
    const allowShantenDown = config.enableShantenDown
      && (!this.referenceMode || (!riichi && analysis.shanten >= 0))
      && analysis.shanten < shantenOrigin + config.extra;

    const candidates: number[] = [];
    for (let tile = 0; tile < 37; tile += 1) {
      const isDiscard = this.maskHasBits(mask.low, mask.high, tile);
      // Top-level discard root never has a forced discard, so only the riichi
      // "no shanten-down" guard from expandDiscardNode applies here.
      if (riichi && !isDiscard) {
        continue;
      }
      if (handCounts[tile] <= 0 || (!allowShantenDown && !isDiscard)) {
        continue;
      }
      candidates.push(tile);
    }
    return { candidates, riichi };
  }

  /**
   * Build the search subtree rooted at the draw node reached by discarding `discardTile`
   * from the 14-tile hand, and return it serialized. This reproduces exactly the candidate
   * draw node (and its descendants) that the monolithic discard-root build would have created
   * for that tile, allowing the work to be performed on a separate thread and later stitched
   * back in via {@link calc}'s `importedSubgraphs` option.
   */
  calcCandidateSubgraph(
    configInput: Config,
    round: Round,
    playerInput: Player,
    engine: MahjongAnalysisEngine,
    wallInput: Count | undefined,
    discardTile: number
  ): SerializedSubgraph {
    this.resetState();
    const config: Config = { ...configInput };
    this.referenceMode = config.calcMode === "reference";
    const player = clonePlayer(playerInput);
    const wall = wallInput
      ? cloneCount(wallInput)
      : this.createWall(round, playerInput, config.enableReddora);
    if (config.sum === 0) {
      config.sum = this.countBaseWallTiles(wall);
    }
    const handCounts = this.encode(player.hand, config.enableReddora);
    const wallCounts = this.encode(wall, config.enableReddora);
    const handOrigin = cloneCount(handCounts);
    const shantenOrigin = engine.calculateShanten(player.hand, player.melds.length, config.shantenType).shanten;
    let riichi = !this.referenceMode && config.enableRiichi && isClosed(player) && shantenOrigin <= 0;
    if (this.referenceMode) {
      // Mirror the root discard expansion: this candidate declares riichi when it is a
      // shanten-preserving discard from a closed tenpai hand.
      const rootDiscard = this.analyzeUnnecessaryMasks(engine, player.hand, player.melds.length, config.shantenType);
      const rootMask = this.extendMaskAnalysisWithRedFives(rootDiscard.maskLow, rootDiscard.maskHigh);
      riichi = config.enableRiichi && isClosed(player) && rootDiscard.shanten === 0
        && this.maskHasBits(rootMask.low, rootMask.high, discardTile);
    }
    const caches: CacheState = { draw: new Map(), discard: new Map() };

    this.discard(player, handCounts, wallCounts, discardTile);
    this.buildNodeGraph(
      config,
      round,
      player,
      engine,
      caches,
      handCounts,
      wallCounts,
      handOrigin,
      shantenOrigin,
      NodePhase.Draw,
      riichi
    );
    return this.exportInternalGraph();
  }

  /** Serialize the currently-built graph so it can be transferred to another thread. */
  exportInternalGraph(): SerializedSubgraph {
    const idToKey = new Map<NodeId, string>();
    const nodes: SerializedGraphNode[] = [];
    for (const node of this.allNodes()) {
      const key = this.nodeDedupKey(node);
      idToKey.set(node.id, key);
      nodes.push({
        key,
        phase: node.phase,
        handCounts: node.handCounts.slice(),
        wallCounts: node.wallCounts.slice(),
        forcedDiscardTile: node.forcedDiscardTile,
        shantenType: node.shantenType,
        shanten: node.shanten,
        riichi: node.riichi,
        originDistance: node.originDistance,
        allowTegawari: node.allowTegawari,
        allowShantenDown: node.allowShantenDown,
        actionMask: node.actionMask,
        actionMaskLow: node.actionMaskLow,
        actionMaskHigh: node.actionMaskHigh
      });
    }

    const edges: SerializedGraphEdge[] = [];
    for (let id = 1; id < this.edges.length; id += 1) {
      const edge = this.edges[this.asEdgeId(id)];
      if (!edge) {
        continue;
      }
      edges.push({
        sourceKey: idToKey.get(edge.sourceId)!,
        targetKey: idToKey.get(edge.targetId)!,
        tile: edge.tile,
        weight: edge.weight,
        score: edge.score,
        baseScore: edge.baseScore,
        uradoraHitProbability: edge.uradoraHitProbability,
        isWait: edge.isWait,
        isDiscard: edge.isDiscard,
        edgeKind: edge.edgeKind,
        riichiBefore: edge.riichiBefore,
        riichiAfter: edge.riichiAfter
      });
    }

    return { nodes, edges };
  }

  private nodeDedupKey(node: InternalSearchNode): string {
    return `${node.phase}:${this.createHandCacheKey(node.handCounts, node.riichi, node.forcedDiscardTile)}`;
  }

  /**
   * Merge pre-computed candidate sub-graphs into the (freshly reset) graph, de-duplicating
   * shared search states by their {@link nodeDedupKey}. After seeding, a discard-root build
   * reuses these nodes as cache hits rather than re-expanding them. Stat arrays are left at
   * their initial values; {@link calcStats} re-derives the induction over the merged graph.
   */
  private seedImportedGraph(config: Config, caches: CacheState, subgraphs: SerializedSubgraph[]): void {
    const keyToId = new Map<string, NodeId>();
    for (const subgraph of subgraphs) {
      for (const imported of subgraph.nodes) {
        if (keyToId.has(imported.key)) {
          continue;
        }
        const node = this.addNode(
          imported.phase,
          undefined,
          imported.handCounts,
          imported.wallCounts,
          {
            shantenType: imported.shantenType,
            shanten: imported.shanten,
            actionMask: imported.actionMask,
            actionMaskLow: imported.actionMaskLow,
            actionMaskHigh: imported.actionMaskHigh,
            allowTegawari: imported.allowTegawari,
            allowShantenDown: imported.allowShantenDown,
            forcedDiscardTile: imported.forcedDiscardTile
          },
          imported.riichi,
          config,
          imported.originDistance
        );
        keyToId.set(imported.key, node.id);
        const handKey = this.createHandCacheKey(imported.handCounts, imported.riichi, imported.forcedDiscardTile);
        if (imported.phase === NodePhase.Draw) {
          caches.draw.set(handKey, node.id);
        } else {
          caches.discard.set(handKey, node.id);
        }
      }
    }

    const seenEdges = new Set<string>();
    for (const subgraph of subgraphs) {
      for (const edge of subgraph.edges) {
        const sourceId = keyToId.get(edge.sourceKey);
        const targetId = keyToId.get(edge.targetKey);
        if (sourceId === undefined || targetId === undefined) {
          continue;
        }
        // Reference mode has one edge per vertex pair, and two sub-graphs may have
        // produced it from opposite ends (one as a draw, one as a discard) and so tagged
        // it with different kinds. De-duplicate on the pair alone there, matching
        // hasEdgeBetween; improved mode keeps both kinds as genuinely distinct edges.
        const edgeKey = this.referenceMode
          ? `${sourceId}|${targetId}`
          : `${sourceId}|${targetId}|${edge.tile}|${edge.edgeKind}`;
        if (seenEdges.has(edgeKey)) {
          continue;
        }
        seenEdges.add(edgeKey);
        this.addEdge(
          sourceId,
          targetId,
          edge.tile,
          edge.weight,
          edge.score,
          edge.baseScore,
          edge.uradoraHitProbability,
          edge.isWait,
          edge.isDiscard,
          edge.edgeKind,
          edge.riichiBefore,
          edge.riichiAfter
        );
      }
    }
  }

  private resetState(): void {
    this.nodes.length = 0;
    this.edges.length = 0;
    this.warnings.length = 0;
    this.drawTileAggregateCache.clear();
    this.drawCacheHits = 0;
    this.discardCacheHits = 0;
    this.nodeCounter = 0;
    this.edgeCounter = 0;
    this.drawNodeCounter = 0;
    this.discardNodeCounter = 0;
    this.lastSnapshotState = undefined;
  }

  createWall(round: Round, player: Player, enableReddora: boolean): Count {
    const wall = Array.from({ length: 37 }, () => 0);
    const melds = Array.from({ length: 37 }, () => 0);
    const indicators = Array.from({ length: 37 }, () => 0);

    for (const tile of round.doraIndicators) {
      indicators[toNoReddora(tile)] += 1;
      if (isReddora(tile)) {
        indicators[tile] += 1;
      }
    }

    for (const meld of player.melds) {
      for (const tile of meld.tiles) {
        melds[toNoReddora(tile)] += 1;
        if (isReddora(tile)) {
          melds[tile] += 1;
        }
      }
    }

    for (let i = 0; i < 34; i += 1) {
      wall[i] = 4 - (player.hand[i] + melds[i] + indicators[i]);
    }
    if (enableReddora) {
      for (let i = 34; i < 37; i += 1) {
        wall[i] = 1 - (player.hand[i] + melds[i] + indicators[i]);
      }
    }

    return wall;
  }

  private encode(counts: Count, enableReddora: boolean): CountRed {
    const encoded = Array.from({ length: 37 }, () => 0);
    for (let i = 0; i < 34; i += 1) {
      encoded[i] = counts[i];
    }
    if (enableReddora) {
      if (counts[Tile.RedManzu5]) {
        encoded[Tile.Manzu5] -= 1;
        encoded[Tile.RedManzu5] += 1;
      }
      if (counts[Tile.RedPinzu5]) {
        encoded[Tile.Pinzu5] -= 1;
        encoded[Tile.RedPinzu5] += 1;
      }
      if (counts[Tile.RedSouzu5]) {
        encoded[Tile.Souzu5] -= 1;
        encoded[Tile.RedSouzu5] += 1;
      }
    }
    return encoded;
  }

  private decodeForDisplay(counts: CountRed): Count {
    const decoded = cloneCount(counts);
    decoded[Tile.Manzu5] += decoded[Tile.RedManzu5];
    decoded[Tile.Pinzu5] += decoded[Tile.RedPinzu5];
    decoded[Tile.Souzu5] += decoded[Tile.RedSouzu5];
    return decoded;
  }

  private distance(hand: CountRed, origin: CountRed): number {
    let distance = 0;
    for (let i = 0; i < hand.length; i += 1) {
      distance += Math.max(hand[i] - origin[i], 0);
    }
    return distance;
  }

  private draw(player: Player, handCounts: CountRed, wallCounts: CountRed, tile: number): void {
    handCounts[tile] += 1;
    wallCounts[tile] -= 1;
    player.hand[tile] += 1;
    if (tile === Tile.RedManzu5) {
      player.hand[Tile.Manzu5] += 1;
    } else if (tile === Tile.RedPinzu5) {
      player.hand[Tile.Pinzu5] += 1;
    } else if (tile === Tile.RedSouzu5) {
      player.hand[Tile.Souzu5] += 1;
    }
  }

  private discard(player: Player, handCounts: CountRed, wallCounts: CountRed, tile: number): void {
    handCounts[tile] -= 1;
    wallCounts[tile] += 1;
    player.hand[tile] -= 1;
    if (tile === Tile.RedManzu5) {
      player.hand[Tile.Manzu5] -= 1;
    } else if (tile === Tile.RedPinzu5) {
      player.hand[Tile.Pinzu5] -= 1;
    } else if (tile === Tile.RedSouzu5) {
      player.hand[Tile.Souzu5] -= 1;
    }
  }

  private calcScore(config: Config, round: Round, player: Player, engine: MahjongAnalysisEngine, handCounts: CountRed, wallCounts: CountRed, shantenType: number, winTile: number, riichi: boolean): ScoreBreakdown {
    if (!engine.scoring) {
      return { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
    }

    const winFlag = riichi ? WinFlag.Tsumo | WinFlag.Riichi : WinFlag.Tsumo;
    const result = engine.scoring.calcFast(round, player, winTile, winFlag, shantenType);

    if (!result.success) {
      return { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
    }

    const baseScore = result.score[0] ?? 0;

    if (!config.enableUradora || (winFlag & WinFlag.Riichi) === 0 || round.doraIndicators.length === 0) {
      return { expectedScore: baseScore, baseScore, uradoraHitProbability: 0 };
    }

    if (result.scoreTitle >= ScoreTitle.CountedYakuman) {
      return { expectedScore: baseScore, baseScore, uradoraHitProbability: 0 };
    }

    const numIndicators = round.doraIndicators.length;
    const wall = cloneCount(wallCounts);
    wall[Tile.Manzu5] += wall[Tile.RedManzu5];
    wall[Tile.Pinzu5] += wall[Tile.RedPinzu5];
    wall[Tile.Souzu5] += wall[Tile.RedSouzu5];

    const handAndMelds = cloneCount(handCounts);
    handAndMelds[Tile.Manzu5] += handAndMelds[Tile.RedManzu5];
    handAndMelds[Tile.Pinzu5] += handAndMelds[Tile.RedPinzu5];
    handAndMelds[Tile.Souzu5] += handAndMelds[Tile.RedSouzu5];
    for (const meld of player.melds) {
      for (const tile of meld.tiles) {
        handAndMelds[toNoReddora(tile)] += 1;
      }
    }

    // The uradora indicators are drawn from the wall as it stands at the winning hand, so
    // the denominator is that wall's size, not the constant starting wall size.
    const wallSize = this.countBaseWallTiles(wall);

    if (numIndicators === 1) {
      // One indicator can add at most four han (four copies of the tile it points at),
      // so the 0..4 range is exhaustive here — no need for the full table below.
      const upScores = engine.scoring.getUpScores(round, player, result, winFlag, 4);
      const numIndicatorCounts = Array.from({ length: 5 }, () => 0);
      for (let tile = 0; tile < 34; tile += 1) {
        const count = handAndMelds[tile];
        numIndicatorCounts[count] += wall[TO_INDICATOR[tile]];
      }

      let score = 0;
      for (let i = 0; i <= 4; i += 1) {
        score += upScores[i] * (numIndicatorCounts[i] / wallSize);
      }
      const uradoraHitProbability = wallSize > 0 ? 1 - (numIndicatorCounts[0] / wallSize) : 0;
      return { expectedScore: score, baseScore, uradoraHitProbability };
    }

    // Ask for the whole 0..12 range the score table covers rather than trying to bound the
    // added han: the same indicator can be drawn several times, so a bound taken from the
    // top `numIndicators` per-indicator gains under-estimates (four copies of one indicator
    // beat the four largest distinct gains), and under-estimating silently clamps the
    // high-han scores. 12 is where the distribution saturates anyway.
    const upScores = engine.scoring.getUpScores(round, player, result, winFlag, 12);
    const distribution = this.exactUradoraDistribution(wall, handAndMelds, wallSize, numIndicators);
    let score = 0;
    let uradoraHitProbability = 0;
    for (const [addedHan, probability] of distribution.entries()) {
      score += (upScores[Math.min(addedHan, upScores.length - 1)] ?? upScores[upScores.length - 1] ?? 0) * probability;
      if (addedHan > 0) {
        uradoraHitProbability += probability;
      }
    }
    return { expectedScore: score, baseScore, uradoraHitProbability };
  }

  private buildNodeGraph(
    config: Config,
    round: Round,
    player: Player,
    engine: MahjongAnalysisEngine,
    caches: CacheState,
    handCounts: CountRed,
    wallCounts: CountRed,
    handOrigin: CountRed,
    shantenOrigin: number,
    rootPhase: NodePhase,
    riichi: boolean,
    forcedDiscardTile?: number
  ): NodeId {
    const context: BuildContext = {
      config,
      round,
      engine,
      caches,
      handOrigin,
      shantenOrigin,
      numMelds: player.melds.length,
      isClosed: isClosed(player),
      playerWind: player.wind,
      playerMelds: player.melds.map((meld) => ({
        type: meld.type,
        tiles: meld.tiles.slice(),
        discardedTile: meld.discardedTile,
        from: meld.from
      }))
    };
    const stack: BuildTask[] = [];
    const root = rootPhase === NodePhase.Draw
      ? this.ensureDrawNode(context, handCounts, wallCounts, riichi)
      : this.ensureDiscardNode(context, handCounts, wallCounts, riichi, forcedDiscardTile);

    if (root.isNew) {
      stack.push({
        phase: rootPhase,
        nodeId: root.nodeId,
        riichi,
        forcedDiscardTile
      });
    }

    while (stack.length > 0) {
      const task = stack.pop()!;
      if (task.phase === NodePhase.Draw) {
        if (this.referenceMode) {
          this.expandDrawNodeReference(context, task, stack);
        } else {
          this.expandDrawNode(context, task, stack);
        }
      } else if (this.referenceMode) {
        this.expandDiscardNodeReference(context, task, stack);
      } else {
        this.expandDiscardNode(context, task, stack);
      }
    }

    return root.nodeId;
  }

  private ensureDrawNode(context: BuildContext, handCounts: CountRed, wallCounts: CountRed, riichi: boolean): EnsureNodeResult {
    const key = this.createHandCacheKey(handCounts, riichi);
    const cachedId = context.caches.draw.get(key);
    if (cachedId !== undefined) {
      this.drawCacheHits += 1;
      return { nodeId: cachedId, isNew: false };
    }

    const hand = this.decodeForDisplay(handCounts);
    const analysis = this.analyzeNecessaryMasks(context.engine, hand, context.numMelds, context.config.shantenType);
    const waitMask = this.extendMaskAnalysisWithRedFives(analysis.maskLow, analysis.maskHigh);
    const originDistance = this.distance(handCounts, context.handOrigin);
    const allowTegawari = !riichi && context.config.enableTegawari && originDistance + analysis.shanten < context.shantenOrigin + context.config.extra;
    const node = this.addNode(NodePhase.Draw, undefined, handCounts, wallCounts, {
      shantenType: analysis.shantenType,
      shanten: analysis.shanten,
      actionMask: waitMask.bigintMask,
      actionMaskLow: waitMask.low,
      actionMaskHigh: waitMask.high,
      allowTegawari,
      allowShantenDown: false
    }, riichi, context.config, originDistance);
    context.caches.draw.set(key, node.id);
    return { nodeId: node.id, isNew: true };
  }

  private ensureDiscardNode(context: BuildContext, handCounts: CountRed, wallCounts: CountRed, riichi: boolean, forcedDiscardTile?: number): EnsureNodeResult {
    const key = this.createHandCacheKey(handCounts, riichi, forcedDiscardTile);
    const cachedId = context.caches.discard.get(key);
    if (cachedId !== undefined) {
      this.discardCacheHits += 1;
      return { nodeId: cachedId, isNew: false };
    }

    const hand = this.decodeForDisplay(handCounts);
    const analysis = this.analyzeUnnecessaryMasks(context.engine, hand, context.numMelds, context.config.shantenType);
    const discardMask = this.extendMaskAnalysisWithRedFives(analysis.maskLow, analysis.maskHigh);
    const originDistance = this.distance(handCounts, context.handOrigin);
    // Reference mode additionally refuses shanten-down under riichi (the hand is locked)
    // and for a completed hand, where the only legal discard is the tile just drawn.
    const allowShantenDown = context.config.enableShantenDown
      && (!this.referenceMode || (!riichi && analysis.shanten >= 0))
      && originDistance + analysis.shanten < context.shantenOrigin + context.config.extra;
    const node = this.addNode(NodePhase.Discard, undefined, handCounts, wallCounts, {
      shantenType: analysis.shantenType,
      shanten: analysis.shanten,
      actionMask: discardMask.bigintMask,
      actionMaskLow: discardMask.low,
      actionMaskHigh: discardMask.high,
      allowTegawari: false,
      allowShantenDown,
      forcedDiscardTile
    }, riichi, context.config, originDistance);
    context.caches.discard.set(key, node.id);
    return { nodeId: node.id, isNew: true };
  }

  private expandDrawNode(context: BuildContext, task: BuildTask, stack: BuildTask[]): void {
    const node = this.getNode(task.nodeId);
    if (!node) {
      return;
    }
    const handCounts = node.handCounts;
    const wallCounts = node.wallCounts;

    if (task.riichi && node.shanten === 0) {
      for (let tile = 0; tile < 37; tile += 1) {
        if (wallCounts[tile] <= 0 || !this.maskHasRuntime(node, tile)) {
          continue;
        }

        const weight = wallCounts[tile];
        const child = this.drawCounts(handCounts, wallCounts, tile);
        const childPlayer = this.createPlayerForState(context, child.handCounts);
        const scoreBreakdown = this.calcScore(
          context.config,
          context.round,
          childPlayer,
          context.engine,
          child.handCounts,
          child.wallCounts,
          node.shantenType,
          tile,
          true
        );
        if (scoreBreakdown.expectedScore <= 0) {
          continue;
        }

        this.addEdgeIfMissing(
          node.id,
          node.id,
          tile,
          weight,
          scoreBreakdown,
          true,
          false,
          EdgeKind.Chance,
          true,
          true
        );
      }
      return;
    }

    for (let tile = 0; tile < 37; tile += 1) {
      const isWait = this.maskHasRuntime(node, tile);
      if (wallCounts[tile] <= 0 || (!node.allowTegawari && !isWait)) {
        continue;
      }

      const weight = wallCounts[tile];
      const callRiichi = context.config.enableRiichi && context.isClosed && node.shanten === 1 && isWait ? true : task.riichi;
      let targetId: NodeId;
      let scoreBreakdown: ScoreBreakdown;

      if (task.riichi && !(node.shanten === 0 && isWait)) {
        const target = this.ensureDrawNode(context, handCounts, wallCounts, true);
        targetId = target.nodeId;
        scoreBreakdown = { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
      } else {
        const child = this.drawCounts(handCounts, wallCounts, tile);
        const target = this.ensureDiscardNode(context, child.handCounts, child.wallCounts, callRiichi, task.riichi ? tile : undefined);
        this.pushNodeTaskIfNew(stack, target, NodePhase.Discard, callRiichi, task.riichi ? tile : undefined);
        targetId = target.nodeId;
        if (node.shanten === 0 && isWait) {
          const childPlayer = this.createPlayerForState(context, child.handCounts);
          scoreBreakdown = this.calcScore(context.config, context.round, childPlayer, context.engine, child.handCounts, child.wallCounts, node.shantenType, tile, task.riichi);
        } else {
          scoreBreakdown = { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
        }
      }

      this.addEdgeIfMissing(
        node.id,
        targetId,
        tile,
        weight,
        scoreBreakdown,
        isWait,
        false,
        EdgeKind.Chance,
        task.riichi,
        callRiichi
      );
    }
  }

  private expandDiscardNode(context: BuildContext, task: BuildTask, stack: BuildTask[]): void {
    const node = this.getNode(task.nodeId);
    if (!node) {
      return;
    }
    const handCounts = node.handCounts;
    const wallCounts = node.wallCounts;

    for (let tile = 0; tile < 37; tile += 1) {
      const isDiscard = this.maskHasRuntime(node, tile);
      if (task.riichi && task.forcedDiscardTile !== undefined && tile !== task.forcedDiscardTile) {
        continue;
      }
      if (task.riichi && task.forcedDiscardTile === undefined && !isDiscard) {
        continue;
      }
      if (handCounts[tile] <= 0 || (!node.allowShantenDown && !isDiscard)) {
        continue;
      }

      const child = this.discardCounts(handCounts, wallCounts, tile);
      const weight = child.wallCounts[tile];
      const source = this.ensureDrawNode(context, child.handCounts, child.wallCounts, task.riichi);
      this.pushNodeTaskIfNew(stack, source, NodePhase.Draw, task.riichi);
      let scoreBreakdown: ScoreBreakdown;
      if (node.shanten === -1) {
        const player = this.createPlayerForState(context, handCounts);
        scoreBreakdown = this.calcScore(context.config, context.round, player, context.engine, handCounts, wallCounts, node.shantenType, tile, task.riichi);
      } else {
        scoreBreakdown = { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
      }

      this.addEdgeIfMissing(
        source.nodeId,
        node.id,
        tile,
        weight,
        scoreBreakdown,
        false,
        isDiscard,
        EdgeKind.Decision,
        task.riichi,
        task.riichi
      );
    }
  }

  /**
   * Reference-mode draw expansion — a port of `GraphBuilder::draw_node` in
   * mahjong-cpp's `expected_score_calculator.cpp`.
   *
   * Unlike {@link expandDrawNode}, a riichi hand is not special-cased here: riichi only
   * clears `allowTegawari`, which already restricts the loop to winning tiles once the
   * hand is tenpai. Every transition is a single draw → discard edge; the same edge is
   * read backwards by the target discard node as "discard this tile", so it is added at
   * most once per (source, target) pair no matter which expansion reaches it first.
   */
  private expandDrawNodeReference(context: BuildContext, task: BuildTask, stack: BuildTask[]): void {
    const node = this.getNode(task.nodeId);
    if (!node) {
      return;
    }
    const handCounts = node.handCounts;
    const wallCounts = node.wallCounts;

    for (let tile = 0; tile < 37; tile += 1) {
      const isWait = this.maskHasRuntime(node, tile);
      if (wallCounts[tile] <= 0 || (!node.allowTegawari && !isWait)) {
        continue;
      }

      const weight = wallCounts[tile];
      const child = this.drawCounts(handCounts, wallCounts, tile);
      const target = this.ensureDiscardNode(context, child.handCounts, child.wallCounts, task.riichi);
      this.pushNodeTaskIfNew(stack, target, NodePhase.Discard, task.riichi);
      if (this.hasEdgeBetween(node.id, target.nodeId)) {
        continue;
      }

      // Already tenpai before the draw, so a wait tile completes the hand: score it.
      const scoreBreakdown = node.shanten === 0 && isWait
        ? this.calcScore(
            context.config,
            context.round,
            this.createPlayerForState(context, child.handCounts),
            context.engine,
            child.handCounts,
            child.wallCounts,
            node.shantenType,
            tile,
            task.riichi
          )
        : { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };

      this.addEdgeIfMissing(
        node.id,
        target.nodeId,
        tile,
        weight,
        scoreBreakdown,
        isWait,
        false,
        EdgeKind.Chance,
        task.riichi,
        task.riichi
      );
    }
  }

  /**
   * Reference-mode discard expansion — a port of `GraphBuilder::discard_node` in
   * mahjong-cpp's `expected_score_calculator.cpp`.
   *
   * Riichi is declared here, on the discard itself, whenever a closed hand discards a
   * shanten-preserving tile from tenpai. A completed hand (shanten -1) has an empty
   * discard mask and no shanten-down, so it emits nothing: its win is scored on the
   * incoming draw edge, and the value of declining that tsumo is supplied by the source
   * tenpai node.
   */
  private expandDiscardNodeReference(context: BuildContext, task: BuildTask, stack: BuildTask[]): void {
    const node = this.getNode(task.nodeId);
    if (!node) {
      return;
    }
    const handCounts = node.handCounts;
    const wallCounts = node.wallCounts;

    for (let tile = 0; tile < 37; tile += 1) {
      const isDiscard = this.maskHasRuntime(node, tile);
      if (handCounts[tile] <= 0 || (!node.allowShantenDown && !isDiscard)) {
        continue;
      }

      const callRiichi = task.riichi
        || (context.config.enableRiichi && context.isClosed && node.shanten === 0 && isDiscard);
      const child = this.discardCounts(handCounts, wallCounts, tile);
      const weight = child.wallCounts[tile];
      const source = this.ensureDrawNode(context, child.handCounts, child.wallCounts, callRiichi);
      this.pushNodeTaskIfNew(stack, source, NodePhase.Draw, callRiichi);
      if (this.hasEdgeBetween(source.nodeId, node.id)) {
        continue;
      }

      const scoreBreakdown = node.shanten === -1
        ? this.calcScore(
            context.config,
            context.round,
            this.createPlayerForState(context, handCounts),
            context.engine,
            handCounts,
            wallCounts,
            node.shantenType,
            tile,
            task.riichi
          )
        : { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };

      this.addEdgeIfMissing(
        source.nodeId,
        node.id,
        tile,
        weight,
        scoreBreakdown,
        false,
        isDiscard,
        EdgeKind.Decision,
        task.riichi,
        callRiichi
      );
    }
  }

  /**
   * Reference-mode edge de-duplication, matching mahjong-cpp's `Graph::has_edge`, which
   * keys on the vertex pair alone. Tile identity is implied: the target hand is the
   * source hand plus exactly one tile, so a (source, target) pair fixes the tile.
   */
  private hasEdgeBetween(sourceId: NodeId, targetId: NodeId): boolean {
    for (const edgeId of this.getNode(sourceId)?.outgoingEdgeIds ?? []) {
      if (this.getEdge(edgeId)?.targetId === targetId) {
        return true;
      }
    }
    return false;
  }

  private drawCounts(handState: CountRed, wallState: CountRed, tile: number): { handCounts: CountRed; wallCounts: CountRed } {
    const handCounts = cloneCount(handState);
    const wallCounts = cloneCount(wallState);
    handCounts[tile] += 1;
    wallCounts[tile] -= 1;
    return { handCounts, wallCounts };
  }

  private discardCounts(handState: CountRed, wallState: CountRed, tile: number): { handCounts: CountRed; wallCounts: CountRed } {
    const handCounts = cloneCount(handState);
    const wallCounts = cloneCount(wallState);
    handCounts[tile] -= 1;
    wallCounts[tile] += 1;
    return { handCounts, wallCounts };
  }

  private pushNodeTaskIfNew(
    stack: BuildTask[],
    result: EnsureNodeResult,
    phase: NodePhase,
    riichi: boolean,
    forcedDiscardTile?: number
  ): void {
    if (!result.isNew) {
      return;
    }
    stack.push({
      phase,
      nodeId: result.nodeId,
      riichi,
      forcedDiscardTile
    });
  }

  private addEdgeIfMissing(
    sourceId: NodeId,
    targetId: NodeId,
    tile: number,
    weight: number,
    scoreBreakdown: ScoreBreakdown,
    isWait: boolean,
    isDiscard: boolean,
    edgeKind: EdgeKind,
    riichiBefore: boolean,
    riichiAfter: boolean
  ): void {
    this.addEdge(
      sourceId,
      targetId,
      tile,
      weight,
      scoreBreakdown.expectedScore,
      scoreBreakdown.baseScore,
      scoreBreakdown.uradoraHitProbability,
      isWait,
      isDiscard,
      edgeKind,
      riichiBefore,
      riichiAfter
    );
  }

  private calcStats(config: Config): void {
    if (this.referenceMode) {
      this.calcStatsReference(config);
      return;
    }

    const allNodes = this.allNodes();
    const drawNodes = allNodes.filter((node) => node.phase === NodePhase.Draw);
    const discardNodes = allNodes.filter((node) => node.phase === NodePhase.Discard);

    for (let turn = config.tMax; turn >= config.tMin; turn -= 1) {
      if (turn < config.tMax) {
        for (const node of drawNodes) {
          const previousTenpai = node.tenpaiProb[turn + 1];
          const previousWin = node.winProb[turn + 1];
          const previousExpScore = node.expScore[turn + 1];
          const denominator = config.sum - turn;
          let tenpaiAccum = 0;
          let winAccum = 0;
          let expAccum = 0;

          for (const edgeId of node.outgoingEdgeIds) {
            const edge = this.getEdge(edgeId)!;
            if (edge.edgeKind !== EdgeKind.Chance) {
              continue;
            }
            const target = this.getNode(edge.targetId)!;
            // A winning draw (tenpai node + winning tile) reaches an agari state
            // with win probability 1. In riichi mode the win is modeled as a
            // self-loop chance edge rather than a transition to a shanten === -1
            // node, so the target's own winProb is not 1 — read the win directly.
            const targetWin = node.shanten === 0 && edge.isWait ? 1 : target.winProb[turn + 1];
            tenpaiAccum += edge.weight * (target.tenpaiProb[turn + 1] - previousTenpai);
            winAccum += edge.weight * (targetWin - previousWin);
            expAccum += edge.weight * (Math.max(edge.score, target.expScore[turn + 1]) - previousExpScore);
          }

          node.tenpaiProb[turn] = previousTenpai + (denominator > 0 ? tenpaiAccum / denominator : 0);
          node.winProb[turn] = previousWin + (denominator > 0 ? winAccum / denominator : 0);
          node.expScore[turn] = previousExpScore + (denominator > 0 ? expAccum / denominator : 0);
        }
      }

      for (const node of discardNodes) {
        if (node.riichi && node.forcedDiscardTile !== undefined && node.shanten !== -1) {
          const sourceId = this.forcedSourceNodeId(node);
          const source = sourceId !== undefined ? this.getNode(sourceId) : undefined;
          node.tenpaiProb[turn] = source?.tenpaiProb[turn] ?? 0;
          node.winProb[turn] = source?.winProb[turn] ?? 0;
          node.expScore[turn] = source?.expScore[turn] ?? 0;
          continue;
        }

        let bestTenpai = node.tenpaiProb[turn];
        let bestWin = node.winProb[turn];
        let bestExpScore = node.expScore[turn];
        let bestTenpaiTile: number | undefined;
        let bestWinTile: number | undefined;
        let bestExpScoreTile: number | undefined;

        for (const edgeId of node.incomingEdgeIds) {
          const edge = this.getEdge(edgeId)!;
          if (edge.edgeKind !== EdgeKind.Decision) {
            continue;
          }
          const source = this.getNode(edge.sourceId)!;
          if (source.tenpaiProb[turn] > bestTenpai) {
            bestTenpai = source.tenpaiProb[turn];
            bestTenpaiTile = edge.tile;
          }
          if (source.winProb[turn] > bestWin) {
            bestWin = source.winProb[turn];
            bestWinTile = edge.tile;
          }
          if (source.expScore[turn] > bestExpScore) {
            bestExpScore = source.expScore[turn];
            bestExpScoreTile = edge.tile;
          }
        }

        node.tenpaiProb[turn] = bestTenpai;
        node.winProb[turn] = bestWin;
        node.expScore[turn] = bestExpScore;
      }
    }
  }

  /**
   * Reference-mode backward induction — a port of `ExpectedScoreCalculator::calc_stats`.
   *
   * Draw nodes average over their outgoing draw edges; an edge whose score is positive is
   * an agari, so it contributes certainty (tenpai and win probability 1) and at least its
   * score. Discard nodes take the best value over the draw nodes feeding them, from a
   * floor of zero. A completed hand emits no discard edges, so its only incoming edge is
   * the scored draw that produced it: it inherits that tenpai hand's value, which is what
   * makes `max(edge.score, target.expScore)` read as "take the tsumo, or decline it and
   * keep waiting on this hand".
   */
  private calcStatsReference(config: Config): void {
    const allNodes = this.allNodes();
    const drawNodes = allNodes.filter((node) => node.phase === NodePhase.Draw);
    const discardNodes = allNodes.filter((node) => node.phase === NodePhase.Discard);

    for (let turn = config.tMax; turn >= config.tMin; turn -= 1) {
      // At tMax there is no draw left; a tenpai draw node keeps the tenpai flag it was
      // seeded with in createNodeStatArrays and everything else stays zero.
      if (turn < config.tMax) {
        for (const node of drawNodes) {
          const previousTenpai = node.tenpaiProb[turn + 1];
          const previousWin = node.winProb[turn + 1];
          const previousExpScore = node.expScore[turn + 1];
          const denominator = config.sum - turn;
          let tenpaiAccum = 0;
          let winAccum = 0;
          let expAccum = 0;

          for (const edgeId of node.outgoingEdgeIds) {
            const edge = this.getEdge(edgeId)!;
            const target = this.getNode(edge.targetId)!;
            let tenpai = target.tenpaiProb[turn + 1];
            let win = target.winProb[turn + 1];
            let expScore = target.expScore[turn + 1];
            if (edge.score > 0) {
              tenpai = 1;
              win = 1;
              expScore = Math.max(edge.score, expScore);
            }
            tenpaiAccum += edge.weight * (tenpai - previousTenpai);
            winAccum += edge.weight * (win - previousWin);
            expAccum += edge.weight * (expScore - previousExpScore);
          }

          node.tenpaiProb[turn] = node.shanten === 0
            ? 1
            : previousTenpai + (denominator > 0 ? tenpaiAccum / denominator : 0);
          node.winProb[turn] = previousWin + (denominator > 0 ? winAccum / denominator : 0);
          node.expScore[turn] = previousExpScore + (denominator > 0 ? expAccum / denominator : 0);
        }
      }

      for (const node of discardNodes) {
        let bestTenpai = 0;
        let bestWin = 0;
        let bestExpScore = 0;

        for (const edgeId of node.incomingEdgeIds) {
          const edge = this.getEdge(edgeId)!;
          const source = this.getNode(edge.sourceId)!;
          if (source.tenpaiProb[turn] > bestTenpai) {
            bestTenpai = source.tenpaiProb[turn];
          }
          if (source.winProb[turn] > bestWin) {
            bestWin = source.winProb[turn];
          }
          if (source.expScore[turn] > bestExpScore) {
            bestExpScore = source.expScore[turn];
          }
        }

        node.tenpaiProb[turn] = bestTenpai;
        node.winProb[turn] = bestWin;
        node.expScore[turn] = bestExpScore;
      }
    }
  }

  private getNecessaryTiles(config: Config, player: Player, wall: Count, engine: MahjongAnalysisEngine): { shanten: number; necessaryTiles: Array<[number, number]> } {
    const analysis = engine.analyzeNecessary(player.hand, player.melds.length, config.shantenType);
    return {
      shanten: analysis.shanten,
      necessaryTiles: analysis.tiles.map((tile) => [tile, wall[tile]] as [number, number])
    };
  }

  private createHandCacheKey(hand: CountRed, riichi: boolean, forcedDiscardTile?: number): string {
    let manzu = 0;
    let pinzu = 0;
    let souzu = 0;
    let honors = 0;
    for (let tile = 0; tile < 9; tile += 1) {
      manzu = manzu * 8 + hand[tile];
      pinzu = pinzu * 8 + hand[tile + 9];
      souzu = souzu * 8 + hand[tile + 18];
    }
    for (let tile = 27; tile < 34; tile += 1) {
      honors = honors * 8 + hand[tile];
    }
    honors += hand[Tile.RedManzu5] * 2097152 + hand[Tile.RedPinzu5] * 4194304 + hand[Tile.RedSouzu5] * 8388608;
    return `${manzu}|${pinzu}|${souzu}|${honors}|${riichi ? 1 : 0}|${forcedDiscardTile ?? 63}`;
  }

  private createStateKey(hand: CountRed, wall: CountRed, riichi: boolean, forcedDiscardTile?: number): CacheKey {
    const handKey = this.packCounts(hand);
    const wallKey = this.packCounts(wall);
    const forced = BigInt((forcedDiscardTile ?? 63) & 63);
    return this.asCacheKey(handKey | (wallKey << COUNT_PACK_BITS) | (BigInt(riichi ? 1 : 0) << (COUNT_PACK_BITS * 2n)) | (forced << (COUNT_PACK_BITS * 2n + 1n)));
  }

  private packCounts(counts: CountRed): CacheKey {
    let packed = 0n;
    for (let tile = 0; tile < 37; tile += 1) {
      packed |= BigInt(counts[tile] & 7) << BigInt(tile * 3);
    }
    return this.asCacheKey(packed);
  }

  private unpackCounts(packed: CacheKey): Count {
    const counts = Array.from({ length: 37 }, () => 0);
    for (let tile = 0; tile < 37; tile += 1) {
      counts[tile] = Number((packed >> BigInt(tile * 3)) & 7n);
    }
    return counts;
  }

  private unpackEncodedHandFromStateKey(stateKey: CacheKey): CountRed {
    return this.unpackCounts(this.asCacheKey(stateKey & COUNT_PACK_MASK));
  }

  private unpackEncodedWallFromStateKey(stateKey: CacheKey): CountRed {
    return this.unpackCounts(this.asCacheKey((stateKey >> COUNT_PACK_BITS) & COUNT_PACK_MASK));
  }

  private unpackHandFromStateKey(stateKey: CacheKey): Count {
    return this.decodeForDisplay(this.unpackEncodedHandFromStateKey(stateKey));
  }

  private unpackWallFromStateKey(stateKey: CacheKey): Count {
    return this.decodeForDisplay(this.unpackEncodedWallFromStateKey(stateKey));
  }

  private createPlayerForState(context: BuildContext, handCounts: CountRed): Player {
    return {
      hand: this.decodeForDisplay(handCounts),
      melds: context.playerMelds.map((meld) => ({
        type: meld.type,
        tiles: meld.tiles.slice(),
        discardedTile: meld.discardedTile,
        from: meld.from
      })),
      wind: context.playerWind
    };
  }

  private countBaseWallTiles(wallCounts: Count): number {
    let total = 0;
    for (let tile = 0; tile < 34; tile += 1) {
      total += wallCounts[tile];
    }
    return total;
  }

  private countEncodedWallTiles(wallCounts: CountRed): number {
    let total = 0;
    for (let tile = 0; tile < 37; tile += 1) {
      total += wallCounts[tile];
    }
    return total;
  }

  private drawTileAggregateCacheKey(nodeId: NodeId, turn: number, config: Config): number {
    return nodeId * (config.tMax + 1) + turn;
  }

  private asNodeId(value: number): NodeId {
    return value as NodeId;
  }

  private asEdgeId(value: number): EdgeId {
    return value as EdgeId;
  }

  private asCacheKey(value: bigint): CacheKey {
    return value as CacheKey;
  }

  private getNode(id: NodeId): InternalSearchNode | undefined {
    return this.nodes[id];
  }

  private getEdge(id: EdgeId): InternalSearchEdge | undefined {
    return this.edges[id];
  }

  private getNodeStateKey(node: InternalSearchNode): CacheKey {
    node.stateKey ??= this.createStateKey(node.handCounts, node.wallCounts, node.riichi, node.forcedDiscardTile);
    return node.stateKey;
  }

  private cloneStats(stats: Stat[]): Stat[] {
    return stats.map((stat) => ({
      ...stat,
      tenpaiProb: stat.tenpaiProb.slice(),
      winProb: stat.winProb.slice(),
      expScore: stat.expScore.slice(),
      necessaryTiles: stat.necessaryTiles.map(([tile, count]) => [tile, count] as [number, number])
    }));
  }

  private allNodes(): InternalSearchNode[] {
    const nodes: InternalSearchNode[] = [];
    for (let id = 1; id < this.nodes.length; id += 1) {
      const node = this.nodes[this.asNodeId(id)];
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  private analyzeNecessaryMasks(engine: MahjongAnalysisEngine, hand: Count, numMelds: number, type: number): MaskTileAnalysis {
    const maskEngine = engine as MaskAnalysisEngine;
    if (maskEngine.analyzeNecessaryMasks) {
      return maskEngine.analyzeNecessaryMasks(hand, numMelds, type);
    }
    const analysis = engine.analyzeNecessary(hand, numMelds, type);
    const masks = this.tilesToMasks(analysis.tiles);
    return { shantenType: analysis.shantenType, shanten: analysis.shanten, maskLow: masks.low, maskHigh: masks.high };
  }

  private analyzeUnnecessaryMasks(engine: MahjongAnalysisEngine, hand: Count, numMelds: number, type: number): MaskTileAnalysis {
    const maskEngine = engine as MaskAnalysisEngine;
    if (maskEngine.analyzeUnnecessaryMasks) {
      return maskEngine.analyzeUnnecessaryMasks(hand, numMelds, type);
    }
    const analysis = engine.analyzeUnnecessary(hand, numMelds, type);
    const masks = this.tilesToMasks(analysis.tiles);
    return { shantenType: analysis.shantenType, shanten: analysis.shanten, maskLow: masks.low, maskHigh: masks.high };
  }

  private extendMaskAnalysisWithRedFives(maskLow: number, maskHigh: number): { bigintMask: bigint; low: number; high: number } {
    let high = maskHigh;
    if ((maskLow & (1 << Tile.Manzu5)) !== 0) {
      high |= 1 << (Tile.RedManzu5 - 27);
    }
    if ((maskLow & (1 << Tile.Pinzu5)) !== 0) {
      high |= 1 << (Tile.RedPinzu5 - 27);
    }
    if ((maskLow & (1 << Tile.Souzu5)) !== 0) {
      high |= 1 << (Tile.RedSouzu5 - 27);
    }
    return {
      bigintMask: BigInt(maskLow) | (BigInt(high) << 27n),
      low: maskLow,
      high
    };
  }

  private tilesToMasks(tiles: number[]): { bigintMask: bigint; low: number; high: number } {
    let bigintMask = 0n;
    let low = 0;
    let high = 0;
    for (const tile of tiles) {
      bigintMask = addTileToMask(bigintMask, tile);
      if (tile < 27) {
        low |= 1 << tile;
      } else {
        high |= 1 << (tile - 27);
      }
    }
    return { bigintMask, low, high };
  }

  private extendMasksWithRedFives(masks: { bigintMask: bigint; low: number; high: number }): { bigintMask: bigint; low: number; high: number } {
    let { bigintMask, low, high } = masks;
    if ((low & (1 << Tile.Manzu5)) !== 0) {
      bigintMask = addTileToMask(bigintMask, Tile.RedManzu5);
      high |= 1 << (Tile.RedManzu5 - 27);
    }
    if ((low & (1 << Tile.Pinzu5)) !== 0) {
      bigintMask = addTileToMask(bigintMask, Tile.RedPinzu5);
      high |= 1 << (Tile.RedPinzu5 - 27);
    }
    if ((low & (1 << Tile.Souzu5)) !== 0) {
      bigintMask = addTileToMask(bigintMask, Tile.RedSouzu5);
      high |= 1 << (Tile.RedSouzu5 - 27);
    }
    return { bigintMask, low, high };
  }

  private maskHasRuntime(node: InternalSearchNode, tile: number): boolean {
    return this.maskHasBits(node.actionMaskLow, node.actionMaskHigh, tile);
  }

  private maskHasBits(maskLow: number, maskHigh: number, tile: number): boolean {
    if (tile < 27) {
      return (maskLow & (1 << tile)) !== 0;
    }
    return (maskHigh & (1 << (tile - 27))) !== 0;
  }

  /**
   * In reference mode a single edge set does double duty: every edge runs from a draw
   * node to a discard node, read forwards as a draw and backwards as a discard. The
   * traversal direction alone identifies the role, so no edge is ever filtered out.
   */
  private isChanceEdge(edge: InternalSearchEdge | undefined): boolean {
    return edge !== undefined && (this.referenceMode || edge.edgeKind === EdgeKind.Chance);
  }

  private isDecisionEdge(edge: InternalSearchEdge | undefined): boolean {
    return edge !== undefined && (this.referenceMode || edge.edgeKind === EdgeKind.Decision);
  }

  private addNode(phase: NodePhase, stateKey: CacheKey | undefined, handCounts: CountRed, wallCounts: CountRed, info: NodeBuildInfo, riichi: boolean, config: Config, originDistance: number): InternalSearchNode {
    const id = this.asNodeId(this.nodeCounter += 1);
    if (phase === NodePhase.Draw) {
      this.drawNodeCounter += 1;
    } else {
      this.discardNodeCounter += 1;
    }
    const { tenpaiProb, winProb, expScore } = this.createNodeStatArrays(phase, info.shanten, config);

    const node: InternalSearchNode = {
      id,
      phase,
      stateKey,
      wallSize: this.countEncodedWallTiles(wallCounts),
      forcedDiscardTile: info.forcedDiscardTile,
      shantenType: info.shantenType,
      shanten: info.shanten,
      riichi,
      originDistance,
      allowTegawari: info.allowTegawari,
      allowShantenDown: info.allowShantenDown,
      actionMask: info.actionMask,
      actionMaskLow: info.actionMaskLow,
      actionMaskHigh: info.actionMaskHigh,
      handCounts: cloneCount(handCounts),
      wallCounts: cloneCount(wallCounts),
      outgoingEdgeIds: [],
      incomingEdgeIds: [],
      tenpaiProb,
      winProb,
      expScore
    };
    this.nodes[id] = node;
    return node;
  }

  private createNodeStatArrays(phase: NodePhase, shanten: number, config: Config): { tenpaiProb: Float64Array; winProb: Float64Array; expScore: Float64Array } {
    const length = config.tMax + 1;
    // mahjong-cpp seeds every vertex at zero and lets calc_stats derive discard-node
    // values purely from their sources, so reference mode skips the discard prefills.
    if (this.referenceMode) {
      const drawTenpai = phase === NodePhase.Draw && shanten === 0;
      if (!config.calcStats) {
        return {
          tenpaiProb: this.sharedStatArray(length, drawTenpai ? "draw-tenpai" : "zero"),
          winProb: this.sharedStatArray(length, "zero"),
          expScore: this.sharedStatArray(length, "zero")
        };
      }
      const tenpaiProb = new Float64Array(length);
      if (drawTenpai) {
        tenpaiProb[config.tMax] = 1;
      }
      return { tenpaiProb, winProb: new Float64Array(length), expScore: new Float64Array(length) };
    }

    if (!config.calcStats) {
      return {
        tenpaiProb: phase === NodePhase.Discard && shanten === 0
          ? this.sharedStatArray(length, "ones")
          : phase === NodePhase.Draw && shanten === 0
            ? this.sharedStatArray(length, "draw-tenpai")
            : this.sharedStatArray(length, "zero"),
        winProb: phase === NodePhase.Discard && shanten === -1
          ? this.sharedStatArray(length, "ones")
          : this.sharedStatArray(length, "zero"),
        expScore: this.sharedStatArray(length, "zero")
      };
    }

    const tenpaiProb = new Float64Array(length);
    const winProb = new Float64Array(length);
    const expScore = new Float64Array(length);
    if (phase === NodePhase.Discard && shanten === 0) {
      tenpaiProb.fill(1);
    }
    if (phase === NodePhase.Discard && shanten === -1) {
      winProb.fill(1);
    }
    if (phase === NodePhase.Draw) {
      tenpaiProb[config.tMax] = shanten === 0 ? 1 : 0;
    }
    return { tenpaiProb, winProb, expScore };
  }

  private sharedStatArray(length: number, kind: "zero" | "ones" | "draw-tenpai"): Float64Array {
    const key = `${kind}:${length}`;
    let array = this.sharedStatArrays.get(key);
    if (!array) {
      array = new Float64Array(length);
      if (kind === "ones") {
        array.fill(1);
      } else if (kind === "draw-tenpai") {
        array[length - 1] = 1;
      }
      this.sharedStatArrays.set(key, array);
    }
    return array;
  }

  private addEdge(
    sourceId: NodeId,
    targetId: NodeId,
    tile: number,
    weight: number,
    score: number,
    baseScore: number,
    uradoraHitProbability: number,
    isWait: boolean,
    isDiscard: boolean,
    edgeKind: EdgeKind,
    riichiBefore: boolean,
    riichiAfter: boolean
  ): void {
    const id = this.asEdgeId(this.edgeCounter += 1);
    const edge: InternalSearchEdge = {
      id,
      sourceId,
      targetId,
      tile,
      weight,
      score,
      baseScore,
      uradoraHitProbability,
      isWait,
      isDiscard,
      edgeKind,
      riichiBefore,
      riichiAfter
    };
    this.edges[id] = edge;
    this.getNode(sourceId)!.outgoingEdgeIds.push(id);
    this.getNode(targetId)!.incomingEdgeIds.push(id);
  }

  private findEdge(sourceId: NodeId, targetId: NodeId, tile: number, edgeKind: EdgeKind): EdgeId | undefined {
    for (const edgeId of this.getNode(sourceId)?.outgoingEdgeIds ?? []) {
      const edge = this.getEdge(edgeId);
      if (edge && edge.targetId === targetId && edge.tile === tile && edge.edgeKind === edgeKind) {
        return edgeId;
      }
    }
    return undefined;
  }

  private pushWarning(message: string): void {
    if (!this.warnings.includes(message)) {
      this.warnings.push(message);
    }
  }

  private createGraphSnapshot(
    config: Config,
    rootNodeId: NodeId,
    rootPhase: NodePhase,
    depthLimit: number
  ): { nodes: SearchNode[]; edges: SearchEdge[] } {
    const queue: Array<{ nodeId: NodeId; depth: number }> = [{ nodeId: rootNodeId, depth: 0 }];
    const visited = new Set<NodeId>();
    const nodeOrder: NodeId[] = [];
    const includedEdges = new Set<EdgeId>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.nodeId)) {
        continue;
      }
      visited.add(current.nodeId);
      nodeOrder.push(current.nodeId);
      if (current.depth >= depthLimit) {
        continue;
      }

      const node = this.getNode(current.nodeId);
      if (!node) {
        continue;
      }
      const branchEdgeIds = node.phase === NodePhase.Draw
        ? node.outgoingEdgeIds.filter((edgeId) => this.isChanceEdge(this.getEdge(edgeId)))
        : node.incomingEdgeIds.filter((edgeId) => this.isDecisionEdge(this.getEdge(edgeId)));
      branchEdgeIds.forEach((edgeId) => {
        const edge = this.getEdge(edgeId);
        if (!edge) {
          return;
        }
        includedEdges.add(edgeId);
        const nextId = node.phase === NodePhase.Draw ? edge.targetId : edge.sourceId;
        if (!visited.has(nextId)) {
          queue.push({ nodeId: nextId, depth: current.depth + 1 });
        }
      });
    }

    const internalEdges = Array.from(includedEdges)
      .map((edgeId) => this.getEdge(edgeId))
      .filter((edge): edge is InternalSearchEdge => Boolean(edge))
      .filter((edge) => visited.has(edge.sourceId) && visited.has(edge.targetId));
    const edges = internalEdges.map((edge) => ({ ...edge }));

    const includedEdgeIds = new Set(internalEdges.map((edge) => edge.id));
    const nodes = nodeOrder
      .map((nodeId) => this.getNode(nodeId))
      .filter((node): node is InternalSearchNode => Boolean(node))
      .map((node) => {
        const stateKey = this.getNodeStateKey(node);
        const outgoingEdgeIds = node.outgoingEdgeIds
          .filter((edgeId) => includedEdgeIds.has(edgeId));
        const incomingEdgeIds = node.incomingEdgeIds
          .filter((edgeId) => includedEdgeIds.has(edgeId));
        return {
          id: node.id,
          phase: node.phase,
          cacheKey: stateKey,
          hand: this.decodeForDisplay(node.handCounts),
          wall: this.decodeForDisplay(node.wallCounts),
          forcedDiscardTile: node.forcedDiscardTile,
          shantenType: node.shantenType,
          shanten: node.shanten,
          riichi: node.riichi,
          originDistance: node.originDistance,
          allowTegawari: node.allowTegawari,
          allowShantenDown: node.allowShantenDown,
          actionMask: node.actionMask,
          actionMaskLow: node.actionMaskLow,
          actionMaskHigh: node.actionMaskHigh,
          outgoingEdgeIds,
          incomingEdgeIds,
          tenpaiProb: Array.from(node.tenpaiProb),
          winProb: Array.from(node.winProb),
          expScore: Array.from(node.expScore),
          turnBreakdowns: this.buildTurnBreakdowns(node, config)
        };
      });

    return { nodes, edges };
  }

  private buildTurnBreakdowns(node: InternalSearchNode, config: Config): NodeTurnBreakdown[] {
    const breakdowns: NodeTurnBreakdown[] = [];

    if (node.phase === NodePhase.Draw) {
      breakdowns.push({
        turn: config.tMax,
        remainingWallTiles: config.sum - config.tMax,
        tenpai: node.tenpaiProb[config.tMax] ?? 0,
        win: node.winProb[config.tMax] ?? 0,
        expScore: node.expScore[config.tMax] ?? 0,
        chanceBranches: []
      });

      for (let turn = config.tMax - 1; turn >= config.tMin; turn -= 1) {
        const previousTenpai = node.tenpaiProb[turn + 1] ?? 0;
        const previousWin = node.winProb[turn + 1] ?? 0;
        const previousExpScore = node.expScore[turn + 1] ?? 0;
        const denominator = config.sum - turn;
        const chanceBranches = node.outgoingEdgeIds
          .filter((edgeId) => this.isChanceEdge(this.getEdge(edgeId)))
          .map((edgeId) => {
            const edge = this.getEdge(edgeId)!;
            const target = this.getNode(edge.targetId)!;
            const realizedExpScore = Math.max(edge.score, target.expScore[turn + 1] ?? 0);
            // A winning draw reaches an agari state (tenpai and win probability 1).
            // Improved mode models it as a self-loop edge and reference mode as an edge
            // into an unreachable completed-hand node, so in neither case does the
            // target's own probability say 1 — read it off the edge instead. Mirrors the
            // inductions in calcStats() / calcStatsReference().
            const isAgari = this.referenceMode
              ? edge.score > 0
              : node.shanten === 0 && edge.isWait;
            const targetWin = isAgari ? 1 : (target.winProb[turn + 1] ?? 0);
            const targetTenpai = this.referenceMode && isAgari ? 1 : (target.tenpaiProb[turn + 1] ?? 0);
            return {
              tile: edge.tile,
              targetNodeId: target.id,
              weight: edge.weight,
              probability: denominator > 0 ? edge.weight / denominator : 0,
              immediateScore: edge.score,
              baseScore: edge.baseScore,
              uradoraHitProbability: edge.uradoraHitProbability,
              targetTenpai,
              targetWin,
              targetExpScore: target.expScore[turn + 1] ?? 0,
              contributionTenpai: denominator > 0 ? edge.weight * (targetTenpai - previousTenpai) / denominator : 0,
              contributionWin: denominator > 0 ? edge.weight * (targetWin - previousWin) / denominator : 0,
              contributionExpScore: denominator > 0 ? edge.weight * (realizedExpScore - previousExpScore) / denominator : 0,
              realizedExpScore
            };
          });
        breakdowns.push({
          turn,
          remainingWallTiles: denominator,
          tenpai: node.tenpaiProb[turn] ?? 0,
          win: node.winProb[turn] ?? 0,
          expScore: node.expScore[turn] ?? 0,
          chanceBranches,
          tileBreakdowns: this.aggregateDrawTiles(node.id, turn, config)
        });
      }

      return breakdowns.sort((left, right) => left.turn - right.turn);
    }

    for (let turn = config.tMax; turn >= config.tMin; turn -= 1) {
      let bestTenpaiTile: number | undefined;
      let bestWinTile: number | undefined;
      let bestExpScoreTile: number | undefined;
      let bestTenpai = node.tenpaiProb[turn] ?? 0;
      let bestWin = node.winProb[turn] ?? 0;
      let bestExpScore = node.expScore[turn] ?? 0;
      const decisionBranches = node.incomingEdgeIds
        .filter((edgeId) => this.isDecisionEdge(this.getEdge(edgeId)))
        .map((edgeId) => {
          const edge = this.getEdge(edgeId)!;
          const source = this.getNode(edge.sourceId)!;
          const tenpai = source.tenpaiProb[turn] ?? 0;
          const win = source.winProb[turn] ?? 0;
          const expScore = source.expScore[turn] ?? 0;

          if (tenpai > bestTenpai) {
            bestTenpai = tenpai;
            bestTenpaiTile = edge.tile;
          }
          if (win > bestWin) {
            bestWin = win;
            bestWinTile = edge.tile;
          }
          if (expScore > bestExpScore) {
            bestExpScore = expScore;
            bestExpScoreTile = edge.tile;
          }

          return {
            tile: edge.tile,
            sourceNodeId: source.id,
            tenpai,
            win,
            expScore
          };
        });

      breakdowns.push({
        turn,
        remainingWallTiles: config.sum - turn,
        tenpai: node.tenpaiProb[turn] ?? 0,
        win: node.winProb[turn] ?? 0,
        expScore: node.expScore[turn] ?? 0,
        decisionBranches,
        bestTenpaiTile,
        bestWinTile,
        bestExpScoreTile
      });
    }

    return breakdowns.sort((left, right) => left.turn - right.turn);
  }

  private aggregateDrawTiles(nodeId: NodeId, turn: number, config: Config): TileBreakdown[] {
    return this.aggregateDrawTilesInternal(nodeId, turn, config).map((entry) => ({ ...entry }));
  }

  private aggregateDrawTilesInternal(nodeId: NodeId, turn: number, config: Config): InternalTileBreakdown[] {
    const cacheKey = this.drawTileAggregateCacheKey(nodeId, turn, config);
    const cached = this.drawTileAggregateCache.get(cacheKey);
    if (cached) {
      return cached.map((entry) => ({ ...entry }));
    }

    const node = this.getNode(nodeId);
    if (!node || node.phase !== NodePhase.Draw || turn >= config.tMax) {
      return [];
    }

    const denominator = config.sum - turn;
    if (denominator <= 0) {
      return [];
    }

    const aggregates = new Map<number, InternalDrawTileAggregate>();
    let totalBranchWeight = 0;
    for (const edgeId of node.outgoingEdgeIds) {
      const edge = this.getEdge(edgeId);
      if (!this.isChanceEdge(edge) || !edge) {
        continue;
      }

      totalBranchWeight += edge.weight;
      // Use the same turn denominator (sum - turn) as the winProb / tenpaiProb /
      // expScore induction in calcStats(). A separate wall-size denominator would
      // produce probabilities that do not reconcile with the node's winProb.
      const evProbability = edge.weight / denominator;
      const target = this.getNode(edge.targetId);
      const targetTurn = Math.min(config.tMax, turn + 1);
      if (edge.score > 0) {
        const realizedValue = Math.max(edge.score, target?.expScore[targetTurn] ?? 0);
        this.addDrawTileAggregate(
          aggregates,
          edge.tile,
          evProbability,
          evProbability * realizedValue,
          evProbability * realizedValue,
          evProbability,
          evProbability * edge.baseScore,
          evProbability * edge.uradoraHitProbability,
          undefined,
          true
        );
        continue;
      }

      if (!target) {
        continue;
      }
      const bestDecision = target.riichi && target.forcedDiscardTile !== undefined
        ? this.decisionEdgeForSource(target, this.forcedSourceNodeId(target))
        : this.bestExpScoreDecisionEdge(target, targetTurn);
      const source = bestDecision ? this.getNode(bestDecision.sourceId) : undefined;
      if (bestDecision?.tile === edge.tile && source) {
        const childAggregates = this.aggregateDrawTilesMap(source.id, targetTurn, config);
        childAggregates.forEach((value, tile) => {
          this.addDrawTileAggregateFromValue(aggregates, tile, evProbability, evProbability, value);
        });
        continue;
      }

      // A hand-improving draw (best discard keeps the drawn tile) is shown as a
      // single navigable child rather than being collapsed/recursed. Fold its
      // downstream win probability into edge.tile so the per-tile win figures
      // still sum to node.winProb — mirroring the per-edge winProb contribution
      // (evProbability * target.winProb[turn + 1]) in calcStats().
      const value = Math.max(edge.score, target.expScore[targetTurn] ?? 0);
      const downstreamWin = target.winProb[targetTurn] ?? 0;
      this.addDrawTileAggregate(aggregates, edge.tile, evProbability, evProbability * value, evProbability * value, evProbability * downstreamWin, 0, 0, target.id, false);
    }

    const residualWeight = denominator - totalBranchWeight;
    if (Math.abs(residualWeight) > 1e-9) {
      const residualEvProbability = residualWeight / denominator;
      const residualAggregates = this.aggregateDrawTilesMap(node.id, turn + 1, config);
      residualAggregates.forEach((value, tile) => {
        this.addDrawTileAggregateFromValue(aggregates, tile, residualEvProbability, residualEvProbability, value);
      });
    }

    const result: InternalTileBreakdown[] = Array.from(aggregates.entries())
      .map(([tile, value]) => ({
        tile,
        probability: value.probability,
        evContribution: value.evContribution,
        averageValue: value.probability > 0 ? value.valueContribution / value.probability : 0,
        winProbability: value.winProbability,
        averageBaseValue: value.winProbability > 0 ? value.baseContribution / value.winProbability : 0,
        averageUradoraHitProbability: value.winProbability > 0 ? value.uradoraContribution / value.winProbability : 0,
        outcome: value.hasWin && value.hasHandChange
          ? TileOutcome.Mixed
          : value.hasWin
            ? TileOutcome.Win
            : TileOutcome.HandChange,
        targetNodeId: value.targetNodeId
      }))
      .sort((left, right) => right.evContribution - left.evContribution || right.probability - left.probability || left.tile - right.tile);

    this.drawTileAggregateCache.set(cacheKey, result);
    return result.map((entry) => ({ ...entry }));
  }

  private aggregateDrawTilesMap(nodeId: NodeId, turn: number, config: Config): Map<number, InternalDrawTileAggregate> {
    const result = this.aggregateDrawTilesInternal(nodeId, turn, config);
    const mapped = new Map<number, InternalDrawTileAggregate>();
    for (const entry of result) {
      mapped.set(entry.tile, {
        probability: entry.probability,
        evContribution: entry.evContribution,
        valueContribution: entry.averageValue * entry.probability,
        winProbability: entry.winProbability,
        baseContribution: entry.averageBaseValue * entry.winProbability,
        uradoraContribution: entry.averageUradoraHitProbability * entry.winProbability,
        targetNodeId: entry.targetNodeId,
        targetContribution: entry.evContribution,
      hasHandChange: entry.outcome === TileOutcome.HandChange || entry.outcome === TileOutcome.Mixed,
      hasWin: entry.outcome === TileOutcome.Win || entry.outcome === TileOutcome.Mixed
      });
    }
    return mapped;
  }

  private addDrawTileAggregate(
    aggregates: Map<number, InternalDrawTileAggregate>,
    tile: number,
    probability: number,
    evContribution: number,
    valueContribution: number,
    winProbability: number,
    baseContribution: number,
    uradoraContribution: number,
    targetNodeId: NodeId | undefined,
    isWin: boolean
  ): void {
    const current = aggregates.get(tile) ?? {
      probability: 0,
      evContribution: 0,
      valueContribution: 0,
      winProbability: 0,
      baseContribution: 0,
      uradoraContribution: 0,
      targetNodeId: undefined,
      targetContribution: -Infinity,
      hasHandChange: false,
      hasWin: false
    };
    current.probability += probability;
    current.evContribution += evContribution;
    current.valueContribution += valueContribution;
    current.winProbability += winProbability;
    current.baseContribution += baseContribution;
    current.uradoraContribution += uradoraContribution;
    current.hasWin ||= isWin;
    current.hasHandChange ||= !isWin;
    if (targetNodeId && evContribution > current.targetContribution) {
      current.targetNodeId = targetNodeId;
      current.targetContribution = evContribution;
    }
    aggregates.set(tile, current);
  }

  private addDrawTileAggregateFromValue(
    aggregates: Map<number, InternalDrawTileAggregate>,
    tile: number,
    probabilityMultiplier: number,
    evMultiplier: number,
    value: InternalDrawTileAggregate
  ): void {
    const current = aggregates.get(tile) ?? {
      probability: 0,
      evContribution: 0,
      valueContribution: 0,
      winProbability: 0,
      baseContribution: 0,
      uradoraContribution: 0,
      targetNodeId: undefined,
      targetContribution: -Infinity,
      hasHandChange: false,
      hasWin: false
    };
    const evContribution = evMultiplier * value.evContribution;
    current.probability += probabilityMultiplier * value.probability;
    current.evContribution += evContribution;
    current.valueContribution += probabilityMultiplier * value.valueContribution;
    current.winProbability += probabilityMultiplier * value.winProbability;
    current.baseContribution += probabilityMultiplier * value.baseContribution;
    current.uradoraContribution += probabilityMultiplier * value.uradoraContribution;
    current.hasWin ||= value.hasWin;
    current.hasHandChange ||= value.hasHandChange;
    if (value.targetNodeId && evContribution > current.targetContribution) {
      current.targetNodeId = value.targetNodeId;
      current.targetContribution = evContribution;
    }
    aggregates.set(tile, current);
  }

  private bestExpScoreDecisionEdge(node: InternalSearchNode, turn: number): InternalSearchEdge | undefined {
    let bestEdge: InternalSearchEdge | undefined;
    let bestExpScore = -Infinity;
    for (const edgeId of node.incomingEdgeIds) {
      const edge = this.getEdge(edgeId);
      if (!this.isDecisionEdge(edge) || !edge) {
        continue;
      }
      const source = this.getNode(edge.sourceId);
      const expScore = source?.expScore[turn];
      if (expScore !== undefined && expScore > bestExpScore) {
        bestExpScore = expScore;
        bestEdge = edge;
      }
    }
    return bestEdge;
  }

  private decisionEdgeForSource(node: InternalSearchNode, sourceId: NodeId | undefined): InternalSearchEdge | undefined {
    if (sourceId === undefined) {
      return undefined;
    }
    for (const edgeId of node.incomingEdgeIds) {
      const edge = this.getEdge(edgeId);
      if (edge?.edgeKind === EdgeKind.Decision && edge.sourceId === sourceId) {
        return edge;
      }
    }
    return undefined;
  }

  private forcedSourceNodeId(node: InternalSearchNode): NodeId | undefined {
    if (node.forcedDiscardTile === undefined) {
      return undefined;
    }
    for (const edgeId of node.incomingEdgeIds) {
      const edge = this.getEdge(edgeId);
      if (edge?.edgeKind === EdgeKind.Chance && edge.tile === node.forcedDiscardTile) {
        return edge.sourceId;
      }
    }
    return undefined;
  }

  private exactUradoraDistribution(wall: Count, handAndMelds: Count, wallSize: number, numIndicators: number): Map<number, number> {
    if (numIndicators <= 0 || wallSize <= 0) {
      return new Map([[0, 1]]);
    }

    const dp = Array.from({ length: numIndicators + 1 }, () => new Map<number, number>());
    dp[0]!.set(0, 1);

    for (let indicator = 0; indicator < 34; indicator += 1) {
      const count = wall[indicator];
      if (count <= 0) {
        continue;
      }
      const value = handAndMelds[TO_DORA[indicator]];
      for (let taken = numIndicators - 1; taken >= 0; taken -= 1) {
        const current = dp[taken]!;
        if (current.size === 0) {
          continue;
        }
        for (let copies = 1; copies <= Math.min(count, numIndicators - taken); copies += 1) {
          const ways = this.combination(count, copies);
          const next = dp[taken + copies]!;
          for (const [han, baseWays] of current.entries()) {
            next.set(han + value * copies, (next.get(han + value * copies) ?? 0) + baseWays * ways);
          }
        }
      }
    }

    const totalWays = this.combination(wallSize, numIndicators);
    const distribution = new Map<number, number>();
    for (const [han, ways] of dp[numIndicators]!.entries()) {
      distribution.set(han, ways / totalWays);
    }
    return distribution.size > 0 ? distribution : new Map([[0, 1]]);
  }

  private combination(n: number, k: number): number {
    if (k < 0 || k > n) {
      return 0;
    }
    if (k === 0 || k === n) {
      return 1;
    }
    let result = 1;
    const m = Math.min(k, n - k);
    for (let i = 1; i <= m; i += 1) {
      result = (result * (n - m + i)) / i;
    }
    return result;
  }
}
