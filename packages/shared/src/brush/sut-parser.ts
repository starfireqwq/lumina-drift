/**
 * Clip Studio Paint (.sut) Sub-Tool Brush Parser
 * Extracts embedded PNG/JPEG brush tip textures and sub-tool configurations.
 */

import { ParsedBrushTip } from './abr-parser';
import { MIN_BRUSH_SPACING } from './brush-spacing';

export class SutParser {
  private buffer: Uint8Array;
  private view: DataView;

  constructor(arrayBuffer: ArrayBuffer) {
    this.buffer = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
  }

  public parse(): ParsedBrushTip[] {
    const tips: ParsedBrushTip[] = [];
    const buf = this.buffer;
    const len = buf.length;

    // 1. Try to extract subtool title from text strings
    const toolTitle = this.extractToolName() || '匯入筆刷 (SubTool)';

    // 2. Scan for embedded PNG images
    // PNG Header: 89 50 4E 47 0D 0A 1A 0A
    // PNG IEND: 49 45 4E 44 AE 42 60 82
    let pos = 0;
    let tipIdx = 1;

    while (pos < len - 8) {
      if (
        buf[pos] === 0x89 &&
        buf[pos + 1] === 0x50 &&
        buf[pos + 2] === 0x4e &&
        buf[pos + 3] === 0x47 &&
        buf[pos + 4] === 0x0d &&
        buf[pos + 5] === 0x0a &&
        buf[pos + 6] === 0x1a &&
        buf[pos + 7] === 0x0a
      ) {
        const pngStart = pos;
        let pngEnd = -1;

        // Search for IEND marker
        for (let i = pngStart + 8; i < len - 8; i++) {
          if (
            buf[i] === 0x49 &&
            buf[i + 1] === 0x45 &&
            buf[i + 2] === 0x4e &&
            buf[i + 3] === 0x44
          ) {
            pngEnd = i + 8; // IEND + 4 bytes CRC
            break;
          }
        }

        if (pngEnd !== -1 && pngEnd > pngStart) {
          const pngBytes = buf.subarray(pngStart, pngEnd);

          // Read width and height from IHDR chunk (offset 16, 4 bytes each, big endian)
          let width = 128;
          let height = 128;
          if (pngBytes.length >= 24) {
            const ihdrView = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
            width = ihdrView.getUint32(16, false);
            height = ihdrView.getUint32(20, false);
          }

          if (width > 0 && height > 0 && width <= 4096 && height <= 4096) {
            const dataUrl = this.uint8ArrayToPngDataUrl(pngBytes);
            tips.push({
              id: `sut_tip_${tipIdx}`,
              name: `${toolTitle} - 筆尖貼圖 #${tipIdx} (${width}x${height})`,
              width,
              height,
              dataUrl,
              spacing: MIN_BRUSH_SPACING,
              hardness: 0.8,
            });
            tipIdx++;
          }

          pos = pngEnd;
          continue;
        }
      }

      // Check for JPEG (FF D8 FF ... FF D9)
      if (buf[pos] === 0xff && buf[pos + 1] === 0xd8 && buf[pos + 2] === 0xff) {
        const jpgStart = pos;
        let jpgEnd = -1;
        for (let j = jpgStart + 4; j < len - 2; j++) {
          if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
            jpgEnd = j + 2;
            break;
          }
        }

        if (jpgEnd !== -1 && jpgEnd - jpgStart > 100) {
          const jpgBytes = buf.subarray(jpgStart, jpgEnd);
          const dataUrl = this.uint8ArrayToJpgDataUrl(jpgBytes);
          tips.push({
            id: `sut_jpg_${tipIdx}`,
            name: `${toolTitle} - 貼圖 #${tipIdx}`,
            width: 256,
            height: 256,
            dataUrl,
            spacing: MIN_BRUSH_SPACING,
            hardness: 0.75,
          });
          tipIdx++;
          pos = jpgEnd;
          continue;
        }
      }

      pos++;
    }

    // 3. If no embedded images found, check if it's an SQLite 3 database or pure parametric brush
    if (tips.length === 0) {
      tips.push(this.createParametricCspTip(toolTitle));
    }

    return tips;
  }

  /**
   * Scans the SUT binary for tool name strings
   */
  private extractToolName(): string | null {
    const buf = this.buffer;
    // Look for recognizable strings (min length 3, alphanumeric or CJK)
    let bestName = '';
    let currentChars: number[] = [];

    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
      const b = buf[i];
      if ((b >= 32 && b <= 126) || b > 127) {
        currentChars.push(b);
      } else {
        if (currentChars.length >= 3 && currentChars.length <= 40) {
          try {
            const str = new TextDecoder('utf-8', { fatal: false }).decode(
              new Uint8Array(currentChars)
            ).trim();
            if (
              str.includes('Brush') ||
              str.includes('Pen') ||
              str.includes('Pencil') ||
              str.includes('Water') ||
              str.includes('水彩') ||
              str.includes('筆') ||
              str.includes('G') ||
              str.includes('丸')
            ) {
              bestName = str;
              break;
            }
          } catch {
            // ignore decoding error
          }
        }
        currentChars = [];
      }
    }

    return bestName || null;
  }

  private createParametricCspTip(name: string): ParsedBrushTip {
    // Generate a high-quality CSP style soft-air/water procedural tip
    const size = 128;
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (canvas) {
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.8)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        return {
          id: 'sut_parametric_default',
          name: `${name} (柔和擬真尖形)`,
          width: size,
          height: size,
          dataUrl: canvas.toDataURL('image/png'),
          spacing: MIN_BRUSH_SPACING,
          hardness: 0.7,
        };
      }
    }

    return {
      id: 'sut_parametric_default',
      name: `${name} (擬真尖形)`,
      width: size,
      height: size,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      spacing: MIN_BRUSH_SPACING,
      hardness: 0.8,
    };
  }

  private uint8ArrayToPngDataUrl(bytes: Uint8Array): string {
    let base64 = '';
    if (typeof (globalThis as any).Buffer !== 'undefined') {
      base64 = (globalThis as any).Buffer.from(bytes).toString('base64');
    } else {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      base64 = (globalThis as any).btoa(binary);
    }
    return `data:image/png;base64,${base64}`;
  }

  private uint8ArrayToJpgDataUrl(bytes: Uint8Array): string {
    let base64 = '';
    if (typeof (globalThis as any).Buffer !== 'undefined') {
      base64 = (globalThis as any).Buffer.from(bytes).toString('base64');
    } else {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      base64 = (globalThis as any).btoa(binary);
    }
    return `data:image/jpeg;base64,${base64}`;
  }
}
