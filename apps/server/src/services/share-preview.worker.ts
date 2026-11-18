import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { foldLayerTiles, type FoldSource } from './checkpoint-fold';
import { hasPreviewPixels, renderSharePreview, type SharePreviewSource } from './share-preview-render';

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
const snapshots = db.prepare('SELECT seq, storage_path AS storagePath FROM canvas_snapshots WHERE canvas_id = ? ORDER BY seq DESC, created_at DESC');
const ops = db.prepare('SELECT seq, layer_id AS layerId, payload_blob AS payloadBlob FROM canvas_ops WHERE canvas_id = ? AND seq > ? AND seq <= ? ORDER BY seq');
const fold = db.transaction((source: SharePreviewSource) => foldLayerTiles({
  snapshots: snapshots.all(source.canvas.id) as FoldSource['snapshots'],
  opsSince: (since) => ops.all(source.canvas.id, since, source.canvas.latestSeq) as ReturnType<FoldSource['opsSince']>,
  layers: source.layers,
}, source.canvas.latestSeq));
const port = parentPort!;

port.on('message', ({ id, source }: { id: number; source: SharePreviewSource }) => {
  try {
    const layers = fold(source);
    const png = layers && hasPreviewPixels(layers)
      ? renderSharePreview(source, layers, readFileSync(source.brandPath))
      : null;
    port.postMessage({ id, png });
  } catch (error) {
    port.postMessage({ id, png: null, error: String(error) });
  }
});
