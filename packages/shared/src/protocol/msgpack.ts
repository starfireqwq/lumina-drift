import { decode, encode } from '@msgpack/msgpack';
import { AtelierPacket } from '../types/protocol';

/**
 * Wraps the socket.io parser so one op may carry a whole canvas of tiles.
 * socket.io sends every tile as its own binary attachment and the stock parser drops the entire
 * connection above 10 of them, so any op touching more than 10 tiles (a long stroke, a fill, a
 * transform, a filter) was lost for everyone and never saved. Server AND client must use this.
 * 4096 = 64x64 tiles, a full repaint of the largest canvas (16384px).
 * Takes the parser module as an argument so this package needs no socket.io dependency.
 */
export function tileSocketParser<P extends { Decoder: new (...args: any[]) => any }>(parser: P): P {
  return {
    ...parser,
    Decoder: class extends parser.Decoder {
      constructor(..._args: any[]) {
        super({ maxAttachments: 4096 });
      }
    },
  };
}

/**
 * Encodes an AtelierPacket into a MessagePack binary Uint8Array.
 */
export function encodePacket(packet: AtelierPacket): Uint8Array {
  return encode(packet);
}

/**
 * Decodes a binary payload (Uint8Array, ArrayBuffer, or Buffer) back into an AtelierPacket.
 */
export function decodePacket(data: Uint8Array | ArrayBuffer | ArrayLike<number>): AtelierPacket {
  if (data instanceof Uint8Array) {
    return decode(data) as AtelierPacket;
  }
  if (data instanceof ArrayBuffer) {
    return decode(new Uint8Array(data)) as AtelierPacket;
  }
  return decode(new Uint8Array(data)) as AtelierPacket;
}
