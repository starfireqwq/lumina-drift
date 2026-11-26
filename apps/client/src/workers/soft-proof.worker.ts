import type { BuiltinProofProfileId } from '../engine/color/cmykPrintModel';
import { isProofableProfile, parseIccProfile } from '../engine/color/iccProfile';
import { buildSoftProofLut, type ProofOptions, type ProofSource } from '../engine/color/softProof';

export interface SoftProofWorkerRequest {
  id: number;
  source: { kind: 'builtin'; id: BuiltinProofProfileId } | { kind: 'icc'; bytes: ArrayBuffer };
  options: ProofOptions;
  size: number;
}

export type SoftProofWorkerResult =
  | { id: number; ok: true; size: number; data: ArrayBuffer; buildMs: number; label: string }
  | { id: number; ok: false; code: 'unsupported_profile' | 'build_failed' };

self.onmessage = async ({ data: { id, source: input, options, size } }: MessageEvent<SoftProofWorkerRequest>) => {
  const reply = (result: SoftProofWorkerResult) => self.postMessage(result, { transfer: result.ok ? [result.data] : [] });
  let source: ProofSource;
  if (input.kind === 'builtin') {
    source = input;
  } else {
    try {
      const profile = parseIccProfile(new Uint8Array(input.bytes));
      if (!isProofableProfile(profile)) {
        reply({ id, ok: false, code: 'unsupported_profile' });
        return;
      }
      source = { kind: 'icc', profile };
    } catch {
      reply({ id, ok: false, code: 'unsupported_profile' });
      return;
    }
  }

  try {
    const lut = await buildSoftProofLut(source, options, { size });
    reply({ id, ok: true, ...lut, data: lut.data.buffer as ArrayBuffer });
  } catch (error) {
    const code = error instanceof Error && error.message === 'unsupported_profile' ? 'unsupported_profile' : 'build_failed';
    reply({ id, ok: false, code });
  }
};
