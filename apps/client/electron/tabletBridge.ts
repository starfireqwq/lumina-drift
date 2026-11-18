import path from 'node:path';
import type { WinTabSample } from './tabletProtocol';

const headerSize = 16;
const packetSize = 36;
const packetBatch = 64;
const needsCapacity = 0x80000000;
const maxInkHistory = 16_384;

type Position = Pick<WinTabSample, 'x' | 'y'>;

export function openTabletBridge(resources: string, windowHandle: Buffer) {
  const addon = require(path.join(resources, 'wintab', 'wintab.node')) as { execute(buffer: Buffer): Buffer };
  function allocate(capacity: number) {
    const buffer = Buffer.alloc(headerSize + capacity * packetSize);
    windowHandle.copy(buffer, 8, 0, 8);
    return buffer;
  }
  let command = allocate(packetBatch);

  function execute(action: number, argument = 0) {
    command.writeUInt32LE(action, 0);
    command.writeUInt32LE(argument, 4);
    addon.execute(command);
    return command.readUInt32LE(4);
  }
  if (execute(6) !== 0x41544c36) throw new Error('Tablet bridge version mismatch');

  function read(count: number, independentCapture: boolean, position: (x: number, y: number) => Position) {
    if (!count || count > (command.length - headerSize) / packetSize) return [];
    const now = Date.now();
    const samples: WinTabSample[] = [];
    for (let i = 0; i < count; i++) {
      const offset = headerSize + i * packetSize;
      const age = command.readUInt32LE(offset + 8);
      const flags = command.readUInt32LE(offset + 20);
      const messageAge = command.readUInt32LE(offset + 32);
      samples.push({
        ...position(command.readInt32LE(offset), command.readInt32LE(offset + 4)),
        time: age <= 1000 ? now - age : now,
        cursor: command.readUInt32LE(offset + 12),
        pressure: command.readUInt32LE(offset + 16) / 1_000_000,
        contact: Boolean(flags & 1),
        eraser: Boolean(flags & 2),
        gapBefore: Boolean(flags & 4),
        down: Boolean(flags & 8),
        newestInMessage: Boolean(flags & 16),
        serial: command.readUInt32LE(offset + 24),
        capturedAt: independentCapture ? now - command.readUInt32LE(offset + 28) : now,
        messageAt: !independentCapture && messageAge <= 1000 ? now - messageAge : undefined,
        drainedAt: now,
      });
    }
    return samples;
  }

  return {
    execute,
    drain(action: number, position: (x: number, y: number) => Position) {
      const packets: WinTabSample[] = [];
      let count: number;
      do {
        count = execute(action);
        packets.push(...read(count, true, position));
      } while (count === packetBatch);
      return packets;
    },
    ink(cursor: number, position: (x: number, y: number) => Position) {
      let count = execute(3, cursor);
      if (count >= needsCapacity) {
        const required = count - needsCapacity;
        if (required <= maxInkHistory) {
          command = allocate(required);
          count = execute(3, cursor);
        }
        if (count >= needsCapacity) count = execute(5, cursor);
      }
      return read(count, false, position);
    },
  };
}
