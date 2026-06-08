export interface ShantenLookupTable {
  keys: Uint32Array;
  values: Uint32Array;
  offsets: Int32Array;
}

export interface ShantenTableRow {
  values: Uint32Array;
  offset: number;
}

export interface ShantenLookupTables {
  suits: ShantenLookupTable;
  honors: ShantenLookupTable;
}

const VALUES_PER_ROW = 10;
const RECORD_SIZE = 4 + VALUES_PER_ROW * 4;
const SUITS_TABLE_URL = new URL("../data/config/shanten_suits_table.bin", import.meta.url);
const HONORS_TABLE_URL = new URL("../data/config/shanten_honors_table.bin", import.meta.url);

let cachedTables: ShantenLookupTables | undefined;

export function getShantenLookupTables(): ShantenLookupTables {
  cachedTables ??= {
    suits: decodeLookupTable(loadTableBytes(SUITS_TABLE_URL)),
    honors: decodeLookupTable(loadTableBytes(HONORS_TABLE_URL))
  };
  return cachedTables;
}

export function readTableRow(table: ShantenLookupTable, hash: number): ShantenTableRow {
  const offset = table.offsets[hash];
  if (offset === undefined || offset < 0) {
    throw new Error(`Missing shanten table entry for hash ${hash}.`);
  }
  return { values: table.values, offset };
}

export function readDistanceFromRow(row: ShantenTableRow, slot: number): number {
  return row.values[row.offset + slot] & 0xf;
}

export function readWaitMaskFromRow(row: ShantenTableRow, slot: number): number {
  return (row.values[row.offset + slot] >>> 4) & 0x1ff;
}

export function readDiscardMaskFromRow(row: ShantenTableRow, slot: number): number {
  return (row.values[row.offset + slot] >>> 13) & 0x1ff;
}

function loadTableBytes(url: URL): Uint8Array {
  const request = new XMLHttpRequest();
  request.open("GET", url.href, false);
  request.responseType = "arraybuffer";
  request.send();

  if (request.status !== 200 && request.status !== 0) {
    throw new Error(`Failed to load shanten table ${url.href}: ${request.status}`);
  }
  if (!(request.response instanceof ArrayBuffer)) {
    throw new Error(`Invalid shanten table response from ${url.href}.`);
  }

  return new Uint8Array(request.response);
}

function decodeLookupTable(bytes: Uint8Array): ShantenLookupTable {
  const size = bytes.byteLength / RECORD_SIZE;
  if (!Number.isInteger(size)) {
    throw new Error("Invalid shanten table encoding.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keys = new Uint32Array(size);
  const values = new Uint32Array(size * VALUES_PER_ROW);
  const maxKey = view.getInt32((size - 1) * RECORD_SIZE, true);
  const offsets = new Int32Array(maxKey + 1);
  offsets.fill(-1);

  for (let row = 0, offset = 0; row < size; row += 1, offset += RECORD_SIZE) {
    keys[row] = view.getInt32(offset, true);
    offsets[keys[row]] = row * VALUES_PER_ROW;
    for (let slot = 0; slot < VALUES_PER_ROW; slot += 1) {
      values[row * VALUES_PER_ROW + slot] = view.getUint32(offset + 4 + slot * 4, true);
    }
  }

  return { keys, values, offsets };
}
