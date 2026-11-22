/**
 * Minimal, zero-dependency, read-only SQLite 3 database table reader.
 * Used to inspect Clip Studio Paint (.sut) sub-tool SQLite databases across Browser, Electron, and Node.
 * Implements the public-domain SQLite 3 file format (B-tree table pages, overflow pages, and record serial types).
 */

export type SqliteValue = null | number | string | Uint8Array;
export type SqliteRow = Record<string, SqliteValue>;

interface TableMeta {
  name: string;
  rootPage: number;
  columns: string[];
}

const SQLITE_MAGIC = 'SQLite format 3\0';
const MAX_PAGES_PER_SCAN = 4096;
const MAX_OVERFLOW_HOPS = 1024;

export function isSqlite3Buffer(buf: Uint8Array): boolean {
  if (buf.length < 100) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (buf[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Extracts column names from a SQLite CREATE TABLE statement.
 */
export function parseCreateTableColumns(sql: string): string[] {
  const openIdx = sql.indexOf('(');
  const closeIdx = sql.lastIndexOf(')');
  if (openIdx === -1 || closeIdx <= openIdx) return [];
  const body = sql.slice(openIdx + 1, closeIdx);

  const columns: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  const pushDef = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Skip table-level constraints
    if (/^(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(trimmed)) return;
    let colName = '';
    const first = trimmed[0];
    if (first === '"' || first === '`' || first === '\'') {
      const endQuote = trimmed.indexOf(first, 1);
      if (endQuote > 1) colName = trimmed.slice(1, endQuote);
    } else if (first === '[') {
      const endBracket = trimmed.indexOf(']', 1);
      if (endBracket > 1) colName = trimmed.slice(1, endBracket);
    } else {
      const match = /^([^\s,]+)/.exec(trimmed);
      if (match) colName = match[1];
    }
    if (colName) columns.push(colName);
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      pushDef(body.slice(start, i));
      start = i + 1;
    }
  }
  pushDef(body.slice(start));
  return columns;
}

export class SqliteReader {
  private buf: Uint8Array;
  private view: DataView;
  private pageSize: number;
  private usableSize: number;
  private textEncoding: number;
  private tables = new Map<string, TableMeta>();

  constructor(input: Uint8Array) {
    this.buf = input;
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    if (!isSqlite3Buffer(input)) {
      throw new Error('Not a SQLite 3 database');
    }
    const rawPageSize = this.view.getUint16(16, false);
    this.pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    if (this.pageSize < 512 || this.pageSize > 65536) {
      throw new Error(`Unsupported SQLite page size: ${this.pageSize}`);
    }
    const reserved = this.buf[20];
    this.usableSize = this.pageSize - reserved;
    if (this.usableSize < 480) {
      throw new Error('Invalid SQLite usable page size');
    }
    this.textEncoding = this.view.getUint32(56, false) || 1;
    this.loadSchema();
  }

  public getTableNames(): string[] {
    return Array.from(this.tables.values()).map((t) => t.name);
  }

  public getTableColumns(tableName: string): string[] {
    const meta = this.tables.get(tableName.toLowerCase());
    return meta ? [...meta.columns] : [];
  }

  public readTable(tableName: string, maxRows = 512): SqliteRow[] {
    const meta = this.tables.get(tableName.toLowerCase());
    if (!meta || meta.rootPage < 1) return [];
    const rawRecords = this.scanTableBTree(meta.rootPage, maxRows);
    return rawRecords.map(({ rowId, values }) => {
      const row: SqliteRow = { _rowid: rowId };
      for (let i = 0; i < meta.columns.length; i++) {
        const col = meta.columns[i];
        const val = i < values.length ? values[i] : null;
        // SQLite INTEGER PRIMARY KEY alias stores NULL in the record payload and uses the B-tree rowid
        row[col] = val === null && i === 0 && /^_?pw_?id$|^id$|^rowid$/i.test(col) ? rowId : val;
      }
      return row;
    });
  }

  private loadSchema(): void {
    const masterRows = this.scanTableBTree(1, 512);
    for (const { values } of masterRows) {
      const type = typeof values[0] === 'string' ? values[0].toLowerCase() : '';
      const name = typeof values[1] === 'string' ? values[1] : '';
      const rootPage = typeof values[3] === 'number' ? values[3] : 0;
      const sql = typeof values[4] === 'string' ? values[4] : '';
      if (type === 'table' && name && rootPage >= 1 && sql) {
        this.tables.set(name.toLowerCase(), {
          name,
          rootPage,
          columns: parseCreateTableColumns(sql),
        });
      }
    }
  }

  private scanTableBTree(rootPage: number, maxRows: number): Array<{ rowId: number; values: SqliteValue[] }> {
    const results: Array<{ rowId: number; values: SqliteValue[] }> = [];
    const visited = new Set<number>();
    const stack: number[] = [rootPage];

    while (stack.length > 0 && results.length < maxRows && visited.size < MAX_PAGES_PER_SCAN) {
      const pageNum = stack.pop()!;
      if (pageNum < 1 || visited.has(pageNum)) continue;
      visited.add(pageNum);

      const pageStart = (pageNum - 1) * this.pageSize;
      if (pageStart + 12 > this.buf.length) continue;
      const hdr = pageNum === 1 ? 100 : pageStart;
      if (hdr + 8 > this.buf.length) continue;

      const pageType = this.buf[hdr];
      const cellCount = this.view.getUint16(hdr + 3, false);

      if (pageType === 0x05) {
        // Interior table B-tree page
        if (hdr + 12 + cellCount * 2 > this.buf.length) continue;
        const rightChild = this.view.getUint32(hdr + 8, false);
        const children: number[] = [];
        for (let i = 0; i < cellCount; i++) {
          const ptr = this.view.getUint16(hdr + 12 + i * 2, false);
          const cellPos = pageStart + ptr;
          if (cellPos + 4 <= this.buf.length) {
            children.push(this.view.getUint32(cellPos, false));
          }
        }
        if (rightChild >= 1) children.push(rightChild);
        // Push in reverse so leftmost pages are popped first
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]);
        }
      } else if (pageType === 0x0d) {
        // Leaf table B-tree page
        if (hdr + 8 + cellCount * 2 > this.buf.length) continue;
        for (let i = 0; i < cellCount && results.length < maxRows; i++) {
          const ptr = this.view.getUint16(hdr + 8 + i * 2, false);
          const cellPos = pageStart + ptr;
          if (cellPos >= this.buf.length) continue;

          const pVar = this.readVarint(cellPos);
          const payloadSize = pVar.value;
          const rVar = this.readVarint(pVar.next);
          const rowId = rVar.value;
          const payloadStart = rVar.next;
          if (payloadSize <= 0 || payloadStart >= this.buf.length) continue;

          const payload = this.readCellPayload(payloadStart, payloadSize);
          if (!payload) continue;
          const values = this.decodeRecord(payload);
          results.push({ rowId, values });
        }
      }
    }

    return results;
  }

  private readCellPayload(localStart: number, payloadSize: number): Uint8Array | null {
    const U = this.usableSize;
    const X = U - 35;
    if (payloadSize <= X) {
      if (localStart + payloadSize > this.buf.length) return null;
      return this.buf.subarray(localStart, localStart + payloadSize);
    }

    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((payloadSize - M) % (U - 4));
    const localSize = K <= X ? K : M;
    if (localSize < 0 || localStart + localSize + 4 > this.buf.length) return null;

    const out = new Uint8Array(payloadSize);
    out.set(this.buf.subarray(localStart, localStart + localSize), 0);
    let written = localSize;
    let overflowPage = this.view.getUint32(localStart + localSize, false);
    let hops = 0;

    while (written < payloadSize && overflowPage >= 1 && hops < MAX_OVERFLOW_HOPS) {
      hops++;
      const pageStart = (overflowPage - 1) * this.pageSize;
      if (pageStart + 4 > this.buf.length) break;
      const nextPage = this.view.getUint32(pageStart, false);
      const chunkMax = Math.min(U - 4, this.buf.length - (pageStart + 4));
      const toCopy = Math.min(payloadSize - written, chunkMax);
      if (toCopy <= 0) break;
      out.set(this.buf.subarray(pageStart + 4, pageStart + 4 + toCopy), written);
      written += toCopy;
      overflowPage = nextPage;
    }

    return written === payloadSize ? out : out.subarray(0, written);
  }

  private decodeRecord(payload: Uint8Array): SqliteValue[] {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const hdrVar = this.readVarintFrom(payload, 0);
    const headerEnd = Math.min(payload.length, hdrVar.value);
    const serialTypes: number[] = [];
    let pos = hdrVar.next;
    while (pos < headerEnd) {
      const st = this.readVarintFrom(payload, pos);
      serialTypes.push(st.value);
      pos = st.next;
    }

    const values: SqliteValue[] = [];
    let dataPos = headerEnd;
    for (const st of serialTypes) {
      if (st === 0) {
        values.push(null);
      } else if (st === 1) {
        values.push(dataPos + 1 <= payload.length ? view.getInt8(dataPos) : null);
        dataPos += 1;
      } else if (st === 2) {
        values.push(dataPos + 2 <= payload.length ? view.getInt16(dataPos, false) : null);
        dataPos += 2;
      } else if (st === 3) {
        if (dataPos + 3 <= payload.length) {
          let v = (payload[dataPos] << 16) | (payload[dataPos + 1] << 8) | payload[dataPos + 2];
          if (v & 0x800000) v -= 0x1000000;
          values.push(v);
        } else {
          values.push(null);
        }
        dataPos += 3;
      } else if (st === 4) {
        values.push(dataPos + 4 <= payload.length ? view.getInt32(dataPos, false) : null);
        dataPos += 4;
      } else if (st === 5) {
        if (dataPos + 6 <= payload.length) {
          const hi = view.getInt16(dataPos, false);
          const lo = view.getUint32(dataPos + 2, false);
          values.push(hi * 0x100000000 + lo);
        } else {
          values.push(null);
        }
        dataPos += 6;
      } else if (st === 6) {
        if (dataPos + 8 <= payload.length) {
          const hi = view.getInt32(dataPos, false);
          const lo = view.getUint32(dataPos + 4, false);
          values.push(hi * 0x100000000 + lo);
        } else {
          values.push(null);
        }
        dataPos += 8;
      } else if (st === 7) {
        values.push(dataPos + 8 <= payload.length ? view.getFloat64(dataPos, false) : null);
        dataPos += 8;
      } else if (st === 8) {
        values.push(0);
      } else if (st === 9) {
        values.push(1);
      } else if (st >= 12 && st % 2 === 0) {
        const len = (st - 12) / 2;
        if (dataPos + len <= payload.length) {
          values.push(payload.slice(dataPos, dataPos + len));
        } else {
          values.push(new Uint8Array(0));
        }
        dataPos += len;
      } else if (st >= 13 && st % 2 === 1) {
        const len = (st - 13) / 2;
        if (dataPos + len <= payload.length) {
          values.push(this.decodeText(payload.subarray(dataPos, dataPos + len)));
        } else {
          values.push('');
        }
        dataPos += len;
      } else {
        values.push(null);
      }
    }
    return values;
  }

  private decodeText(bytes: Uint8Array): string {
    if (this.textEncoding === 2) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (this.textEncoding === 3) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  private readVarint(offset: number): { value: number; next: number } {
    return this.readVarintFrom(this.buf, offset);
  }

  private readVarintFrom(buf: Uint8Array, offset: number): { value: number; next: number } {
    let value = 0;
    let pos = offset;
    for (let i = 0; i < 8 && pos < buf.length; i++) {
      const b = buf[pos++];
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return { value, next: pos };
    }
    if (pos < buf.length) {
      value = value * 256 + buf[pos++];
    }
    return { value, next: pos };
  }
}
