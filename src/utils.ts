import { MeldType, TILE_NAME_TO_ID, TILE_NAMES, Tile } from "./constants.js";
import { Count, Meld, Player } from "./model.js";

export function createCount(fill = 0): Count {
  return Array.from({ length: 37 }, () => fill);
}

export function cloneCount(count: Count): Count {
  return count.slice();
}

export function clonePlayer(player: Player): Player {
  return {
    hand: cloneCount(player.hand),
    melds: player.melds.map((meld) => ({
      type: meld.type,
      tiles: meld.tiles.slice(),
      discardedTile: meld.discardedTile,
      from: meld.from
    })),
    wind: player.wind
  };
}

export function parseTile(token: string): number {
  const tile = TILE_NAME_TO_ID.get(token.trim());
  if (tile === undefined) {
    throw new Error(`Unknown tile token: ${token}`);
  }
  return tile;
}

export function tilesToHand(tiles: Array<number | string>, numMelds = 0): Count {
  const hand = createCount();
  for (const rawTile of tiles) {
    const tile = typeof rawTile === "string" ? parseTile(rawTile) : rawTile;
    if (tile < 0 || tile >= Tile.Length) {
      throw new Error(`Invalid tile id: ${tile}`);
    }
    if (tile === Tile.RedManzu5) {
      hand[Tile.Manzu5] += 1;
    } else if (tile === Tile.RedPinzu5) {
      hand[Tile.Pinzu5] += 1;
    } else if (tile === Tile.RedSouzu5) {
      hand[Tile.Souzu5] += 1;
    }
    hand[tile] += 1;
  }
  validateHand(hand, numMelds);
  return hand;
}

export function validateHand(hand: Count, numMelds = 0): void {
  if (numMelds < 0 || numMelds > 4) {
    throw new Error(`Hand must have between 0 and 4 melds: ${numMelds}`);
  }

  let totalTiles = 0;
  for (let i = 0; i < 34; i += 1) {
    if (hand[i] < 0 || hand[i] > 4) {
      throw new Error(`Invalid tile count at ${TILE_NAMES[i]}: ${hand[i]}`);
    }
    totalTiles += hand[i];
  }
  // Each meld is set aside from the concealed hand, so it shrinks it by three tiles.
  const closedTiles = 13 - numMelds * 3;
  if (totalTiles !== closedTiles && totalTiles !== closedTiles + 1) {
    throw new Error(
      numMelds > 0
        ? `Hand must have ${closedTiles} or ${closedTiles + 1} tiles with ${numMelds} meld(s)!`
        : "Hand must have 13 or 14 tiles!"
    );
  }

  for (let i = 34; i < 37; i += 1) {
    if (hand[i] < 0 || hand[i] > 1) {
      throw new Error(`Invalid red tile flag at ${TILE_NAMES[i]}: ${hand[i]}`);
    }
  }
  if (hand[Tile.RedManzu5] > hand[Tile.Manzu5]) {
    throw new Error("0m flag specified but 5m is not included.");
  }
  if (hand[Tile.RedPinzu5] > hand[Tile.Pinzu5]) {
    throw new Error("0p flag specified but 5p is not included.");
  }
  if (hand[Tile.RedSouzu5] > hand[Tile.Souzu5]) {
    throw new Error("0s flag specified but 5s is not included.");
  }
}

export function numTiles(hand: Count): number {
  let total = 0;
  for (let i = 0; i < 34; i += 1) {
    total += hand[i];
  }
  return total;
}

export function numPlayerTiles(player: Player): number {
  return numTiles(player.hand);
}

export function numMeldTiles(melds: Meld[]): number {
  return melds.length * 3;
}

export function isClosed(player: Player): boolean {
  return player.melds.every((meld) => meld.type === MeldType.Ankan);
}

export function toNoReddora(tile: number): number {
  if (tile <= Tile.Red) {
    return tile;
  }
  if (tile === Tile.RedManzu5) {
    return Tile.Manzu5;
  }
  if (tile === Tile.RedPinzu5) {
    return Tile.Pinzu5;
  }
  return Tile.Souzu5;
}

export function isReddora(tile: number): boolean {
  return tile >= Tile.RedManzu5;
}

export function isHonor(tile: number): boolean {
  return tile >= Tile.East && tile <= Tile.Red;
}

export function isTerminal(tile: number): boolean {
  const n = tile % 9;
  return tile <= Tile.Souzu9 && (n === 0 || n === 8);
}

export function isTerminalOrHonor(tile: number): boolean {
  return isHonor(tile) || isTerminal(tile);
}

export function tileName(tile: number): string {
  if (tile === Tile.Null) {
    return "null";
  }
  return TILE_NAMES[tile] ?? String(tile);
}

export function maskHas(mask: bigint, tile: number): boolean {
  return (mask & (1n << BigInt(tile))) !== 0n;
}

export function addTileToMask(mask: bigint, tile: number): bigint {
  return mask | (1n << BigInt(tile));
}

export function countToTileList(hand: Count): string[] {
  return countToTileIds(hand).map((tile) => tileName(tile));
}

export function countToTileIds(hand: Count): number[] {
  const tiles: number[] = [];
  for (let tile = 0; tile < 34; tile += 1) {
    let count = hand[tile];
    if (tile === Tile.Manzu5 && hand[Tile.RedManzu5] > 0) {
      count -= hand[Tile.RedManzu5];
      for (let i = 0; i < hand[Tile.RedManzu5]; i += 1) {
        tiles.push(Tile.RedManzu5);
      }
    } else if (tile === Tile.Pinzu5 && hand[Tile.RedPinzu5] > 0) {
      count -= hand[Tile.RedPinzu5];
      for (let i = 0; i < hand[Tile.RedPinzu5]; i += 1) {
        tiles.push(Tile.RedPinzu5);
      }
    } else if (tile === Tile.Souzu5 && hand[Tile.RedSouzu5] > 0) {
      count -= hand[Tile.RedSouzu5];
      for (let i = 0; i < hand[Tile.RedSouzu5]; i += 1) {
        tiles.push(Tile.RedSouzu5);
      }
    }
    for (let i = 0; i < count; i += 1) {
      tiles.push(tile);
    }
  }
  return tiles;
}

export function handSummary(hand: Count): string {
  return countToTileList(hand).join(" ");
}
