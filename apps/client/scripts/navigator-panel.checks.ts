import assert from 'node:assert/strict';
import { CanvasViewport, type ViewportState } from '../src/engine/Viewport';
import {
  canvasPointToPreview, canvasPointToScreen, computeNavigatorFit, computePanForCanvasCenter,
  computeViewportPolygonInCanvas, computeWheelRotationRadians, normalizeRotationDegrees, previewPointToCanvas, screenPointToCanvas,
  sliderToZoomPercent, zoomPercentToSlider,
} from '../src/utils/navigatorMath';

const near = (actual: number, expected: number) => assert.ok(
  Math.abs(actual - expected) < 1e-8, `Expected ${actual} to be close to ${expected}`,
);
const nearPoint = (actual: { x: number; y: number }, x: number, y: number) => {
  near(actual.x, x);
  near(actual.y, y);
};

const wheelStep = Math.PI / 12;
near(computeWheelRotationRadians(100, 0), wheelStep);
near(computeWheelRotationRadians(-100, 0), -wheelStep);
near(computeWheelRotationRadians(-40, 40), wheelStep);
near(computeWheelRotationRadians(0, -120), -wheelStep);
near(computeWheelRotationRadians(0, 3, 1), wheelStep);
near(computeWheelRotationRadians(-1, 0, 2), -wheelStep);
near(computeWheelRotationRadians(-12, 4), -0.12 * wheelStep);
near(computeWheelRotationRadians(0, 39), 0.39 * wheelStep);
assert.equal(computeWheelRotationRadians(0, 0), 0);

const width = 901;
const height = 601;
const viewWidth = 721;
const viewHeight = 483;
const viewport = new CanvasViewport(width, height);
const legacyState: ViewportState = { zoom: 0.5, panX: 242, panY: 180, rotation: 0, mirrorX: false };
viewport.setState(legacyState);
assert.equal(viewport.getState().mirrorY, false);
viewport.toggleMirrorY();
assert.equal(viewport.getState().mirrorY, true);
near(viewport.canvasContainer.scale.y, -0.5);
nearPoint(viewport.canvasToScreen(width / 2, 0), 242, 180 + height / 4);
viewport.setState({ mirrorY: false });
nearPoint(viewport.canvasToScreen(width / 2, 0), 242, 180 - height / 4);
viewport.centerInView(viewWidth, viewHeight);
assert.equal(viewport.isFitTo(viewWidth, viewHeight), true);
viewport.setMirrorY(true);
assert.equal(viewport.isFitTo(viewWidth, viewHeight), false);
viewport.centerInView(viewWidth, viewHeight);
assert.equal(viewport.getState().mirrorY, false);

viewport.setDisplayScale(2);
viewport.setState({ zoom: 0.5, panX: 240.125, panY: 181.2, mirrorX: true, mirrorY: true });
const snappedOrigin = viewport.canvasToScreen(0, 0);
near(snappedOrigin.x * 2, Math.round(snappedOrigin.x * 2));
near(snappedOrigin.y * 2, Math.round(snappedOrigin.y * 2));
viewport.panToCanvasPoint(250.125, 55.75, viewWidth, viewHeight);
nearPoint(viewport.canvasToScreen(250.125, 55.75), viewWidth / 2, viewHeight / 2);

const transformed: ViewportState = { ...legacyState, zoom: 1.47, rotation: 0.83, mirrorX: true, mirrorY: true };
viewport.setState(transformed);
viewport.panToCanvasPoint(154.25, 490.75, viewWidth, viewHeight);
const state = viewport.getState();
const expectedPan = computePanForCanvasCenter(154.25, 490.75, transformed, viewWidth, viewHeight, width, height);
assert.deepEqual(state, { ...transformed, ...expectedPan });
nearPoint(viewport.canvasToScreen(154.25, 490.75), viewWidth / 2, viewHeight / 2);
const arbitrary = viewport.canvasToScreen(412.5, 21.8);
nearPoint(canvasPointToScreen(412.5, 21.8, state, width, height), arbitrary.x, arbitrary.y);
nearPoint(screenPointToCanvas(arbitrary.x, arbitrary.y, state, width, height), 412.5, 21.8);

viewport.setZoomPercentAt(viewWidth / 2, viewHeight / 2, 5);
near(viewport.getState().zoom, 0.025);
nearPoint(viewport.canvasToScreen(154.25, 490.75), viewWidth / 2, viewHeight / 2);
viewport.setZoomPercentAt(viewWidth / 2, viewHeight / 2, 3200);
near(viewport.getState().zoom, 16);
nearPoint(viewport.canvasToScreen(154.25, 490.75), viewWidth / 2, viewHeight / 2);

const polygon = computeViewportPolygonInCanvas(state, viewWidth, viewHeight, width, height);
assert.equal(polygon.coversFullCanvas, false);
assert.equal(polygon.points.length, 4);
const screenCorners = [[0, 0], [viewWidth, 0], [viewWidth, viewHeight], [0, viewHeight]];
polygon.points.forEach(({ x, y }, index) => {
  const [sx, sy] = screenCorners[index];
  nearPoint(canvasPointToScreen(x, y, state, width, height), sx, sy);
});
const centered = { ...state, panX: viewWidth / 2, panY: viewHeight / 2 };
assert.equal(computeViewportPolygonInCanvas({ ...centered, zoom: 0.15 }, viewWidth, viewHeight, width, height).coversFullCanvas, true);
const rotatedSquare = { ...state, panX: 200, panY: 200, zoom: 0.5, rotation: Math.PI / 4 };
assert.equal(computeViewportPolygonInCanvas(rotatedSquare, 400, 400, width, height).coversFullCanvas, false);
assert.equal(computeViewportPolygonInCanvas({ ...legacyState, zoom: 1, panX: width / 2, panY: height / 2 }, width, height, width, height).coversFullCanvas, true);

assert.deepEqual(computeNavigatorFit(13500, 7500, 290, 170), { x: 10, y: 10, width: 270, height: 150, scale: 0.02 });
assert.deepEqual(computeNavigatorFit(100, 200, 200, 100), { x: 80, y: 10, width: 40, height: 80, scale: 0.4 });
assert.equal(computeNavigatorFit(width, height, 10, 14).scale, 0);
const fit = computeNavigatorFit(width, height, 245, 180);
for (const mirrorX of [false, true]) {
  for (const mirrorY of [false, true]) {
    const preview = canvasPointToPreview(53.25, 101.5, fit, mirrorX, mirrorY, width, height);
    nearPoint(preview, fit.x + (mirrorX ? width - 53.25 : 53.25) * fit.scale, fit.y + (mirrorY ? height - 101.5 : 101.5) * fit.scale);
    nearPoint(previewPointToCanvas(preview.x, preview.y, fit, mirrorX, mirrorY, width, height), 53.25, 101.5);
  }
}

assert.equal(zoomPercentToSlider(0), 0);
assert.equal(zoomPercentToSlider(3400), 1000);
assert.equal(sliderToZoomPercent(-20), 5);
assert.equal(sliderToZoomPercent(1020), 3200);
near(sliderToZoomPercent(500), Math.sqrt(5 * 3200));
for (const percent of [5, 8, 36, 100, 200, 800, 3200]) {
  near(sliderToZoomPercent(zoomPercentToSlider(percent)), percent);
}
for (const position of [0, 90, 254.5, 500, 1000]) {
  near(zoomPercentToSlider(sliderToZoomPercent(position)), position);
}
assert.equal(normalizeRotationDegrees(0), 0);
assert.equal(normalizeRotationDegrees(Math.PI), 180);
assert.equal(normalizeRotationDegrees(-Math.PI), -180);
assert.equal(normalizeRotationDegrees(5 * Math.PI / 2), 90);
assert.equal(normalizeRotationDegrees(-200 * Math.PI / 180), 160);
assert.equal(normalizeRotationDegrees(12.345 * Math.PI / 180), 12.3);
assert.equal(normalizeRotationDegrees(-0.00001), 0);

viewport.destroy();
console.log('Navigator viewport and preview geometry checks passed.');
