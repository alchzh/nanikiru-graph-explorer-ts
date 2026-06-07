import { MeldType, ShantenFlag, Tile } from "./constants.js";
import { BruteForceMahjongEngine } from "./analyzers.js";
import { ExpectedScoreCalculatorTs } from "./expectedScoreCalculator.js";
import {
  CalculationResult,
  Config,
  Count,
  createDefaultConfig,
  createDefaultRound,
  EdgeTurnBreakdown,
  Player,
  SearchNode
} from "./model.js";
import { TypeScriptScoreEngine } from "./scoreCalculator.js";
import { createTileImg, createTileText, tileLigature } from "./tileArtwork.js";
import { countToTileIds, parseTile, tileName, tilesToHand } from "./utils.js";

type EditTarget = "hand" | "dora" | "pon" | "chii" | "minkan" | "ankan" | "wall";

interface ScenarioInput {
  config?: Partial<Config>;
  currentTurn?: number;
  round?: {
    rules?: number;
    wind?: number;
    kyoku?: number;
    honba?: number;
    kyotaku?: number;
    doraIndicators?: Array<string | number>;
    uradoraIndicators?: Array<string | number>;
  };
  player: {
    wind?: number;
    tiles?: Array<string | number>;
    hand?: number[];
    melds?: Array<{
      type?: number;
      tiles: Array<string | number>;
      discardedTile?: string | number;
      from?: number;
    }>;
  };
  wall?: number[];
}

interface MeldDraft {
  type: number;
  tiles: number[];
}

interface EditorState {
  config: Config;
  currentTurn: number;
  round: ReturnType<typeof createDefaultRound>;
  playerWind: number;
  handTiles: number[];
  doraIndicators: number[];
  uradoraIndicators: number[];
  melds: MeldDraft[];
  currentMeldTiles: number[];
  currentMeldType: number;
  editTarget: EditTarget;
  wall?: number[];
}

interface AppState {
  editor: EditorState;
  jsonDraft: string;
  result?: CalculationResult;
  graphResult?: CalculationResult;
  selectedTurn: number;
  error?: string;
}

const GRAPH_SNAPSHOT_DEPTH = 2;
const SECOND_DEPTH_BRANCH_LIMIT = 4;
const GRAPH_NODE_WIDTH = 214;
const GRAPH_NODE_HEIGHT = 116;
const GRAPH_OPTION_WIDTH = 240;
const GRAPH_OPTION_ROWS = 6;
const GRAPH_COMPACT_OPTION_TILES_PER_ROW = 8;
const GRAPH_COMPACT_OPTION_TILE_STEP = 28;

interface GraphOptionRow {
  tile: number;
  text?: string;
  nodeId?: string;
}

interface GraphOptionList {
  kind: "chance" | "decision";
  title: string;
  rows: GraphOptionRow[];
  compact?: boolean;
}

type FocusedGraphChild =
  | {
      kind: "node";
      node: SearchNode;
      tile: number;
      probability: number;
      immediateScore: number;
      edgeKind: "chance" | "decision";
      sortEv: number;
      title: string | undefined;
    }
  | {
      kind: "agari";
      tile: number;
      probability: number;
      immediateScore: number;
      baseScore: number;
      uradoraHitProbability: number;
      edgeKind: "chance" | "decision";
      evContribution: number;
      aggregate?: boolean;
    }
  | {
      kind: "aggregate";
      edgeKind: "chance";
      probability: number;
      averageExpScore: number;
      averageWin: number;
      averageTenpai: number;
      branchCount: number;
      optionList?: GraphOptionList;
    };

const SAMPLE_SCENARIO: ScenarioInput = {
  config: {
    tMin: 1,
    tMax: 18,
    extra: 1,
    shantenType: ShantenFlag.All,
    enableReddora: true,
    enableUradora: true,
    enableShantenDown: true,
    enableTegawari: true,
    enableRiichi: true,
    calcStats: true
  },
  currentTurn: 3,
  round: {
    wind: Tile.East,
    doraIndicators: ["5z"],
    uradoraIndicators: []
  },
  player: {
    wind: Tile.South,
    tiles: ["1m", "2m", "4m", "4m", "4m", "3p", "4p", "5p", "6p", "7p", "9p", "9p", "1s", "2s"],
    melds: []
  }
};

const TILE_GROUPS: Array<{ label: string; tiles: number[] }> = [
  { label: "Manzu", tiles: [Tile.Manzu1, Tile.Manzu2, Tile.Manzu3, Tile.Manzu4, Tile.Manzu5, Tile.RedManzu5, Tile.Manzu6, Tile.Manzu7, Tile.Manzu8, Tile.Manzu9] },
  { label: "Pinzu", tiles: [Tile.Pinzu1, Tile.Pinzu2, Tile.Pinzu3, Tile.Pinzu4, Tile.Pinzu5, Tile.RedPinzu5, Tile.Pinzu6, Tile.Pinzu7, Tile.Pinzu8, Tile.Pinzu9] },
  { label: "Souzu", tiles: [Tile.Souzu1, Tile.Souzu2, Tile.Souzu3, Tile.Souzu4, Tile.Souzu5, Tile.RedSouzu5, Tile.Souzu6, Tile.Souzu7, Tile.Souzu8, Tile.Souzu9] },
  { label: "Honors", tiles: [Tile.East, Tile.South, Tile.West, Tile.North, Tile.White, Tile.Green, Tile.Red] }
];

export function mountBrowserApp(root: HTMLElement): void {
  const calculator = new ExpectedScoreCalculatorTs();
  const shantenEngine = new BruteForceMahjongEngine();
  const engine = new BruteForceMahjongEngine({ scoring: new TypeScriptScoreEngine(shantenEngine) });

  const initialEditor = scenarioToEditorState(SAMPLE_SCENARIO);
  const state: AppState = {
    editor: initialEditor,
    jsonDraft: JSON.stringify(editorStateToScenario(initialEditor), null, 2),
    selectedTurn: initialEditor.currentTurn
  };

  const rerender = (): void => {
    root.innerHTML = "";
    const layout = document.createElement("div");
    layout.className = "layout";
    layout.append(renderControls(state, rerender, runAnalysis), renderResults(state, rerender, focusGraphOnNode));
    root.append(layout);
  };

  const focusGraphOnNode = (node?: SearchNode): void => {
    if (!state.result || !node) {
      return;
    }
    const currentGraph = state.graphResult ?? state.result;
    const currentRoot = currentGraph.rootNodeId
      ? currentGraph.nodes.find((candidate) => candidate.id === currentGraph.rootNodeId)
      : undefined;
    if (currentRoot) {
      state.selectedTurn = transitionTurn(currentRoot.phase, node.phase, state.selectedTurn, state.editor.config.tMax);
    }
    state.graphResult = undefined;
    const rootConfig = {
      ...state.editor.config,
      sum: state.result.context.rootWallCount
    };
    const player = buildPlayerFromEditor(state.editor);
    state.graphResult = calculator.calc(
      rootConfig,
      state.editor.round,
      player,
      engine,
      state.editor.wall,
      {
        graphDepthLimit: GRAPH_SNAPSHOT_DEPTH,
        startNode: node,
        originHand: state.result.context.originHand,
        originShanten: state.result.context.originShanten
      }
    );
  };

  const runAnalysis = (): void => {
    state.error = undefined;
    try {
      syncTurnConfig(state.editor);
      const player = buildPlayerFromEditor(state.editor);
      const result = calculator.calc(
        state.editor.config,
        state.editor.round,
        player,
        engine,
        state.editor.wall,
        { graphDepthLimit: GRAPH_SNAPSHOT_DEPTH }
      );
      state.result = result;
      state.selectedTurn = state.editor.currentTurn;
      state.graphResult = undefined;
      state.jsonDraft = JSON.stringify(editorStateToScenario(state.editor), null, 2);
    } catch (error) {
      state.result = undefined;
      state.graphResult = undefined;
      state.error = error instanceof Error ? error.message : String(error);
    }
    rerender();
  };

  rerender();
}

function renderControls(state: AppState, rerender: () => void, runAnalysis: () => void): HTMLElement {
  const section = document.createElement("section");
  section.className = "controls";

  const editor = document.createElement("div");
  editor.className = "pystyle-editor";
  editor.innerHTML = `
    <h1>Riichi Mahjong Game Tree Explorer</h1> <p>Based on code from <a href="https://github.com/nekobean/mahjong-cpp">麻雀何切るシミュレーター</a> by <a href="https://github.com/nekobean">nekobean</a>.</p>
    <p>Copyright © 2026 alchzh. This site's source code is licensed under the <a href="https://www.gnu.org/licenses/gpl-3.0.en.html">GNU General Public License v3.0</a>.</p>
  `;

  editor.append(
    renderPystyleControlRows(state, rerender),
    renderScenarioBoard(state, rerender),
    renderPystyleTabBar(state, rerender),
    renderPystyleTabPanel(state, rerender),
    renderJsonPanel(state, rerender, runAnalysis)
  );

  const actions = document.createElement("div");
  actions.className = "button-row editor-actions";

  const analyze = document.createElement("button");
  analyze.textContent = "Analyze";
  analyze.addEventListener("click", runAnalysis);

  const reset = document.createElement("button");
  reset.className = "secondary";
  reset.textContent = "Reset sample";
  reset.addEventListener("click", () => {
    state.editor = scenarioToEditorState(SAMPLE_SCENARIO);
    state.jsonDraft = JSON.stringify(editorStateToScenario(state.editor), null, 2);
    state.result = undefined;
    state.graphResult = undefined;
    rerender();
  });

  actions.append(analyze, reset);
  editor.append(actions);

  section.append(editor);
  return section;
}

function renderPystyleControlRows(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "editor-controls";

  wrap.append(
    renderLabeledControl("Round wind", renderChoiceGroup(
      [Tile.East, Tile.South],
      state.editor.round.wind,
      (tile) => {
        state.editor.round.wind = tile;
        rerender();
      }
    )),
    renderLabeledControl("Seat wind", renderChoiceGroup(
      [Tile.East, Tile.South, Tile.West, Tile.North],
      state.editor.playerWind,
      (tile) => {
        state.editor.playerWind = tile;
        rerender();
      }
    )),
    renderLabeledControl("Current turn", renderTurnSelect(state, rerender)),
    renderToggleRow(state, rerender)
  );

  return wrap;
}

function renderLabeledControl(labelText: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "editor-row";
  const label = document.createElement("div");
  label.className = "editor-label";
  label.textContent = labelText;
  row.append(label, control);
  return row;
}

function renderChoiceGroup(options: number[], value: number, onChange: (tile: number) => void): HTMLElement {
  const group = document.createElement("div");
  group.className = "choice-group";
  options.forEach((tile) => {
    const button = document.createElement("button");
    button.className = value === tile ? "choice-button active" : "choice-button";
    button.textContent = windKanji(tile);
    button.addEventListener("click", () => onChange(tile));
    group.append(button);
  });
  return group;
}

function renderTurnSelect(state: AppState, rerender: () => void): HTMLElement {
  const select = document.createElement("select");
  select.className = "turn-select";
  for (let turn = 1; turn <= 18; turn += 1) {
    const option = document.createElement("option");
    option.value = String(turn);
    option.textContent = `Turn ${turn}`;
    option.selected = turn === state.editor.currentTurn;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const value = Number(select.value);
    state.editor.currentTurn = value;
    syncTurnConfig(state.editor);
    state.selectedTurn = value;
    rerender();
  });
  return select;
}

function renderToggleRow(state: AppState, rerender: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "editor-row";
  const label = document.createElement("div");
  label.className = "editor-label";
  label.textContent = "Rules";
  const body = document.createElement("div");
  body.className = "toggle-row";
  body.append(
    createToggle("Red dora", state.editor.config.enableReddora, (checked) => {
      state.editor.config.enableReddora = checked;
      rerender();
    }),
    createToggle("Ura dora", state.editor.config.enableUradora, (checked) => {
      state.editor.config.enableUradora = checked;
      rerender();
    }),
    createToggle("Riichi", state.editor.config.enableRiichi, (checked) => {
      state.editor.config.enableRiichi = checked;
      rerender();
    }),
    createToggle("Shanten back", state.editor.config.enableShantenDown, (checked) => {
      state.editor.config.enableShantenDown = checked;
      rerender();
    }),
    createToggle("Tegawari", state.editor.config.enableTegawari, (checked) => {
      state.editor.config.enableTegawari = checked;
      rerender();
    })
  );
  row.append(label, body);
  return row;
}

function createToggle(labelText: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const label = document.createElement("label");
  label.className = "toggle-chip";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  const text = document.createElement("span");
  text.className = "toggle-text";
  text.textContent = labelText;
  label.append(input, slider, text);
  return label;
}

function renderScenarioBoard(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "scenario-board pystyle-board";

  const header = document.createElement("div");
  header.className = "scenario-header pystyle-summary";
  const summary = document.createElement("div");
  summary.className = "scenario-roundline";
  summary.textContent = formatScenarioSummary(state.editor);
  const deadWall = renderDeadWall(state.editor, rerender);
  header.append(summary, deadWall);

  const handRow = document.createElement("div");
  handRow.className = "displayed-hand-row";
  if (state.editor.handTiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rack-empty";
    empty.textContent = "";
    handRow.append(empty);
  } else {
    sortTiles(state.editor.handTiles).forEach((tile, index) => {
      const button = document.createElement("button");
      button.className = "picker-tile display-tile";
      button.append(createTileImg(tile, "tile-img picker-tile-face"));
      button.title = `Remove ${tileName(tile)}`;
      button.addEventListener("click", () => {
        state.editor.handTiles.splice(index, 1);
        rerender();
      });
      handRow.append(button);
    });
  }

  if (state.editor.melds.length > 0) {
    const meldGap = createTileText("_", "tile-img meld-gap-face", "Meld gap");
    handRow.append(meldGap);
    state.editor.melds.forEach((meld, index) => {
      const button = document.createElement("button");
      button.className = "picker-tile display-tile meld-display";
      button.append(createTileText(meldNotation(meld.type, meld.tiles), "tile-img meld-display-face", "Meld"));
      button.addEventListener("click", () => {
        state.editor.melds.splice(index, 1);
        rerender();
      });
      handRow.append(button);
      if (index < state.editor.melds.length - 1) {
        handRow.append(createTileText("_", "tile-img meld-gap-face", "Meld gap"));
      }
    });
  }

  wrap.append(header, handRow);
  return wrap;
}

function renderDeadWall(editor: EditorState, rerender: () => void): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "deadwall-strip";
  const openStart = 2;
  const openTiles = editor.doraIndicators.slice(0, Math.max(0, 7 - openStart));
  for (let index = 0; index < 7; index += 1) {
    const slot = document.createElement("div");
    slot.className = "deadwall-slot";
    const openTile = openTiles[index - openStart];
    if (index >= openStart && openTile !== undefined) {
      const button = document.createElement("button");
      button.className = "picker-tile display-tile deadwall-open";
      button.append(createTileImg(openTile, "tile-img picker-tile-face"));
      button.title = `Remove ${tileName(openTile)}`;
      button.addEventListener("click", () => {
        const tileIndex = index - openStart;
        editor.doraIndicators.splice(tileIndex, 1);
        editor.round.doraIndicators = editor.doraIndicators.slice();
        rerender();
      });
      slot.append(button);
    } else {
      const back = createTileText("0z", "tile-img picker-tile-face deadwall-back", "Face-down tile");
      slot.append(back);
    }
    strip.append(slot);
  }
  return strip;
}

function renderPystyleTabBar(state: AppState, rerender: () => void): HTMLElement {
  const tabs = document.createElement("div");
  tabs.className = "editor-tabs";
  ([
    ["hand", "Hand tiles"],
    ["dora", "Dora indicators"],
    ["pon", "Pons"],
    ["chii", "Chiis"],
    ["minkan", "Open kans"],
    ["ankan", "Closed kans"],
    ["wall", "Remaining tiles"]
  ] as Array<[EditTarget, string]>).forEach(([target, label]) => {
    const button = document.createElement("button");
    button.className = target === state.editor.editTarget ? "editor-tab active" : "editor-tab";
    button.textContent = label;
    button.addEventListener("click", () => {
      state.editor.editTarget = target;
      rerender();
    });
    tabs.append(button);
  });
  return tabs;
}

function renderPystyleTabPanel(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "editor-panel";

  const note = document.createElement("div");
  note.className = "panel-note";
  note.textContent = state.editor.editTarget === "dora"
    ? "Set dora using indicator tiles. Up to five indicators are supported, including kan dora."
    : "";
  if (note.textContent) {
    wrap.append(note);
  }

  if (state.editor.editTarget === "wall") {
    wrap.append(renderWallCounts(state.editor));
    return wrap;
  }

  if (state.editor.editTarget === "pon") {
    wrap.append(...renderGroupedChoices(buildTripletChoices(), state.editor, rerender, (choice) => addMeldChoice(state.editor, 0, choice)));
    return wrap;
  }

  if (state.editor.editTarget === "chii") {
    wrap.append(...renderGroupedChoices(buildSequenceChoices(), state.editor, rerender, (choice) => addMeldChoice(state.editor, 1, choice)));
    return wrap;
  }

  if (state.editor.editTarget === "minkan") {
    wrap.append(...renderGroupedChoices(buildKanChoices(), state.editor, rerender, (choice) => addMeldChoice(state.editor, 3, choice)));
    return wrap;
  }

  if (state.editor.editTarget === "ankan") {
    wrap.append(...renderGroupedChoices(buildKanChoices(), state.editor, rerender, (choice) => addMeldChoice(state.editor, 2, choice)));
    return wrap;
  }

  wrap.append(...renderSingleTileChoices(state, rerender));
  return wrap;
}

function renderSingleTileChoices(state: AppState, rerender: () => void): HTMLElement[] {
  return TILE_GROUPS.map((group) => {
    const row = document.createElement("div");
    row.className = "picker-row";
    group.tiles.forEach((tile) => {
      const button = document.createElement("button");
      button.className = "picker-tile";
      button.append(createTileImg(tile, "tile-img picker-tile-face"));
      const remaining = remainingTileCopies(state.editor, tile);
      button.disabled = !canAddSingleTile(state.editor, tile, remaining);
      button.addEventListener("click", () => {
        if (state.editor.editTarget === "dora") {
          state.editor.doraIndicators.push(tile);
          state.editor.doraIndicators = sortTiles(state.editor.doraIndicators);
          state.editor.round.doraIndicators = state.editor.doraIndicators.slice();
        } else {
          state.editor.handTiles.push(tile);
          state.editor.handTiles = sortTiles(state.editor.handTiles);
        }
        rerender();
      });
      row.append(button);
    });
    return row;
  });
}

function renderGroupedChoices(
  groups: Array<{ key: string; choices: number[][] }>,
  editor: EditorState,
  rerender: () => void,
  onChoose: (choice: number[]) => void
): HTMLElement[] {
  return groups.map((group) => {
    const row = document.createElement("div");
    row.className = "picker-row";
    group.choices.forEach((choice) => {
      const button = document.createElement("button");
      button.className = "picker-tile meld-choice";
      if (editor.editTarget === "pon" || editor.editTarget === "chii" || editor.editTarget === "minkan") {
        button.append(createTileText(openMeldNotation(choice), "tile-img meld-choice-face", "Open meld"));
      } else {
        choice.forEach((tile) => button.append(createTileImg(tile, "tile-img picker-tile-face")));
      }
      button.disabled = !canAddChoice(editor, choice);
      button.addEventListener("click", () => {
        onChoose(choice);
        rerender();
      });
      row.append(button);
    });
    return row;
  });
}

function renderWallCounts(editor: EditorState): HTMLElement {
  const wall = getEditableWall(editor);
  const wrap = document.createElement("div");
  wrap.className = "wall-counts";
  TILE_GROUPS.forEach((group) => {
    const row = document.createElement("div");
    row.className = "wall-count-row";
    group.tiles.forEach((tile) => {
      const item = document.createElement("div");
      item.className = "wall-count-item";
      item.append(createTileImg(tile, "tile-img picker-tile-face"));
      const count = document.createElement("input");
      count.className = "wall-count-value";
      count.type = "number";
      count.min = "0";
      count.max = tile >= Tile.RedManzu5 ? "1" : "4";
      count.value = String(wall[tile] ?? 0);
      count.addEventListener("change", () => {
        wall[tile] = Math.max(0, Math.min(tile >= Tile.RedManzu5 ? 1 : 4, Number(count.value)));
        editor.wall = wall.slice();
        count.value = String(wall[tile]);
      });
      item.append(count);
      row.append(item);
    });
    wrap.append(row);
  });
  return wrap;
}

const isRedFive = (tile: Tile) => (
  tile === Tile.RedManzu5 ||
  tile === Tile.RedPinzu5 ||
  tile === Tile.RedSouzu5
);

function makeRedFiveNormal(tile: Tile) {
  switch (tile) {
    case Tile.RedManzu5:
      return Tile.Manzu5;
    case Tile.RedSouzu5:
      return Tile.Souzu5;
    case Tile.RedPinzu5:
      return Tile.Pinzu5;
    default:
      throw new Error(`Tile ${tile} is not a red 5!`);
  }
}


function makeTileRedFive(tile: Tile) {
  switch (tile) {
    case Tile.Manzu5:
    case Tile.RedManzu5:
      return Tile.RedManzu5;
    case Tile.Souzu5:
    case Tile.RedSouzu5:
      return Tile.RedSouzu5;
    case Tile.Pinzu5:
    case Tile.RedPinzu5:
      return Tile.RedPinzu5;
    default:
      throw new Error(`Tile ${tile} is not a 5!`);
  }
}

function buildTripletChoices(): Array<{ key: string; choices: number[][] }> {
  return TILE_GROUPS.map((group) => ({
    key: group.label,
    choices: group.tiles.map((tile) =>
      isRedFive(tile)
        ? [tile, makeRedFiveNormal(tile), makeRedFiveNormal(tile)]
        : [tile, tile, tile],
    ),
  }));
}

function buildKanChoices(): Array<{ key: string; choices: number[][] }> {
  return TILE_GROUPS.map((group) => ({
    key: group.label,
    choices: group.tiles
      .filter(
        (tile) => !isRedFive(tile),
      )
      .map((tile) => (
            tile === Tile.Manzu5 ||
            tile === Tile.Pinzu5 ||
            tile === Tile.Souzu5
          ) ? [tile, makeTileRedFive(tile), tile, tile] : [tile, tile, tile, tile]),
  }));
}

function buildSequenceChoices(): Array<{ key: string; choices: number[][] }> {
  const suits = [
    [Tile.Manzu1, Tile.Manzu2, Tile.Manzu3, Tile.Manzu4, Tile.Manzu5, Tile.Manzu6, Tile.Manzu7, Tile.Manzu8, Tile.Manzu9, Tile.RedManzu5],
    [Tile.Pinzu1, Tile.Pinzu2, Tile.Pinzu3, Tile.Pinzu4, Tile.Pinzu5, Tile.Pinzu6, Tile.Pinzu7, Tile.Pinzu8, Tile.Pinzu9, Tile.RedPinzu5],
    [Tile.Souzu1, Tile.Souzu2, Tile.Souzu3, Tile.Souzu4, Tile.Souzu5, Tile.Souzu6, Tile.Souzu7, Tile.Souzu8, Tile.Souzu9, Tile.RedSouzu5]
  ];
  return suits.map((tiles, index) => ({
    key: String(index),
    choices: [
      ...Array.from({ length: 7 }, (_, start) => [tiles[start]!, tiles[start + 1]!, tiles[start + 2]!]),
      [tiles[2], tiles[3], tiles[9]],
      [tiles[3], tiles[9], tiles[5]],
      [tiles[9], tiles[5], tiles[6]],
    ]
  }));
}

function canAddSingleTile(editor: EditorState, tile: number, remaining: number): boolean {
  if (remaining <= 0) {
    return false;
  }
  if (editor.editTarget === "dora") {
    return editor.doraIndicators.length < 5;
  }
  return editor.handTiles.length < Math.max(0, 14 - editor.melds.length * 3);
}

function canAddChoice(editor: EditorState, choice: number[]): boolean {
  if (editor.handTiles.length + (editor.melds.length + 1) * 3 > 14) {
    return false;
  }
  const need = new Map<number, number>();
  choice.forEach((tile) => need.set(tile, (need.get(tile) ?? 0) + 1));
  return Array.from(need.entries()).every(([tile, count]) => remainingTileCopies(editor, tile) >= count);
}

function addMeldChoice(editor: EditorState, type: number, choice: number[]): void {
  if (!canAddChoice(editor, choice)) {
    return;
  }
  editor.melds.push({
    type,
    tiles: choice.slice()
  });
}

function openMeldNotation(choice: number[]): string {
  if (choice.length <= 1) {
    return choice.map((tile) => tileLigature(tile)).join("");
  }
  return `${tileLigature(choice[0]!)}-${choice.slice(1).map((tile) => tileLigature(tile)).join("")}`;
}

function meldNotation(type: number, tiles: number[]): string {
  if (tiles.length === 0) {
    return "";
  }
  switch (type) {
    case MeldType.Pon:
    case MeldType.Chii:
    case MeldType.Minkan:
    case MeldType.Kakan:
      return openMeldNotation(tiles);
    case MeldType.Ankan:
      if (tiles.length >= 4) {
        return `0z${tileLigature(tiles[1]!)}${tileLigature(tiles[2]!)}0z`;
      }
      return `0z${tiles.map((tile) => tileLigature(tile)).join("")}0z`;
    default:
      return tiles.map((tile) => tileLigature(tile)).join("");
  }
}

function renderTargetTabs(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "segmented";
  (["hand", "dora", "pon", "chii", "minkan", "ankan", "wall"] as EditTarget[]).forEach((target) => {
    const button = document.createElement("button");
    button.className = target === state.editor.editTarget ? "segment active" : "segment";
    button.textContent =
      target === "hand" ? "Hand" :
      target === "dora" ? "Dora" :
      target === "pon" ? "Pon" :
      target === "chii" ? "Chii" :
      target === "minkan" ? "Open kan" :
      target === "ankan" ? "Closed kan" :
      "Wall";
    button.addEventListener("click", () => {
      state.editor.editTarget = target;
      rerender();
    });
    wrap.append(button);
  });
  return wrap;
}

function renderRack(label: string, tiles: number[], onRemove: (index: number) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile-zone";
  const head = document.createElement("div");
  head.className = "zone-head";
  head.innerHTML = `<h2>${label}</h2><span class="muted mono">${tiles.length} tiles</span>`;
  const rack = document.createElement("div");
  rack.className = "tile-rack";

  if (tiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rack-empty";
    empty.textContent = "Tap a tile below to add it here.";
    rack.append(empty);
  } else {
    sortTiles(tiles).forEach((tile, index) => {
      const button = document.createElement("button");
      button.className = "tile-button rack-tile";
      button.append(createTileImg(tile));
      button.title = `Remove ${tileName(tile)}`;
      button.addEventListener("click", () => onRemove(index));
      rack.append(button);
    });
  }

  wrap.append(head, rack);
  return wrap;
}

function renderMeldEditor(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile-zone";

  const head = document.createElement("div");
  head.className = "zone-head";
  head.innerHTML = "<h2>Melds</h2><span class='muted mono'>click tiles to build, then commit</span>";
  wrap.append(head);

  const existing = document.createElement("div");
  existing.className = "meld-list";
  state.editor.melds.forEach((meld, index) => {
    const item = document.createElement("div");
    item.className = "meld-item";
    const strip = document.createElement("div");
    strip.className = "tile-rack compact";
    meld.tiles.forEach((tile) => strip.append(createTileImg(tile, "tile-img small")));
    const label = document.createElement("span");
    label.className = "mono muted";
    label.textContent = meldTypeLabel(meld.type);
    const remove = document.createElement("button");
    remove.className = "secondary icon-text";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.editor.melds.splice(index, 1);
      rerender();
    });
    item.append(strip, label, remove);
    existing.append(item);
  });
  wrap.append(existing);

  const current = document.createElement("div");
  current.className = "meld-builder";
  const currentStrip = document.createElement("div");
  currentStrip.className = "tile-rack compact";
  if (state.editor.currentMeldTiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rack-empty";
    empty.textContent = "Current meld";
    currentStrip.append(empty);
  } else {
    sortTiles(state.editor.currentMeldTiles).forEach((tile, index) => {
      const button = document.createElement("button");
      button.className = "tile-button rack-tile";
      button.append(createTileImg(tile, "tile-img small"));
      button.addEventListener("click", () => {
        state.editor.currentMeldTiles.splice(index, 1);
        rerender();
      });
      currentStrip.append(button);
    });
  }

  const typeSelect = document.createElement("div");
  typeSelect.className = "segmented compact";
  [0, 1, 2, 3, 4].forEach((type) => {
    const button = document.createElement("button");
    button.className = type === state.editor.currentMeldType ? "segment active" : "segment";
    button.textContent = meldTypeLabel(type);
    button.addEventListener("click", () => {
      state.editor.currentMeldType = type;
      rerender();
    });
    typeSelect.append(button);
  });

  const actions = document.createElement("div");
  actions.className = "button-row";
  const commit = document.createElement("button");
  commit.textContent = "Commit meld";
  commit.disabled =
    state.editor.currentMeldTiles.length < 3 ||
    state.editor.handTiles.length + (state.editor.melds.length + 1) * 3 > 14;
  commit.addEventListener("click", () => {
    state.editor.melds.push({
      type: state.editor.currentMeldType,
      tiles: sortTiles(state.editor.currentMeldTiles.slice())
    });
    state.editor.currentMeldTiles = [];
    rerender();
  });
  const clear = document.createElement("button");
  clear.className = "secondary";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    state.editor.currentMeldTiles = [];
    rerender();
  });
  actions.append(commit, clear);

  current.append(currentStrip, typeSelect, actions);
  wrap.append(current);
  return wrap;
}

function renderTilePalette(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile-zone";
  const head = document.createElement("div");
  head.className = "zone-head";
  head.innerHTML = `<h2>Tile palette</h2><span class="muted mono">editing ${state.editor.editTarget}</span>`;
  wrap.append(head);

  TILE_GROUPS.forEach((group) => {
    const groupEl = document.createElement("div");
    groupEl.className = "palette-group";
    const title = document.createElement("h3");
    title.textContent = group.label;
    const row = document.createElement("div");
    row.className = "palette-row";

    group.tiles.forEach((tile) => {
      const button = document.createElement("button");
      button.className = "tile-button palette-tile";
      button.append(createTileImg(tile));
      const remaining = remainingTileCopies(state.editor, tile);
      const counter = document.createElement("span");
      counter.className = "tile-counter mono";
      counter.textContent = String(Math.max(0, remaining));
      button.append(counter);
      button.disabled = remaining <= 0 || !canAddTileToTarget(state.editor);
      button.title = `${tileName(tile)} remaining visible copies: ${remaining}`;
      button.addEventListener("click", () => {
        addTileToTarget(state.editor, tile);
        rerender();
      });
      row.append(button);
    });

    groupEl.append(title, row);
    wrap.append(groupEl);
  });

  return wrap;
}

function renderConfigControls(state: AppState, rerender: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tile-zone";
  const head = document.createElement("div");
  head.className = "zone-head";
  head.innerHTML = "<h2>Round and search</h2><span class='muted mono'>match the board state shown above</span>";
  wrap.append(head);

  const grid = document.createElement("div");
  grid.className = "form-grid";
  grid.append(
    numberField("Kyoku", state.editor.round.kyoku, (value) => {
      state.editor.round.kyoku = Math.max(1, value);
      rerender();
    }),
    numberField("Turn", state.editor.config.tMax, (value) => {
      state.editor.config.tMax = Math.max(state.editor.config.tMin, value);
      rerender();
    }),
    numberField("tMin", state.editor.config.tMin, (value) => {
      state.editor.config.tMin = Math.max(1, value);
      if (state.editor.config.tMin > state.editor.config.tMax) {
        state.editor.config.tMax = state.editor.config.tMin;
      }
      rerender();
    }),
    numberField("Extra", state.editor.config.extra, (value) => {
      state.editor.config.extra = Math.max(0, value);
      rerender();
    }),
    numberField("Honba", state.editor.round.honba, (value) => {
      state.editor.round.honba = Math.max(0, value);
      rerender();
    }),
    numberField("Kyotaku", state.editor.round.kyotaku, (value) => {
      state.editor.round.kyotaku = Math.max(0, value);
      rerender();
    })
  );
  wrap.append(grid);

  const windRow = document.createElement("div");
  windRow.className = "wind-row";
  windRow.append(
    windControl("Round wind", state.editor.round.wind, (tile) => {
      state.editor.round.wind = tile;
      rerender();
    }),
    windControl("Seat wind", state.editor.playerWind, (tile) => {
      state.editor.playerWind = tile;
      rerender();
    })
  );
  wrap.append(windRow);

  return wrap;
}

function renderJsonPanel(state: AppState, rerender: () => void, runAnalysis: () => void): HTMLElement {
  const details = document.createElement("details");
  details.className = "json-panel";
  details.innerHTML = "<summary><span>Advanced JSON</span><span class='muted'>import or inspect the full scenario</span></summary>";

  const body = document.createElement("div");
  body.className = "node-body";

  const textarea = document.createElement("textarea");
  textarea.value = state.jsonDraft;
  textarea.addEventListener("input", () => {
    state.jsonDraft = textarea.value;
  });

  const actions = document.createElement("div");
  actions.className = "button-row";
  const apply = document.createElement("button");
  apply.textContent = "Apply JSON";
  apply.addEventListener("click", () => {
    const scenario = JSON.parse(state.jsonDraft) as ScenarioInput;
    state.editor = scenarioToEditorState(scenario);
    runAnalysis();
  });
  const refresh = document.createElement("button");
  refresh.className = "secondary";
  refresh.textContent = "Refresh JSON";
  refresh.addEventListener("click", () => {
    state.jsonDraft = JSON.stringify(editorStateToScenario(state.editor), null, 2);
    rerender();
  });
  actions.append(apply, refresh);

  body.append(textarea, actions);
  details.append(body);
  return details;
}

function renderResults(state: AppState, rerender: () => void, focusGraphOnNode: (node?: SearchNode) => void): HTMLElement {
  const section = document.createElement("section");
  section.className = "results";

  if (state.error) {
    const error = document.createElement("section");
    error.className = "panel section";
    error.innerHTML = `<h2>Failed</h2><div class="warning">${escapeHtml(state.error)}</div>`;
    section.append(error);
    return section;
  }

  if (!state.result) {
    return section;
  }

  section.append(
    // renderSummary(state.result),
    renderGraphSection(state, rerender, focusGraphOnNode)
  );

  return section;
}

function renderSummary(result: CalculationResult): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel section";
  section.innerHTML = `
    <h2>Search summary</h2>
    <div class="stats-grid">
      <div class="stat-tile"><span class="stat-label">Vertices searched</span><span class="stat-value">${result.search.searchedVertices}</span></div>
      <div class="stat-tile"><span class="stat-label">Edges searched</span><span class="stat-value">${result.search.searchedEdges}</span></div>
      <div class="stat-tile"><span class="stat-label">Draw cache hits</span><span class="stat-value">${result.search.drawCacheHits}</span></div>
      <div class="stat-tile"><span class="stat-label">Discard cache hits</span><span class="stat-value">${result.search.discardCacheHits}</span></div>
      <div class="stat-tile"><span class="stat-label">Saved graph depth</span><span class="stat-value">${result.context.graphDepthLimit}</span></div>
    </div>
    ${result.warnings.length > 0 ? `<div class="warning-list">${result.warnings.map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`).join("")}</div>` : ""}
  `;
  return section;
}

function renderGraphSection(state: AppState, rerender: () => void, focusGraphOnNode: (node?: SearchNode) => void): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel section";
  section.innerHTML = "<h2>Game tree graph</h2>";

  const graphResult = state.graphResult ?? state.result;
  const focusId = graphResult?.rootNodeId;
  const focusNode = focusId && graphResult
    ? graphResult.nodes.find((node) => node.id === focusId)
    : undefined;

  const controlRow = document.createElement("div");
  controlRow.className = "graph-controls";
  controlRow.append(
    numberField("Turn", state.selectedTurn, (value) => {
      const next = Math.max(state.editor.config.tMin, Math.min(state.editor.config.tMax, value));
      state.selectedTurn = next;
      rerender();
    })
  );

  const focusBar = document.createElement("div");
  focusBar.className = "graph-focusbar";
  focusBar.append(controlRow);
  if (focusNode) {
    focusBar.append(renderGraphFocusHand(state.editor, focusNode, state.graphResult ? () => {
      state.graphResult = undefined;
      state.selectedTurn = state.editor.currentTurn;
      rerender();
    } : undefined));
  }
  section.append(focusBar);

  const graphLayout = document.createElement("div");
  graphLayout.className = "graph-layout";
  const graphHost = document.createElement("div");
  graphHost.className = "graph-host";
  if (focusId && graphResult) {
    graphHost.append(renderGraphSvg(graphResult, focusId, state.selectedTurn, (nodeId) => {
      focusGraphOnNode(graphResult.nodes.find((node) => node.id === nodeId));
      rerender();
    }));
  }

  graphLayout.append(graphHost);
  section.append(graphLayout);
  return section;
}

function renderGraphFocusHand(editor: EditorState, node: SearchNode, onResetFocus?: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "graph-focus-hand";

  const label = document.createElement("div");
  label.className = "field";
  const title = document.createElement("span");
  title.className = "field-label";
  title.textContent = "Current hand";
  label.append(title);

  const hand = document.createElement("div");
  hand.className = "graph-focus-tiles";
  hand.append(...countToTileIds(node.hand).map((tile) => createTileImg(tile, "tile-img")));
  if (editor.melds.length > 0) {
    editor.melds.forEach((meld) => {
      hand.append(createTileText("_", "tile-img meld-gap-face", "Meld gap"));
      hand.append(createTileText(meldNotation(meld.type, meld.tiles), "tile-img meld-display-face", "Meld"));
    });
  }

  label.append(hand);
  if (onResetFocus) {
    const resetFocus = document.createElement("button");
    resetFocus.className = "secondary graph-focus-action";
    resetFocus.textContent = "Original root";
    resetFocus.addEventListener("click", onResetFocus);
    label.append(resetFocus);
  }
  wrap.append(label);
  return wrap;
}

function renderGraphSvg(
  result: CalculationResult,
  rootId: string,
  turn: number,
  onSelect: (nodeId: string) => void
): HTMLElement {
  const graph = buildFocusedGraphLayout(result, rootId, turn);
  const width = Math.max(920, graph.width);
  const height = Math.max(420, graph.height);
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "tree-svg");

  graph.edges.forEach((edge) => {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(edge.x1));
    line.setAttribute("y1", String(edge.y1));
    line.setAttribute("x2", String(edge.x2));
    line.setAttribute("y2", String(edge.y2));
    line.setAttribute("stroke", edge.kind === "chance" ? "#0f6a54" : "#a64b00");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("opacity", "0.55");
    svg.append(line);
  });

  graph.cards.forEach((item) => {
    const group = document.createElementNS(svgNS, "g");
    group.setAttribute("transform", `translate(${item.x}, ${item.y})`);
    group.setAttribute("class", "graph-node");

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("width", String(item.width));
    rect.setAttribute("height", String(item.height));
    rect.setAttribute("rx", "10");
    rect.setAttribute("fill", item.fill);
    rect.setAttribute("stroke", item.stroke);
    rect.setAttribute("stroke-width", item.strokeWidth);
    group.append(rect);

    if (item.branchTile !== undefined) {
      if (item.action !== undefined) {
        const action = document.createElementNS(svgNS, "text");
        action.setAttribute("x", "33");
        action.setAttribute("y", "20");
        action.setAttribute("text-anchor", "middle")
        action.setAttribute("class", "svg-sub");
        action.textContent = item.action;
        group.append(action);
      }

      const tile = document.createElementNS(svgNS, "text");
      tile.setAttribute("x", "20");
      tile.setAttribute("y", "65");
      tile.setAttribute("class", "svg-card-tile");
      tile.textContent = tileLigature(item.branchTile);
      group.append(tile);
    }

    if (item.title) {
      const title = document.createElementNS(svgNS, "text");
      title.setAttribute("x", String(item.contentX));
      title.setAttribute("y", "22");
      title.setAttribute("class", "svg-label");
      title.textContent = item.title;
      group.append(title);
    }

    item.lines.forEach((lineDef, index) => {
      const line = document.createElementNS(svgNS, "text");
      line.setAttribute("x", String(item.contentX));
      line.setAttribute("y", String(item.lineStartY + index * 16));
      line.setAttribute("class", lineDef.emphasis ? "svg-value" : "svg-sub");
      line.textContent = lineDef.text;
      group.append(line);
    });

    if (item.nodeId) {
      group.addEventListener("click", () => onSelect(item.nodeId!));
    }
    svg.append(group);
  });

  graph.optionLists.forEach((list) => {
    const group = document.createElementNS(svgNS, "g");
    group.setAttribute("transform", `translate(${list.x}, ${list.y})`);

    const title = document.createElementNS(svgNS, "text");
    title.setAttribute("x", "0");
    title.setAttribute("y", "0");
    title.setAttribute("class", "svg-label");
    title.textContent = list.title;
    group.append(title);

    const rowStartY = 20;

    if (list.compact) {
      list.rows.forEach((row, index) => {
        const columnIndex = index % GRAPH_COMPACT_OPTION_TILES_PER_ROW;
        const rowIndex = Math.floor(index / GRAPH_COMPACT_OPTION_TILES_PER_ROW);
        const tileGroup = document.createElementNS(svgNS, "g");
        tileGroup.setAttribute("transform", `translate(${columnIndex * GRAPH_COMPACT_OPTION_TILE_STEP}, ${rowStartY + rowIndex * GRAPH_COMPACT_OPTION_TILE_STEP})`);
        const tile = document.createElementNS(svgNS, "text");
        tile.setAttribute("x", "0");
        tile.setAttribute("y", "0");
        tile.setAttribute("class", "svg-tile-small");
        tile.textContent = tileLigature(row.tile);
        if (row.nodeId) {
          tileGroup.setAttribute("style", "cursor: pointer;");
          tile.setAttribute("style", "pointer-events: auto; cursor: pointer;");
          tileGroup.addEventListener("click", () => onSelect(row.nodeId!));
          const hitArea = document.createElementNS(svgNS, "rect");
          hitArea.setAttribute("x", "-2");
          hitArea.setAttribute("y", "-20");
          hitArea.setAttribute("width", "24");
          hitArea.setAttribute("height", "24");
          hitArea.setAttribute("fill", "transparent");
          hitArea.setAttribute("pointer-events", "all");
          const tooltip = document.createElementNS(svgNS, "title");
          tooltip.textContent = `Explore draw ${tileName(row.tile)}`;
          tileGroup.append(tooltip);
          tileGroup.append(hitArea);
        }
        tileGroup.append(tile);
        group.append(tileGroup);
      });
    } else {
      const columnWidth = 180;
      const rowHeight = 18;
      list.rows.forEach((row, index) => {
        const columnIndex = Math.floor(index / GRAPH_OPTION_ROWS);
        const rowIndex = index % GRAPH_OPTION_ROWS;
        const columnX = columnIndex * columnWidth;
        const rowY = rowStartY + rowIndex * rowHeight;

        const tile = document.createElementNS(svgNS, "text");
        tile.setAttribute("x", String(columnX));
        tile.setAttribute("y", String(rowY));
        tile.setAttribute("class", "svg-tile-small");
        tile.textContent = tileLigature(row.tile);
        group.append(tile);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", String(columnX + 20));
        text.setAttribute("y", String(rowY - 2));
        text.setAttribute("class", "svg-sub");
        text.textContent = row.text ?? "";
        group.append(text);
      });
    }

    svg.append(group);
  });

  const host = document.createElement("div");
  host.className = "tree-canvas";
  host.append(svg);
  return host;
}

function renderNodeDetailPanel(editor: EditorState, nodes: SearchNode[], node: SearchNode, turn: number, title: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "node-detail-panel";
  wrap.innerHTML = `<h3>${title}</h3>`;

  const summary = document.createElement("div");
  summary.className = "stats-grid compact-grid";
  summary.innerHTML = `
    <div class="stat-tile"><span class="stat-label">Phase</span><span class="stat-value">${node.phase}</span></div>
    <div class="stat-tile"><span class="stat-label">Shanten</span><span class="stat-value">${node.shanten}</span></div>
    <div class="stat-tile"><span class="stat-label">Riichi</span><span class="stat-value">${node.riichi ? "Yes" : "No"}</span></div>
    <div class="stat-tile"><span class="stat-label">EV @ t${turn}</span><span class="stat-value">${formatNumber(node.expScore[turn] ?? 0)}</span></div>
    <div class="stat-tile"><span class="stat-label">Win @ t${turn}</span><span class="stat-value">${formatPercent(node.winProb[turn] ?? 0)}</span></div>
    <div class="stat-tile"><span class="stat-label">Tenpai @ t${turn}</span><span class="stat-value">${formatPercent(node.tenpaiProb[turn] ?? 0)}</span></div>
  `;

  const hand = document.createElement("div");
  hand.className = "detail-hand";
  hand.append(...countToTileIds(node.hand).map((tile) => createTileImg(tile, "tile-img small")));
  if (editor.melds.length > 0) {
    editor.melds.forEach((meld) => {
      hand.append(createTileText("_", "tile-img meld-gap-face", "Meld gap"));
      hand.append(createTileText(meldNotation(meld.type, meld.tiles), "tile-img meld-display-face", "Meld"));
    });
  }

  const turns = document.createElement("div");
  turns.className = "detail-turns";
  const nodeMap = new Map(nodes.map((item) => [item.id, item]));
  node.turnBreakdowns
    .filter((breakdown) => breakdown.turn === turn)
    .forEach((breakdown) => {
      const header = document.createElement("div");
      header.className = "turn-summary mono";
      header.textContent = `t${breakdown.turn} · wall ${breakdown.remainingWallTiles} · tenpai ${formatPercent(breakdown.tenpai)} · win ${formatPercent(breakdown.win)} · EV ${formatNumber(breakdown.expScore)}`;
      turns.append(header);

      const branches = document.createElement("div");
      branches.className = "branch-grid";
      if (breakdown.chanceBranches) {
        breakdown.chanceBranches.forEach((branch) => {
          const item = document.createElement("div");
          item.className = "branch-card";
          item.append(createTileImg(branch.tile, "tile-img small"));
          const copy = document.createElement("div");
          copy.className = "branch-copy mono";
          const target = nodeMap.get(branch.targetNodeId);
          copy.textContent = `p ${formatPercent(branch.probability)} · EV ${formatSigned(branch.contributionExpScore)} · win ${formatPercent(target?.winProb[turn + 1] ?? 0)} · tenpai ${formatPercent(target?.tenpaiProb[turn + 1] ?? 0)}${branch.immediateScore > 0 ? ` · win value ${formatNumber(branch.immediateScore)}` : ""}${target?.riichi ? " · riichi" : ""}`;
          item.append(copy);
          branches.append(item);
        });
      }
      if (breakdown.decisionBranches) {
        breakdown.decisionBranches.forEach((branch) => {
          const item = document.createElement("div");
          item.className = "branch-card";
          item.append(createTileImg(branch.tile, "tile-img small"));
          const copy = document.createElement("div");
          copy.className = "branch-copy mono";
          const source = nodeMap.get(branch.sourceNodeId);
          copy.textContent = `EV ${formatNumber(branch.expScore)} · win ${formatPercent(branch.win)} · tenpai ${formatPercent(branch.tenpai)}${source?.riichi ? " · riichi" : ""}`;
          item.append(copy);
          branches.append(item);
        });
      }
      turns.append(branches);
    });

  wrap.append(summary, hand, turns);
  return wrap;
}

function numberField(label: string, value: number, onChange: (value: number) => void): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const title = document.createElement("span");
  title.className = "field-label";
  title.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("change", () => onChange(Number(input.value)));
  wrap.append(title, input);
  return wrap;
}

function windControl(label: string, value: number, onChange: (tile: number) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const title = document.createElement("span");
  title.className = "field-label";
  title.textContent = label;
  const segmented = document.createElement("div");
  segmented.className = "segmented compact";
  [Tile.East, Tile.South, Tile.West, Tile.North].forEach((tile) => {
    const button = document.createElement("button");
    button.className = value === tile ? "segment active" : "segment";
    button.append(createTileImg(tile, "tile-img small"));
    button.addEventListener("click", () => onChange(tile));
    segmented.append(button);
  });
  wrap.append(title, segmented);
  return wrap;
}

function scenarioToEditorState(input: ScenarioInput): EditorState {
  const config = { ...createDefaultConfig(), ...input.config };
  const currentTurn = Math.max(1, Math.min(18, input.currentTurn ?? config.tMin));
  const round = {
    ...createDefaultRound(),
    ...input.round,
    doraIndicators: (input.round?.doraIndicators ?? []).map(normalizeTile),
    uradoraIndicators: (input.round?.uradoraIndicators ?? []).map(normalizeTile)
  };
  const handCount = input.player.hand ? input.player.hand.slice() : tilesToHand(input.player.tiles ?? []);
  const editorState: EditorState = {
    config,
    currentTurn,
    round,
    playerWind: input.player.wind ?? Tile.East,
    handTiles: sortTiles(countToTileIds(handCount)),
    doraIndicators: sortTiles(round.doraIndicators.slice()),
    uradoraIndicators: sortTiles(round.uradoraIndicators.slice()),
    melds: (input.player.melds ?? []).map((meld) => ({
      type: meld.type ?? 0,
      tiles: sortTiles(meld.tiles.map(normalizeTile))
    })),
    currentMeldTiles: [],
    currentMeldType: 0,
    editTarget: "hand",
    wall: input.wall?.slice()
  };
  syncTurnConfig(editorState);
  return editorState;
}

function editorStateToScenario(editor: EditorState): ScenarioInput {
  return {
    config: { ...editor.config },
    currentTurn: editor.currentTurn,
    round: {
      rules: editor.round.rules,
      wind: editor.round.wind,
      kyoku: editor.round.kyoku,
      honba: editor.round.honba,
      kyotaku: editor.round.kyotaku,
      doraIndicators: editor.doraIndicators.map((tile) => tileName(tile)),
      uradoraIndicators: editor.uradoraIndicators.map((tile) => tileName(tile))
    },
    player: {
      wind: editor.playerWind,
      tiles: editor.handTiles.map((tile) => tileName(tile)),
      melds: editor.melds.map((meld) => ({
        type: meld.type,
        tiles: meld.tiles.map((tile) => tileName(tile))
      }))
    },
    wall: editor.wall?.slice()
  };
}

function syncTurnConfig(editor: EditorState): void {
  const currentTurn = Math.max(1, Math.min(18, editor.currentTurn));
  editor.currentTurn = currentTurn;
  editor.config.tMin = currentTurn;
  editor.config.tMax = 18;
}

function createWallFromEditor(editor: EditorState): number[] {
  const hand = tilesToHand(editor.handTiles);
  const wall = Array.from({ length: 37 }, () => 0);
  const melds = Array.from({ length: 37 }, () => 0);
  const indicators = Array.from({ length: 37 }, () => 0);

  editor.doraIndicators.forEach((tile) => {
    indicators[tile] += 1;
  });
  editor.melds.forEach((meld) => {
    meld.tiles.forEach((tile) => {
      melds[tile] += 1;
    });
  });

  for (let tile = 0; tile < 34; tile += 1) {
    wall[tile] = Math.max(0, 4 - ((hand[tile] ?? 0) + (melds[tile] ?? 0) + (indicators[tile] ?? 0)));
  }
  for (let tile = 34; tile < 37; tile += 1) {
    wall[tile] = Math.max(0, 1 - ((hand[tile] ?? 0) + (melds[tile] ?? 0) + (indicators[tile] ?? 0)));
  }

  return wall;
}

function getEditableWall(editor: EditorState): number[] {
  if (!editor.wall) {
    editor.wall = createWallFromEditor(editor);
  }
  return editor.wall.slice();
}

function buildPlayerFromEditor(editor: EditorState): Player {
  return {
    hand: tilesToHand(editor.handTiles),
    melds: editor.melds.map((meld) => ({
      type: meld.type,
      tiles: meld.tiles.slice(),
      discardedTile: meld.tiles[0] ?? Tile.Null,
      from: -1
    })),
    wind: editor.playerWind
  };
}

function formatScenarioSummary(editor: EditorState): string {
  return `${windKanji(editor.round.wind)}${editor.round.kyoku}局 ${editor.round.honba}本場 ${seatLabel(editor.playerWind)} ${editor.currentTurn}巡目`;
}

function windKanji(tile: number): string {
  switch (tile) {
    case Tile.East:
      return "東";
    case Tile.South:
      return "南";
    case Tile.West:
      return "西";
    case Tile.North:
      return "北";
    default:
      return "東";
  }
}

function seatLabel(tile: number): string {
  switch (tile) {
    case Tile.East:
      return "東家";
    case Tile.South:
      return "南家";
    case Tile.West:
      return "西家";
    case Tile.North:
      return "北家";
    default:
      return "東家";
  }
}

function normalizeTile(tile: string | number): number {
  return typeof tile === "number" ? tile : parseTile(tile);
}

function tileSortOrder(tile: Tile) {
  switch (tile) {
    case Tile.RedManzu5:
    case Tile.RedPinzu5:
    case Tile.RedSouzu5:
      return makeRedFiveNormal(tile) - 0.5;
    default:
      return tile;
  }
}

function sortTiles(tiles: number[]): number[] {
  return tiles.slice().sort((left, right) => tileSortOrder(left) - tileSortOrder(right));
}

function addTileToTarget(editor: EditorState, tile: number): void {
  if (editor.editTarget === "hand") {
    if (editor.handTiles.length >= Math.max(0, 14 - editor.melds.length * 3)) {
      return;
    }
    editor.handTiles.push(tile);
    editor.handTiles = sortTiles(editor.handTiles);
    return;
  }
  if (editor.editTarget === "dora") {
    editor.doraIndicators.push(tile);
    editor.doraIndicators = sortTiles(editor.doraIndicators);
    editor.round.doraIndicators = editor.doraIndicators.slice();
  }
}

function canAddTileToTarget(editor: EditorState): boolean {
  if (editor.editTarget === "hand") {
    return editor.handTiles.length < Math.max(0, 14 - editor.melds.length * 3);
  }
  if (editor.editTarget === "dora") {
    return editor.doraIndicators.length < 5;
  }
  return false;
}

function remainingTileCopies(editor: EditorState, tile: number): number {
  const used = explicitTileUsage(editor);
  const total = tile >= Tile.RedManzu5 ? 1 : 4;
  if (tile === Tile.Manzu5 || tile === Tile.Pinzu5 || tile === Tile.Souzu5) {
    return total - totalBaseFiveUsage(editor, tile);
  }
  if (tile >= Tile.RedManzu5) {
    return total - (used.get(tile) ?? 0);
  }
  return total - (used.get(tile) ?? 0);
}

function explicitTileUsage(editor: EditorState): Map<number, number> {
  const usage = new Map<number, number>();
  const add = (tile: number): void => {
    usage.set(tile, (usage.get(tile) ?? 0) + 1);
  };
  [...editor.handTiles, ...editor.doraIndicators, ...editor.uradoraIndicators, ...editor.currentMeldTiles].forEach(add);
  editor.melds.forEach((meld) => meld.tiles.forEach(add));
  return usage;
}

function redVariantUsage(editor: EditorState, baseTile: number): number {
  const usage = explicitTileUsage(editor);
  if (baseTile === Tile.Manzu5) return usage.get(Tile.RedManzu5) ?? 0;
  if (baseTile === Tile.Pinzu5) return usage.get(Tile.RedPinzu5) ?? 0;
  if (baseTile === Tile.Souzu5) return usage.get(Tile.RedSouzu5) ?? 0;
  return 0;
}

function totalBaseFiveUsage(editor: EditorState, baseTile: number): number {
  const usage = explicitTileUsage(editor);
  return (usage.get(baseTile) ?? 0) + redVariantUsage(editor, baseTile);
}

function meldTypeLabel(type: number): string {
  switch (type) {
    case 0: return "Pon";
    case 1: return "Chii";
    case 2: return "Closed kan";
    case 3: return "Open kan";
    case 4: return "Added kan";
    default: return "Meld";
  }
}

function buildFocusedGraphLayout(result: CalculationResult, rootId: string, turn: number) {
  const nodeMap = new Map(result.nodes.map((node) => [node.id, node]));
  const root = nodeMap.get(rootId);
  if (!root) {
    return { cards: [], edges: [], optionLists: [], width: 920, height: 420 };
  }

  const rootChildren = immediateGraphChildren(root, turn, nodeMap);
  const graphTurnMax = Math.max(0, root.expScore.length - 1);
  const startY = 30;
  const rowGap = 14;
  const rootX = 30;
  const childX = 308;
  const optionX = childX + GRAPH_NODE_WIDTH + 22;

  const childRows = rootChildren.map((child) => {
    const childTurn = child.kind === "node" && child.node
      ? transitionTurn(root.phase, child.node.phase, turn, graphTurnMax)
      : turn;
    const optionList = child.kind === "node" && child.node
      ? optionListForNode(child.node, childTurn, nodeMap)
      : child.kind === "aggregate"
        ? child.optionList
        : undefined;
    const optionHeight = optionList ? graphOptionListHeight(optionList) : 0;
    return {
      child,
      childTurn,
      optionList,
      height: Math.max(GRAPH_NODE_HEIGHT, optionHeight || 0)
    };
  });

  const rootY = startY;

  const cards: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    stroke: string;
    strokeWidth: string;
    title?: string;
    lines: Array<{ text: string; emphasis?: boolean }>;
    branchTile?: number;
    contentX: number;
    lineStartY: number;
    nodeId?: string;
    action?: string;
  }> = [
    graphCardFromNode(root, turn, 1, rootX, rootY, true)
  ];
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number; kind: "chance" | "decision"; tile: number }> = [];
  const optionLists: Array<{ x: number; y: number; kind: "chance" | "decision"; title: string; rows: GraphOptionRow[]; compact?: boolean }> = [];

  let maxOptionListColumns = 3;

  let currentY = startY;
  childRows.forEach(({ child, childTurn, optionList, height }) => {
    const childY = currentY;
    if (child.kind === "node" && child.node) {
      cards.push(
        graphCardFromNode(child.node, turn, child.probability, childX, childY, false, `${child.edgeKind === "chance" ? "Draw" : "Discard"} ${tileName(child.tile)}`)
      );
    } else if (child.kind === "agari") {
      cards.push(graphAgariCard(child, childX, childY, `${child.edgeKind === "chance" ? "Draw" : "Discard"} ${tileName(child.tile)}`));
    } else if (child.kind === "aggregate") {
      cards.push(graphAggregateCard(child, childX, childY));
    }
    edges.push({
      x1: rootX + GRAPH_NODE_WIDTH,
      y1: rootY + GRAPH_NODE_HEIGHT / 2,
      x2: childX,
      y2: childY + GRAPH_NODE_HEIGHT / 2,
      kind: child.edgeKind,
      tile: child.kind === "aggregate" ? Tile.Null : child.tile
    });
    if (optionList && optionList.rows.length > 0) {
      optionLists.push({
        x: optionX,
        y: childY + 10,
        kind: optionList.kind,
        title: optionList.title,
        rows: optionList.rows,
        compact: optionList.compact
      });
      const optionListColumns = graphOptionListColumnCount(optionList);
      if (optionListColumns > maxOptionListColumns) {
        maxOptionListColumns = optionListColumns;
      }
    }
    currentY += height + rowGap;
  });

  return {
    cards,
    edges,
    optionLists,
    width: optionX + maxOptionListColumns * GRAPH_OPTION_WIDTH + 40,
    height: Math.max(rootY + GRAPH_NODE_HEIGHT + 20, currentY - rowGap + 20)
  };
}

function graphCardFromNode(
  node: SearchNode,
  turn: number,
  probability: number,
  x: number,
  y: number,
  isRoot: boolean,
  branchLabel?: string,
  childTitle?: string
) {
  const immediateWinValue = nodeImmediateWinValue(node, turn);
  const lines = [
    ...(probability < 0.999 ? [{ text: `Prob ${formatPercent(probability)}` }] : []),
    { text: `EV ${formatNumber(node.expScore[turn] ?? 0)}`, emphasis: true },
    { text: `Win ${formatPercent(node.winProb[turn] ?? 0)}` },
    { text: `Tenpai ${formatPercent(node.tenpaiProb[turn] ?? 0)}` },
    { text: immediateWinValue > 0 ? `Win value ${formatNumber(immediateWinValue)}` : `Shanten ${node.shanten}` }
  ];
  const isRiichi = node.riichi && node.shanten === 0;
  const contentX = isRoot ? 12 : 80;
  const effectiveChildTitle = !isRoot ? (childTitle ?? (isRiichi ? "Riichi" : undefined)) : undefined;
  const hasChildTitle = Boolean(effectiveChildTitle);
  return {
    x,
    y,
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
    fill: node.phase === "draw" ? "#e8f5ef" : "#fff0dd",
    stroke: isRoot ? "#111111" : "#bda983",
    strokeWidth: isRoot ? "2.4" : "1.4",
    title: isRoot ? `${node.phase === "draw" ? "Draw" : "Discard"} node${isRiichi ? " · Riichi" : ""}` : effectiveChildTitle,
    lines,
    branchTile: isRoot ? undefined : parseBranchTile(branchLabel),
    action: `${node.phase === "draw" ? "Discard" : "Draw"}`,
    contentX,
    lineStartY: isRoot || hasChildTitle ? 38 : 22,
    nodeId: node.id
  };
}

function graphAgariCard(
  child: {
    tile: number;
    probability: number;
    immediateScore: number;
    baseScore: number;
    uradoraHitProbability: number;
    edgeKind: "chance" | "decision";
    evContribution: number;
    aggregate?: boolean;
  },
  x: number,
  y: number,
  branchLabel: string
) {
  return {
    x,
    y,
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
    fill: "#eef6ff",
    stroke: "#bda983",
    strokeWidth: "1.4",
    title: "Agari",
    lines: child.aggregate
      ? [
          { text: `Win prob ${formatPercent(child.probability)}` },
          { text: `EV contrib ${formatNumber(child.evContribution)}`, emphasis: true },
          { text: `Avg payout ${formatNumber(child.immediateScore)}` },
          { text: `Base value ${formatInteger(child.baseScore)}` },
          { text: `Uradora ${formatPercent(child.uradoraHitProbability)}` }
        ]
      : [
          { text: `Draw prob ${formatPercent(child.probability)}` },
          { text: `EV contrib ${formatNumber(child.evContribution)}`, emphasis: true },
          { text: `Win value ${formatNumber(child.immediateScore)}` },
          { text: `Base value ${formatInteger(child.baseScore)}` },
          { text: `Uradora ${formatPercent(child.uradoraHitProbability)}` }
        ],
    branchTile: child.tile,
    contentX: 62,
    lineStartY: 32
  };
}

function graphAggregateCard(
  child: Extract<FocusedGraphChild, { kind: "aggregate" }>,
  x: number,
  y: number
) {
  return {
    x,
    y,
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
    fill: "#f5f5f2",
    stroke: "#bda983",
    strokeWidth: "1.4",
    title: "Tsumogiri",
    lines: [
      { text: `Prob ${formatPercent(child.probability)}` },
      { text: `EV ${formatNumber(child.averageExpScore)}`, emphasis: true },
      { text: `Win ${formatPercent(child.averageWin)}` },
      { text: `Tenpai ${formatPercent(child.averageTenpai)}` },
      { text: `${child.branchCount} draws` }
    ],
    contentX: 12,
    lineStartY: 36
  };
}

function graphOptionListHeight(optionList: GraphOptionList): number {
  if (optionList.compact) {
    return 26 + Math.ceil(optionList.rows.length / GRAPH_COMPACT_OPTION_TILES_PER_ROW) * GRAPH_COMPACT_OPTION_TILE_STEP;
  }
  return 26 + Math.min(optionList.rows.length, GRAPH_OPTION_ROWS) * 18;
}

function graphOptionListColumnCount(optionList: GraphOptionList): number {
  if (optionList.compact) {
    return 1;
  }
  return Math.ceil(optionList.rows.length / GRAPH_OPTION_ROWS);
}

function immediateGraphChildren(root: SearchNode, turn: number, nodeMap: Map<string, SearchNode>) {
  const breakdown = root.turnBreakdowns.find((item) => item.turn === turn);
  if (!breakdown) {
    return [];
  }
  if (root.phase === "draw") {
    const chanceBranches = breakdown.chanceBranches ?? [];
    const sortedAgariBranches = chanceBranches
      .filter((branch) => branch.immediateScore > 0)
      .sort((left, right) => (right.probability * right.immediateScore) - (left.probability * left.immediateScore) || right.probability - left.probability)
      .map((branch) => ({
        kind: "agari" as const,
        tile: branch.tile,
        probability: branch.probability,
        immediateScore: branch.immediateScore,
        baseScore: branch.baseScore,
        uradoraHitProbability: branch.uradoraHitProbability,
        edgeKind: "chance" as const,
        evContribution: branch.probability * branch.immediateScore
      }));

    if (root.shanten === 0 && root.riichi) {
      return (breakdown.winTileBreakdowns ?? []).map((entry) => ({
        kind: "agari" as const,
        tile: entry.tile,
        probability: entry.winProbability,
        immediateScore: entry.averageWinValue,
        baseScore: entry.averageBaseValue,
        uradoraHitProbability: entry.averageUradoraHitProbability,
        edgeKind: "chance" as const,
        evContribution: entry.evContribution,
        aggregate: true
      }));
    }

    const tsumogiriBranches = root.allowTegawari
      ? chanceBranches.filter((branch) => branch.immediateScore <= 0 && isPreferredTsumogiriBranch(root, branch, turn, nodeMap))
      : [];
    const tsumogiriBranchKeys = new Set(tsumogiriBranches.map((branch) => `${branch.targetNodeId}:${branch.tile}`));
    const tsumogiriAggregate = tsumogiriBranches.length > 1
      ? aggregateTsumogiriBranches(tsumogiriBranches)
      : undefined;
    const residualTsumogiriAggregate = !root.allowTegawari && !root.riichi
      ? aggregateResidualTsumogiri(root, breakdown, turn, chanceBranches)
      : undefined;

    const sortedDecisionBranches = chanceBranches
      .filter((branch) => !tsumogiriBranchKeys.has(`${branch.targetNodeId}:${branch.tile}`))
      .map((branch) => ({
        kind: "node" as const,
        node: nodeMap.get(branch.targetNodeId),
        tile: branch.tile,
        probability: branch.probability,
        immediateScore: branch.immediateScore,
        edgeKind: "chance" as const,
        sortEv: nodeMap.get(branch.targetNodeId)?.expScore[turn] ?? branch.realizedExpScore,
        title: nodeMap.get(branch.targetNodeId)
          ? continuationTitle(root, nodeMap.get(branch.targetNodeId)!, Math.min(root.expScore.length - 1, turn + 1), nodeMap)
          : undefined
      }))
      .filter((branch): branch is {
        kind: "node";
        node: SearchNode;
        tile: number;
        probability: number;
        immediateScore: number;
        edgeKind: "chance";
        sortEv: number;
        title: string | undefined;
      } => Boolean(branch.node))
      .sort((left, right) => right.sortEv - left.sortEv || right.probability - left.probability);

    return [
      ...sortedAgariBranches,
      ...sortedDecisionBranches,
      ...(tsumogiriAggregate ? [tsumogiriAggregate] : []),
      ...(residualTsumogiriAggregate ? [residualTsumogiriAggregate] : [])
    ];
  }

  return (breakdown.decisionBranches ?? [])
    .map((branch) => ({
      kind: "node" as const,
      node: nodeMap.get(branch.sourceNodeId),
      tile: branch.tile,
      probability: 1,
      immediateScore: 0,
      edgeKind: "decision" as const,
      sortEv: branch.expScore,
      title: undefined as string | undefined
    }))
    .filter((branch): branch is {
      kind: "node";
      node: SearchNode;
      tile: number;
      probability: number;
      immediateScore: number;
      edgeKind: "decision";
      sortEv: number;
      title: string | undefined;
    } => Boolean(branch.node))
    .sort((left, right) => right.sortEv - left.sortEv || left.tile - right.tile);
}

function isPreferredTsumogiriBranch(
  root: SearchNode,
  branch: EdgeTurnBreakdown,
  turn: number,
  nodeMap: Map<string, SearchNode>
): boolean {
  const target = nodeMap.get(branch.targetNodeId);
  if (!target || target.phase !== "discard") {
    return false;
  }
  const nextTurn = transitionTurn(root.phase, target.phase, turn, Math.max(0, root.expScore.length - 1));
  const breakdown = target.turnBreakdowns.find((item) => item.turn === nextTurn);
  const bestDecision = breakdown?.decisionBranches
    ?.slice()
    .sort((left, right) => right.expScore - left.expScore || left.tile - right.tile)[0];
  return bestDecision?.tile === branch.tile;
}

function aggregateTsumogiriBranches(branches: EdgeTurnBreakdown[]): FocusedGraphChild {
  const probability = branches.reduce((sum, branch) => sum + branch.probability, 0);
  const weighted = <K extends "realizedExpScore" | "targetWin" | "targetTenpai">(key: K): number => {
    if (probability <= 0) {
      return 0;
    }
    return branches.reduce((sum, branch) => sum + branch.probability * branch[key], 0) / probability;
  };
  const rows = branches
    .slice()
    .sort((left, right) => left.tile - right.tile)
    .map((branch) => ({
      tile: branch.tile,
      nodeId: branch.targetNodeId
    }));

  return {
    kind: "aggregate",
    edgeKind: "chance",
    probability,
    averageExpScore: weighted("realizedExpScore"),
    averageWin: weighted("targetWin"),
    averageTenpai: weighted("targetTenpai"),
    branchCount: branches.length,
    optionList: {
      kind: "chance",
      title: "Collapsed draws",
      rows,
      compact: true
    }
  };
}

function aggregateResidualTsumogiri(
  node: SearchNode,
  breakdown: NonNullable<SearchNode["turnBreakdowns"][number]>,
  turn: number,
  explicitBranches: EdgeTurnBreakdown[]
): FocusedGraphChild | undefined {
  if (turn + 1 >= node.expScore.length || breakdown.remainingWallTiles <= 0) {
    return undefined;
  }
  const explicitWeight = explicitBranches.reduce((sum, branch) => sum + branch.weight, 0);
  const residualWeight = breakdown.remainingWallTiles - explicitWeight;
  if (residualWeight <= 0) {
    return undefined;
  }
  const explicitTiles = new Set(explicitBranches.map((branch) => branch.tile));
  const branchCount = node.wall.reduce((count, tileCount, tile) => (
    tileCount > 0 && !explicitTiles.has(tile) ? count + 1 : count
  ), 0);

  return {
    kind: "aggregate",
    edgeKind: "chance",
    probability: residualWeight / breakdown.remainingWallTiles,
    averageExpScore: node.expScore[turn + 1] ?? 0,
    averageWin: node.winProb[turn + 1] ?? 0,
    averageTenpai: node.tenpaiProb[turn + 1] ?? 0,
    branchCount
  };
}

function optionListForNode(node: SearchNode, turn: number, nodeMap: Map<string, SearchNode>): GraphOptionList | undefined {
  const breakdown = node.turnBreakdowns.find((item) => item.turn === turn);
  if (!breakdown) {
    return undefined;
  }
  if (node.phase === "discard") {
    const rows = (breakdown.decisionBranches ?? [])
      .slice()
      .sort((left, right) => right.expScore - left.expScore)
      .slice(0, SECOND_DEPTH_BRANCH_LIMIT)
      .map((branch) => ({
        tile: branch.tile,
        text: `EV ${formatNumber(branch.expScore)}`
      }));
    return rows.length > 0 ? { kind: "decision" as const, title: "Top discards", rows } : undefined;
  }

  const chanceBranches = breakdown.chanceBranches ?? [];
  if (node.shanten === 0) {
    const rows = chanceBranches
      .filter((branch) => branch.immediateScore > 0)
      .sort((left, right) => right.immediateScore - left.immediateScore || right.probability - left.probability)
      .map((branch) => ({
        tile: branch.tile,
        text: `${formatPercent(branch.probability)} · ${formatNumber(branch.immediateScore)}`
      }));
    return rows.length > 0 ? { kind: "chance" as const, title: "Agari", rows } : undefined;
  }

  const visibleChanceBranches = node.allowTegawari
    ? chanceBranches.filter((branch) => !isPreferredTsumogiriBranch(node, branch, turn, nodeMap))
    : chanceBranches;
  const rows = visibleChanceBranches
    .sort((left, right) => right.realizedExpScore - left.realizedExpScore || right.probability - left.probability)
    .map((branch) => ({
      tile: branch.tile,
      text: `${formatPercent(branch.probability)} · EV ${formatNumber(branch.realizedExpScore)}`
    }));
  return rows.length > 0 ? { kind: "chance" as const, title: "Draws", rows } : undefined;
}

function continuationTitle(rootDrawNode: SearchNode, discardNode: SearchNode, turn: number, nodeMap: Map<string, SearchNode>): string | undefined {
  if (rootDrawNode.phase !== "draw" || discardNode.phase !== "discard") {
    return undefined;
  }
  const breakdown = discardNode.turnBreakdowns.find((item) => item.turn === turn);
  const bestBranch = breakdown?.decisionBranches
    ?.slice()
    .sort((left, right) => right.expScore - left.expScore || left.tile - right.tile)[0];
  const nextDraw = bestBranch ? nodeMap.get(bestBranch.sourceNodeId) : undefined;
  if (!nextDraw) {
    return undefined;
  }
  return nextDraw.shanten === rootDrawNode.shanten && nextDraw.actionMask === rootDrawNode.actionMask
    ? "Same wait"
    : "Hand change";
}

function nodeImmediateWinValue(node: SearchNode, turn: number): number {
  return Math.max(
    0,
    ...(node.turnBreakdowns.find((breakdown) => breakdown.turn === turn)?.chanceBranches?.map((branch) => branch.immediateScore) ?? [0])
  );
}

function transitionTurn(sourcePhase: "draw" | "discard", targetPhase: "draw" | "discard", turn: number, tMax: number): number {
  if (sourcePhase === "draw" && targetPhase === "discard") {
    return Math.min(tMax, turn + 1);
  }
  return turn;
}

function parseBranchTile(branchLabel?: string): number | undefined {
  if (!branchLabel) {
    return undefined;
  }
  const parts = branchLabel.split(" ");
  const tile = parts[1];
  return tile ? parseTile(tile) : undefined;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatInteger(value: number): string {
  return Math.round(value).toString();
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
