import { ScoreTitle, Tile, TO_DORA, TO_INDICATOR, WinFlag } from "./constants.js";
import {
  CalculationResult,
  Config,
  Count,
  MahjongAnalysisEngine,
  NodeTurnBreakdown,
  Player,
  Round,
  SearchEdge,
  SearchNode,
  SearchSummary,
  Stat,
  WinTileBreakdown
} from "./model.js";
import {
  addTileToMask,
  cloneCount,
  clonePlayer,
  isClosed,
  isReddora,
  maskHas,
  numPlayerTiles,
  toNoReddora
} from "./utils.js";

type CountRed = Count;

interface CacheState {
  draw: Map<string, string>;
  discard: Map<string, string>;
}

interface NodeBuildInfo {
  shantenType: number;
  shanten: number;
  actionMask: bigint;
  allowTegawari: boolean;
  allowShantenDown: boolean;
  forcedDiscardTile?: number;
}

interface CalculationOptions {
  graphDepthLimit?: number;
  startNode?: Pick<SearchNode, "phase" | "hand" | "wall" | "riichi" | "forcedDiscardTile">;
  originHand?: Count;
  originShanten?: number;
}

interface ScoreBreakdown {
  expectedScore: number;
  baseScore: number;
  uradoraHitProbability: number;
}

interface InternalWinTileAggregate {
  winProbability: number;
  evContribution: number;
  baseContribution: number;
  uradoraContribution: number;
}

export class ExpectedScoreCalculatorTs {
  private readonly nodes = new Map<string, SearchNode>();
  private readonly edges = new Map<string, SearchEdge>();
  private readonly warnings: string[] = [];
  private readonly winTileAggregateCache = new Map<string, WinTileBreakdown[]>();
  private drawCacheHits = 0;
  private discardCacheHits = 0;
  private nodeCounter = 0;
  private edgeCounter = 0;

  calc(
    configInput: Config,
    round: Round,
    playerInput: Player,
    engine: MahjongAnalysisEngine,
    wallInput?: Count,
    options: CalculationOptions = {}
  ): CalculationResult {
    this.nodes.clear();
    this.edges.clear();
    this.warnings.length = 0;
    this.winTileAggregateCache.clear();
    this.drawCacheHits = 0;
    this.discardCacheHits = 0;
    this.nodeCounter = 0;
    this.edgeCounter = 0;

    const graphDepthLimit = Math.max(0, options.graphDepthLimit ?? 2);
    const config: Config = { ...configInput };
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
      config.sum = wall.slice(0, 34).reduce((sum, count) => sum + count, 0);
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
    const riichi = options.startNode?.riichi ?? (config.enableRiichi && isClosed(player) && shantenOrigin <= 0);
    const caches: CacheState = { draw: new Map(), discard: new Map() };
    const stats: Stat[] = [];
    let rootNodeId: string | undefined;
    let rootPhase: "draw" | "discard" | undefined;

    if (!engine.scoring) {
      this.pushWarning("No scoring engine was provided. EV values will stay at 0 until a TS scorer is plugged in.");
    }

    if (options.startNode?.phase === "draw" || (!options.startNode && numTiles === 13)) {
      rootNodeId = this.drawNode(config, round, player, engine, caches, handCounts, wallCounts, handOrigin, shantenOrigin, riichi);
      rootPhase = "draw";
      if (config.calcStats) {
        this.calcStats(config);
      }
      const rootId = caches.draw.get(this.createCacheKey(handCounts, wallCounts, riichi));
      if (rootId) {
        const root = this.nodes.get(rootId)!;
        const necessary = this.getNecessaryTiles(config, player, wall, engine);
        stats.push({
          tile: Tile.Null,
          tenpaiProb: root.tenpaiProb.slice(),
          winProb: root.winProb.slice(),
          expScore: root.expScore.slice(),
          necessaryTiles: necessary.necessaryTiles,
          shanten: necessary.shanten,
          drawNodeId: root.id
        });
      }
    } else {
      rootNodeId = this.discardNode(
        config,
        round,
        player,
        engine,
        caches,
        handCounts,
        wallCounts,
        handOrigin,
        shantenOrigin,
        riichi,
        options.startNode?.forcedDiscardTile
      );
      rootPhase = "discard";
      if (config.calcStats) {
        this.calcStats(config);
      }

      for (let tile = 0; tile < 37; tile += 1) {
        if (handCounts[tile] <= 0) {
          continue;
        }
        this.discard(player, handCounts, wallCounts, tile);
          const nodeId = caches.draw.get(this.createCacheKey(handCounts, wallCounts, riichi));
        if (nodeId) {
          const node = this.nodes.get(nodeId)!;
          const necessary = this.getNecessaryTiles(config, player, wall, engine);
          stats.push({
            tile,
            tenpaiProb: node.tenpaiProb.slice(),
            winProb: node.winProb.slice(),
            expScore: node.expScore.slice(),
            necessaryTiles: necessary.necessaryTiles,
            shanten: necessary.shanten,
            drawNodeId: node.id
          });
        }
        this.draw(player, handCounts, wallCounts, tile);
      }
    }

    const search: SearchSummary = {
      searchedVertices: this.nodes.size,
      searchedEdges: this.edges.size,
      drawNodes: Array.from(this.nodes.values()).filter((node) => node.phase === "draw").length,
      discardNodes: Array.from(this.nodes.values()).filter((node) => node.phase === "discard").length,
      drawCacheHits: this.drawCacheHits,
      discardCacheHits: this.discardCacheHits
    };
    const snapshot = rootNodeId && rootPhase
      ? this.createGraphSnapshot(config, rootNodeId, rootPhase, graphDepthLimit)
      : { nodes: [], edges: [] };

    return {
      stats,
      searched: this.nodes.size,
      search,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      warnings: this.warnings.slice(),
      rootNodeId,
      rootPhase,
      context: {
        originHand: this.decodeForDisplay(handOrigin),
        originShanten: shantenOrigin,
        graphDepthLimit,
        rootWallCount: wall.slice(0, 34).reduce((sum, count) => sum + count, 0)
      }
    };
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

    if (numIndicators === 1) {
      const upScores = engine.scoring.getUpScores(round, player, result, winFlag, 4);
      const numIndicatorCounts = Array.from({ length: 5 }, () => 0);
      for (let tile = 0; tile < 34; tile += 1) {
        const count = handAndMelds[tile];
        numIndicatorCounts[count] += wall[TO_INDICATOR[tile]];
      }

      let score = 0;
      for (let i = 0; i <= 4; i += 1) {
        score += upScores[i] * (numIndicatorCounts[i] / config.sum);
      }
      const uradoraHitProbability = config.sum > 0 ? 1 - (numIndicatorCounts[0] / config.sum) : 0;
      return { expectedScore: score, baseScore, uradoraHitProbability };
    }

    const maxAddedHanPerIndicator = Array.from({ length: 34 }, (_, tile) => handAndMelds[TO_DORA[tile]]);
    const maxAddedHan = maxAddedHanPerIndicator.sort((left, right) => right - left).slice(0, numIndicators).reduce((sum, value) => sum + value, 0);
    const upScores = engine.scoring.getUpScores(round, player, result, winFlag, maxAddedHan);
    const distribution = this.exactUradoraDistribution(wall, handAndMelds, config.sum, numIndicators);
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

  private drawNode(config: Config, round: Round, player: Player, engine: MahjongAnalysisEngine, caches: CacheState, handCounts: CountRed, wallCounts: CountRed, handOrigin: CountRed, shantenOrigin: number, riichi: boolean): string {
    const key = this.createCacheKey(handCounts, wallCounts, riichi);
    const cachedId = caches.draw.get(key);
    if (cachedId) {
      this.drawCacheHits += 1;
      return cachedId;
    }

    const analysis = engine.analyzeNecessary(player.hand, player.melds.length, config.shantenType);
    const waitMask = this.extendMaskWithRedFives(this.tilesToMask(analysis.tiles));
    const allowTegawari = !riichi && config.enableTegawari && this.distance(handCounts, handOrigin) + analysis.shanten < shantenOrigin + config.extra;
    const node = this.addNode("draw", key, handCounts, wallCounts, {
      shantenType: analysis.shantenType,
      shanten: analysis.shanten,
      actionMask: waitMask,
      allowTegawari,
      allowShantenDown: false
    }, riichi, config, this.distance(handCounts, handOrigin));
    caches.draw.set(key, node.id);

    if (riichi && analysis.shanten === 0) {
      for (let tile = 0; tile < 37; tile += 1) {
        if (wallCounts[tile] <= 0) {
          continue;
        }

        const weight = wallCounts[tile];
        this.draw(player, handCounts, wallCounts, tile);
        const handAnalysis = engine.calculateShanten(player.hand, player.melds.length, analysis.shantenType);
        if (handAnalysis.shanten < 0) {
          const scoreBreakdown = this.calcScore(
            config,
            round,
            player,
            engine,
            handCounts,
            wallCounts,
            analysis.shantenType,
            tile,
            true
          );
          if (scoreBreakdown.expectedScore > 0) {
            const targetId = this.discardNode(
              config,
              round,
              player,
              engine,
              caches,
              handCounts,
              wallCounts,
              handOrigin,
              shantenOrigin,
              true,
              tile
            );
            const edgeId = this.findEdge(node.id, targetId, tile, "chance");
            if (!edgeId) {
              this.addEdge(
                node.id,
                targetId,
                tile,
                weight,
                scoreBreakdown.expectedScore,
                scoreBreakdown.baseScore,
                scoreBreakdown.uradoraHitProbability,
                true,
                false,
                "chance",
                true,
                true
              );
            }
          }
        }
        this.discard(player, handCounts, wallCounts, tile);
      }

      return node.id;
    }

    for (let tile = 0; tile < 37; tile += 1) {
      const isWait = maskHas(waitMask, tile);
      if (wallCounts[tile] <= 0 || (!allowTegawari && !isWait)) {
        continue;
      }

      const weight = wallCounts[tile];
      this.draw(player, handCounts, wallCounts, tile);
      let targetId: string;
      let scoreBreakdown: ScoreBreakdown;
      if (riichi && !(analysis.shanten === 0 && isWait)) {
        this.discard(player, handCounts, wallCounts, tile);
        targetId = this.drawNode(
          config,
          round,
          player,
          engine,
          caches,
          handCounts,
          wallCounts,
          handOrigin,
          shantenOrigin,
          true
        );
        this.draw(player, handCounts, wallCounts, tile);
        scoreBreakdown = { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
      } else {
        targetId = this.discardNode(
          config,
          round,
          player,
          engine,
          caches,
          handCounts,
          wallCounts,
          handOrigin,
          shantenOrigin,
          riichi,
          riichi ? tile : undefined
        );
        scoreBreakdown = analysis.shanten === 0 && isWait
          ? this.calcScore(config, round, player, engine, handCounts, wallCounts, analysis.shantenType, tile, riichi)
          : { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };
      }
      this.discard(player, handCounts, wallCounts, tile);

      const edgeId = this.findEdge(node.id, targetId, tile, "chance");
      if (!edgeId) {
        this.addEdge(
          node.id,
          targetId,
          tile,
          weight,
          scoreBreakdown.expectedScore,
          scoreBreakdown.baseScore,
          scoreBreakdown.uradoraHitProbability,
          isWait,
          false,
          "chance",
          riichi,
          riichi
        );
      }
    }

    return node.id;
  }

  private discardNode(config: Config, round: Round, player: Player, engine: MahjongAnalysisEngine, caches: CacheState, handCounts: CountRed, wallCounts: CountRed, handOrigin: CountRed, shantenOrigin: number, riichi: boolean, forcedDiscardTile?: number): string {
    const key = this.createCacheKey(handCounts, wallCounts, riichi, forcedDiscardTile);
    const cachedId = caches.discard.get(key);
    if (cachedId) {
      this.discardCacheHits += 1;
      return cachedId;
    }

    const analysis = engine.analyzeUnnecessary(player.hand, player.melds.length, config.shantenType);
    const discardMask = this.extendMaskWithRedFives(this.tilesToMask(analysis.tiles));
    const allowShantenDown = config.enableShantenDown && this.distance(handCounts, handOrigin) + analysis.shanten < shantenOrigin + config.extra;
    const node = this.addNode("discard", key, handCounts, wallCounts, {
      shantenType: analysis.shantenType,
      shanten: analysis.shanten,
      actionMask: discardMask,
      allowTegawari: false,
      allowShantenDown,
      forcedDiscardTile
    }, riichi, config, this.distance(handCounts, handOrigin));
    caches.discard.set(key, node.id);

    for (let tile = 0; tile < 37; tile += 1) {
      const isDiscard = maskHas(discardMask, tile);
      if (riichi && forcedDiscardTile !== undefined && tile !== forcedDiscardTile) {
        continue;
      }
      if (handCounts[tile] <= 0 || (!allowShantenDown && !isDiscard)) {
        continue;
      }

      const nextRiichi = riichi || (config.enableRiichi && isClosed(player) && analysis.shanten === 0 && isDiscard);
      this.discard(player, handCounts, wallCounts, tile);
      const weight = wallCounts[tile];
      const sourceId = this.drawNode(config, round, player, engine, caches, handCounts, wallCounts, handOrigin, shantenOrigin, nextRiichi);
      this.draw(player, handCounts, wallCounts, tile);
      const scoreBreakdown = analysis.shanten === -1
        ? this.calcScore(config, round, player, engine, handCounts, wallCounts, analysis.shantenType, tile, nextRiichi)
        : { expectedScore: 0, baseScore: 0, uradoraHitProbability: 0 };

      const edgeId = this.findEdge(sourceId, node.id, tile, "decision");
      if (!edgeId) {
        this.addEdge(
          sourceId,
          node.id,
          tile,
          weight,
          scoreBreakdown.expectedScore,
          scoreBreakdown.baseScore,
          scoreBreakdown.uradoraHitProbability,
          false,
          isDiscard,
          "decision",
          nextRiichi,
          riichi
        );
      }
    }

    return node.id;
  }

  private calcStats(config: Config): void {
    const drawNodes = Array.from(this.nodes.values()).filter((node) => node.phase === "draw");
    const discardNodes = Array.from(this.nodes.values()).filter((node) => node.phase === "discard");

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
            const edge = this.edges.get(edgeId)!;
            if (edge.edgeKind !== "chance") {
              continue;
            }
            const target = this.nodes.get(edge.targetId)!;
            tenpaiAccum += edge.weight * (target.tenpaiProb[turn + 1] - previousTenpai);
            winAccum += edge.weight * (target.winProb[turn + 1] - previousWin);
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
          const source = sourceId ? this.nodes.get(sourceId) : undefined;
          node.tenpaiProb[turn] = source?.tenpaiProb[turn] ?? 0;
          node.winProb[turn] = source?.winProb[turn] ?? 0;
          node.expScore[turn] = source?.expScore[turn] ?? 0;
          if (turn === config.tMin) {
            node.turnBreakdowns = [];
          }
          continue;
        }

        let bestTenpai = node.tenpaiProb[turn];
        let bestWin = node.winProb[turn];
        let bestExpScore = node.expScore[turn];
        let bestTenpaiTile: number | undefined;
        let bestWinTile: number | undefined;
        let bestExpScoreTile: number | undefined;

        for (const edgeId of node.incomingEdgeIds) {
          const edge = this.edges.get(edgeId)!;
          if (edge.edgeKind !== "decision") {
            continue;
          }
          const source = this.nodes.get(edge.sourceId)!;
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
        if (turn === config.tMin) {
          node.turnBreakdowns = [];
        }
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

  private createCacheKey(hand: CountRed, wall: CountRed, riichi: boolean, forcedDiscardTile?: number): string {
    return `${hand.join(",")}/${wall.join(",")}/${riichi ? 1 : 0}/${forcedDiscardTile ?? -1}`;
  }

  private tilesToMask(tiles: number[]): bigint {
    let mask = 0n;
    for (const tile of tiles) {
      mask = addTileToMask(mask, tile);
    }
    return mask;
  }

  private extendMaskWithRedFives(mask: bigint): bigint {
    let extended = mask;
    if (maskHas(mask, Tile.Manzu5)) {
      extended = addTileToMask(extended, Tile.RedManzu5);
    }
    if (maskHas(mask, Tile.Pinzu5)) {
      extended = addTileToMask(extended, Tile.RedPinzu5);
    }
    if (maskHas(mask, Tile.Souzu5)) {
      extended = addTileToMask(extended, Tile.RedSouzu5);
    }
    return extended;
  }

  private addNode(phase: "draw" | "discard", cacheKey: string, handCounts: CountRed, wallCounts: CountRed, info: NodeBuildInfo, riichi: boolean, config: Config, originDistance: number): SearchNode {
    const id = `${phase[0]}${this.nodeCounter += 1}`;
    const tenpaiProb = Array.from({ length: config.tMax + 1 }, () => phase === "discard" && info.shanten === 0 ? 1 : 0);
    const winProb = Array.from({ length: config.tMax + 1 }, () => phase === "discard" && info.shanten === -1 ? 1 : 0);
    const expScore = Array.from({ length: config.tMax + 1 }, () => 0);
    if (phase === "draw") {
      tenpaiProb[config.tMax] = info.shanten === 0 ? 1 : 0;
    }

    const node: SearchNode = {
      id,
      phase,
      cacheKey,
      hand: this.decodeForDisplay(handCounts),
      wall: this.decodeForDisplay(wallCounts),
      forcedDiscardTile: info.forcedDiscardTile,
      shantenType: info.shantenType,
      shanten: info.shanten,
      riichi,
      originDistance,
      allowTegawari: info.allowTegawari,
      allowShantenDown: info.allowShantenDown,
      actionMask: info.actionMask,
      outgoingEdgeIds: [],
      incomingEdgeIds: [],
      tenpaiProb,
      winProb,
      expScore,
      turnBreakdowns: []
    };
    this.nodes.set(id, node);
    return node;
  }

  private addEdge(
    sourceId: string,
    targetId: string,
    tile: number,
    weight: number,
    score: number,
    baseScore: number,
    uradoraHitProbability: number,
    isWait: boolean,
    isDiscard: boolean,
    edgeKind: "chance" | "decision",
    riichiBefore: boolean,
    riichiAfter: boolean
  ): void {
    const id = `e${this.edgeCounter += 1}`;
    const edge: SearchEdge = {
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
    this.edges.set(id, edge);
    this.nodes.get(sourceId)!.outgoingEdgeIds.push(id);
    this.nodes.get(targetId)!.incomingEdgeIds.push(id);
  }

  private findEdge(sourceId: string, targetId: string, tile: number, edgeKind: "chance" | "decision"): string | undefined {
    for (const edgeId of this.nodes.get(sourceId)?.outgoingEdgeIds ?? []) {
      const edge = this.edges.get(edgeId);
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
    rootNodeId: string,
    rootPhase: "draw" | "discard",
    depthLimit: number
  ): { nodes: SearchNode[]; edges: SearchEdge[] } {
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: rootNodeId, depth: 0 }];
    const visited = new Set<string>();
    const nodeOrder: string[] = [];
    const includedEdges = new Set<string>();

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

      const node = this.nodes.get(current.nodeId);
      if (!node) {
        continue;
      }
      const branchEdgeIds = node.phase === "draw"
        ? node.outgoingEdgeIds.filter((edgeId) => this.edges.get(edgeId)?.edgeKind === "chance")
        : node.incomingEdgeIds.filter((edgeId) => this.edges.get(edgeId)?.edgeKind === "decision");
      branchEdgeIds.forEach((edgeId) => {
        const edge = this.edges.get(edgeId);
        if (!edge) {
          return;
        }
        includedEdges.add(edgeId);
        const nextId = node.phase === "draw" ? edge.targetId : edge.sourceId;
        if (!visited.has(nextId)) {
          queue.push({ nodeId: nextId, depth: current.depth + 1 });
        }
      });
    }

    const edges = Array.from(includedEdges)
      .map((edgeId) => this.edges.get(edgeId))
      .filter((edge): edge is SearchEdge => Boolean(edge))
      .filter((edge) => visited.has(edge.sourceId) && visited.has(edge.targetId))
      .map((edge) => ({ ...edge }));

    const includedEdgeIds = new Set(edges.map((edge) => edge.id));
    const nodes = nodeOrder
      .map((nodeId) => this.nodes.get(nodeId))
      .filter((node): node is SearchNode => Boolean(node))
      .map((node) => ({
        ...node,
        hand: cloneCount(node.hand),
        wall: cloneCount(node.wall),
        outgoingEdgeIds: node.outgoingEdgeIds.filter((edgeId) => includedEdgeIds.has(edgeId)),
        incomingEdgeIds: node.incomingEdgeIds.filter((edgeId) => includedEdgeIds.has(edgeId)),
        tenpaiProb: node.tenpaiProb.slice(),
        winProb: node.winProb.slice(),
        expScore: node.expScore.slice(),
        turnBreakdowns: this.buildTurnBreakdowns(node, config)
      }));

    return { nodes, edges };
  }

  private buildTurnBreakdowns(node: SearchNode, config: Config): NodeTurnBreakdown[] {
    const breakdowns: NodeTurnBreakdown[] = [];

    if (node.phase === "draw") {
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
          .filter((edgeId) => this.edges.get(edgeId)?.edgeKind === "chance")
          .map((edgeId) => {
            const edge = this.edges.get(edgeId)!;
            const target = this.nodes.get(edge.targetId)!;
            const realizedExpScore = Math.max(edge.score, target.expScore[turn + 1] ?? 0);
            return {
              tile: edge.tile,
              targetNodeId: edge.targetId,
              weight: edge.weight,
              probability: denominator > 0 ? edge.weight / denominator : 0,
              immediateScore: edge.score,
              baseScore: edge.baseScore,
              uradoraHitProbability: edge.uradoraHitProbability,
              targetTenpai: target.tenpaiProb[turn + 1] ?? 0,
              targetWin: target.winProb[turn + 1] ?? 0,
              targetExpScore: target.expScore[turn + 1] ?? 0,
              contributionTenpai: denominator > 0 ? edge.weight * ((target.tenpaiProb[turn + 1] ?? 0) - previousTenpai) / denominator : 0,
              contributionWin: denominator > 0 ? edge.weight * ((target.winProb[turn + 1] ?? 0) - previousWin) / denominator : 0,
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
          winTileBreakdowns: node.riichi && node.shanten === 0
            ? this.aggregateWinTiles(node.id, turn, config)
            : undefined
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
        .filter((edgeId) => this.edges.get(edgeId)?.edgeKind === "decision")
        .map((edgeId) => {
          const edge = this.edges.get(edgeId)!;
          const source = this.nodes.get(edge.sourceId)!;
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
            sourceNodeId: edge.sourceId,
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

  private aggregateWinTiles(nodeId: string, turn: number, config: Config): WinTileBreakdown[] {
    const cacheKey = `${nodeId}@${turn}`;
    const cached = this.winTileAggregateCache.get(cacheKey);
    if (cached) {
      return cached.map((entry) => ({ ...entry }));
    }

    const node = this.nodes.get(nodeId);
    if (!node || turn > config.tMax) {
      return [];
    }

    let aggregates = new Map<number, InternalWinTileAggregate>();
    if (node.phase === "discard") {
      const sourceId = node.riichi && node.forcedDiscardTile !== undefined
        ? this.forcedSourceNodeId(node)
        : this.bestExpScoreSourceNodeId(node, turn);
      aggregates = sourceId ? this.aggregateWinTilesMap(sourceId, turn, config) : new Map();
    } else if (turn < config.tMax) {
      const denominator = config.sum - turn;
      let totalBranchWeight = 0;
      for (const edgeId of node.outgoingEdgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge || edge.edgeKind !== "chance" || denominator <= 0) {
          continue;
        }
        totalBranchWeight += edge.weight;
        const probability = edge.weight / denominator;
        if (edge.score > 0) {
          this.addWinTileAggregate(aggregates, edge.tile, probability, probability * edge.score, probability * edge.baseScore, probability * edge.uradoraHitProbability);
          continue;
        }
        const childAggregates = this.aggregateWinTilesMap(edge.targetId, turn + 1, config);
        childAggregates.forEach((value, tile) => {
          this.addWinTileAggregate(
            aggregates,
            tile,
            probability * value.winProbability,
            probability * value.evContribution,
            probability * value.baseContribution,
            probability * value.uradoraContribution
          );
        });
      }
      const residualWeight = denominator - totalBranchWeight;
      if (residualWeight > 0) {
        const residualAggregates = this.aggregateWinTilesMap(node.id, turn + 1, config);
        const residualProbability = residualWeight / denominator;
        residualAggregates.forEach((value, tile) => {
          this.addWinTileAggregate(
            aggregates,
            tile,
            residualProbability * value.winProbability,
            residualProbability * value.evContribution,
            residualProbability * value.baseContribution,
            residualProbability * value.uradoraContribution
          );
        });
      }
    }

    const result = Array.from(aggregates.entries())
      .map(([tile, value]) => ({
        tile,
        winProbability: value.winProbability,
        evContribution: value.evContribution,
        averageWinValue: value.winProbability > 0 ? value.evContribution / value.winProbability : 0,
        averageBaseValue: value.winProbability > 0 ? value.baseContribution / value.winProbability : 0,
        averageUradoraHitProbability: value.winProbability > 0 ? value.uradoraContribution / value.winProbability : 0
      }))
      .sort((left, right) => right.evContribution - left.evContribution || right.winProbability - left.winProbability || left.tile - right.tile);

    this.winTileAggregateCache.set(cacheKey, result);
    return result.map((entry) => ({ ...entry }));
  }

  private aggregateWinTilesMap(nodeId: string, turn: number, config: Config): Map<number, InternalWinTileAggregate> {
    const result = this.aggregateWinTiles(nodeId, turn, config);
    return new Map(result.map((entry) => [entry.tile, {
      winProbability: entry.winProbability,
      evContribution: entry.evContribution,
      baseContribution: entry.averageBaseValue * entry.winProbability,
      uradoraContribution: entry.averageUradoraHitProbability * entry.winProbability
    }]));
  }

  private bestExpScoreSourceNodeId(node: SearchNode, turn: number): string | undefined {
    let bestSourceId: string | undefined;
    let bestExpScore = -Infinity;
    for (const edgeId of node.incomingEdgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge?.edgeKind !== "decision") {
        continue;
      }
      const source = edge ? this.nodes.get(edge.sourceId) : undefined;
      const expScore = source?.expScore[turn];
      if (expScore !== undefined && expScore > bestExpScore) {
        bestExpScore = expScore;
        bestSourceId = source?.id;
      }
    }
    return bestSourceId;
  }

  private forcedSourceNodeId(node: SearchNode): string | undefined {
    if (node.forcedDiscardTile === undefined) {
      return undefined;
    }
    for (const edgeId of node.incomingEdgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge?.edgeKind === "chance" && edge.tile === node.forcedDiscardTile) {
        return edge.sourceId;
      }
    }
    return undefined;
  }

  private addWinTileAggregate(
    aggregates: Map<number, InternalWinTileAggregate>,
    tile: number,
    winProbability: number,
    evContribution: number,
    baseContribution: number,
    uradoraContribution: number
  ): void {
    const current = aggregates.get(tile) ?? {
      winProbability: 0,
      evContribution: 0,
      baseContribution: 0,
      uradoraContribution: 0
    };
    current.winProbability += winProbability;
    current.evContribution += evContribution;
    current.baseContribution += baseContribution;
    current.uradoraContribution += uradoraContribution;
    aggregates.set(tile, current);
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
