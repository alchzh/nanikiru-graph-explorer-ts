import { Tile } from "./constants.js";
import { tileName } from "./utils.js";

export function tileLigature(tile: number): string {
  switch (tile) {
    case Tile.RedManzu5:
      return "5m*";
    case Tile.RedPinzu5:
      return "5p*";
    case Tile.RedSouzu5:
      return "5s*";
    default:
      return tileName(tile);
  }
}

export function createTileImg(tile: number, className = "tile-img", alt?: string): HTMLSpanElement {
  return createTileText(tileLigature(tile), className, alt ?? tileName(tile));
}

export function createTileText(text: string, className = "tile-img", alt = text): HTMLSpanElement {
  const glyph = document.createElement("span");
  glyph.className = `tile-face ${className}`;
  glyph.textContent = text;
  glyph.setAttribute("role", "img");
  glyph.setAttribute("aria-label", alt);
  glyph.title = alt;
  return glyph;
}
