import { renderLayerFilter, type LayerFilter } from '../utils/layerFilters';

self.onmessage = (event: MessageEvent<{
  request: number;
  pixels: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  filter: LayerFilter;
  mask?: Uint8Array | null;
}>) => {
  const { request, pixels, width, height, filter, mask } = event.data;
  try {
    const output = renderLayerFilter(pixels, width, height, filter, mask);
    self.postMessage({ request, output }, { transfer: [output.buffer] });
  } catch (error) {
    self.postMessage({ request, error: String(error) });
  }
};
