import { BufferImageSource, Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';
import { packSoftProofAtlas, SOFT_PROOF_FRAGMENT } from './softProofAtlas';

export { packSoftProofAtlas, sampleSoftProofAtlas, SOFT_PROOF_FRAGMENT } from './softProofAtlas';

export class SoftProofFilter extends Filter {
  private readonly atlas: BufferImageSource;
  private readonly uniformGroup: UniformGroup;

  constructor() {
    const atlas = new BufferImageSource({
      resource: new Uint8Array(4),
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
      addressMode: 'clamp-to-edge',
    });
    const uniformGroup = new UniformGroup({
      uLutSize: { value: 1, type: 'f32' },
      uProof: { value: 0, type: 'f32' },
      uGamut: { value: 0, type: 'f32' },
      uWarnColor: { value: new Float32Array(3), type: 'vec3<f32>' },
    });
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: SOFT_PROOF_FRAGMENT, name: 'lumina-soft-proof-filter' }),
      resolution: 'inherit',
      antialias: 'off',
      padding: 0,
      resources: { softProofUniforms: uniformGroup, uLut: atlas },
    });
    this.atlas = atlas;
    this.uniformGroup = uniformGroup;
  }

  setLut(lut: { size: number; data: Uint8Array }): void {
    this.atlas.resource = packSoftProofAtlas(lut);
    this.atlas.resize(lut.size ** 2, lut.size);
    this.atlas.update();
    this.uniformGroup.uniforms.uLutSize = lut.size;
    this.uniformGroup.update();
  }

  setState({ proof, gamutWarning, warningColor }: { proof: boolean; gamutWarning: boolean; warningColor: [number, number, number] }): void {
    const uniforms = this.uniformGroup.uniforms;
    uniforms.uProof = proof ? 1 : 0;
    uniforms.uGamut = gamutWarning ? 1 : 0;
    (uniforms.uWarnColor as Float32Array).set(warningColor);
    this.uniformGroup.update();
  }

  override destroy(): void {
    super.destroy();
    this.atlas.destroy();
  }
}
