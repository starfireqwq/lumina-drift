const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron: electron } = require('playwright-core');

async function main() {
  const exe = path.resolve(process.argv[2] ?? '');
  assert.ok(process.argv[2] && fs.statSync(exe).isFile(), 'Pass the full path to the test package executable.');
  const smoke = process.argv.includes('--smoke');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-tablet-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DATA_DIR']) {
    env[key] = path.join(root, key);
    fs.mkdirSync(env[key]);
  }
  const logArgument = process.argv.find(arg => arg.startsWith('--log-dir='));
  const logDirectory = logArgument && !smoke
    ? path.join(path.resolve(logArgument.slice('--log-dir='.length)), path.basename(root)) : root;
  fs.mkdirSync(logDirectory, { recursive: true });
  const log = path.join(logDirectory, 'tablet-input.jsonl');
  const record = value => {
    const line = JSON.stringify(value);
    fs.appendFileSync(log, line + '\n');
    console.log(line);
  };
  record({ diagnostic: 'r7', log });
  const app = await electron.launch({
    executablePath: exe, cwd: path.dirname(exe), env,
    args: ['--user-data-dir=' + path.join(root, 'profile'), '--host-resolver-rules=MAP localhost ~NOTFOUND'],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      localStorage.setItem('atelier_language', 'zh-TW');
      localStorage.setItem('atelier_tablet_input', 'auto');
    });
    await page.reload();
    await page.locator('button[type="submit"]:has-text("開始單機作畫")').click({ timeout: 15000 });
    await page.locator('.atelier-canvas-viewport').waitFor();
    await page.exposeFunction('__tabletDiagnosticLog', record);
    await page.evaluate(() => {
      const packets = { wintab: [], ink: [], mouse: [] };
      const strokes = new Map();
      const pending = new Set();
      const matchMs = 42;
      const timeOrigin = performance.timeOrigin;
      let status;
      let generation;
      let mouseCapture;
      let frameId = 0;
      function trackFrames(time) {
        let drawing = false;
        for (const stroke of strokes.values()) {
          if (stroke.ended) continue;
          if (stroke.frameAt !== undefined) stroke.frameIntervals.push(time - stroke.frameAt);
          stroke.frameAt = time;
          drawing = true;
        }
        frameId = drawing ? requestAnimationFrame(trackFrames) : 0;
      }
      function timing(values) {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        const round = ms => Math.round(ms * 10) / 10;
        return {
          count: sorted.length, median: round(sorted[Math.floor(sorted.length / 2)]),
          p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), max: round(sorted.at(-1)),
          over32ms: sorted.filter(ms => ms > 32).length, over50ms: sorted.filter(ms => ms > 50).length,
        };
      }
      function readUndo() {
        const history = window.__debugPixi?.undo;
        if (!history) return null;
        const top = history.inspect().undo.at(-1);
        return { count: history.getUndoCount(), top: top?.opType ?? null, stroke: top?.opId ?? null };
      }
      window.atelierDesktop.tablet.subscribe(update => {
        if (status !== update.status || generation !== update.generation || mouseCapture !== update.mouseCapture) {
          status = update.status;
          generation = update.generation;
          mouseCapture = update.mouseCapture;
          window.__tabletDiagnosticLog({ driver: status, generation, mouseCapture, devicesChanged: update.devicesChanged,
            dispatch: update.dispatch });
        }
        const receivedAt = performance.now();
        for (const [source, incoming] of [
          ['wintab', update.samples], ['ink', update.inkSamples ?? []], ['mouse', update.mouseSamples ?? []],
        ]) {
          if (!incoming.length) continue;
          // Retain batches without copying the growing history on every native update.
          if (!strokes.size && !pending.size) packets[source] = packets[source].filter(batch => batch.receivedAt >= receivedAt - 200);
          packets[source].push({ receivedAt, incoming, publishedAt: update.publishedAt, dispatch: update.dispatch });
        }
      });
      const point = event => ({ x: event.clientX, y: event.clientY, time: event.timeStamp, pressure: event.pressure });
      window.addEventListener('pointerdown', event => {
        const target = event.target;
        const location = target instanceof HTMLCanvasElement && target.closest('[role="dialog"]') ? '試筆區'
          : target.closest?.('.atelier-canvas-viewport') ? '畫布' : null;
        if (!location) return;
        strokes.set(event.pointerId, {
          kind: event.pointerType, location, begin: event.timeStamp, points: [point(event)],
          preference: localStorage.getItem('atelier_tablet_input') ?? 'auto',
          driver: status, mouseCapture,
          undoBefore: location === '畫布' ? readUndo() : null,
          frameIntervals: [], domIntervals: [], domDelivery: [], domAt: performance.now(),
          rawIntervals: [], rawDelivery: [], rawPoints: [point(event)], rawAt: performance.now(),
        });
        if (!frameId) frameId = requestAnimationFrame(trackFrames);
      }, true);
      window.addEventListener('pointermove', event => {
        const stroke = strokes.get(event.pointerId);
        if (!stroke) return;
        if (stroke.ended) {
          if (!stroke.nextHover && !event.buttons) stroke.nextHover = point(event);
          return;
        }
        const now = performance.now();
        stroke.domIntervals.push(now - stroke.domAt);
        stroke.domDelivery.push(Math.max(0, now - event.timeStamp));
        stroke.domAt = now;
        const batch = event.getCoalescedEvents();
        for (const sample of batch.length ? batch : [event]) stroke.points.push(point(sample));
      }, true);
      window.addEventListener('pointerrawupdate', event => {
        const stroke = strokes.get(event.pointerId);
        if (!stroke || stroke.ended || !event.buttons) return;
        const now = performance.now();
        stroke.rawIntervals.push(now - stroke.rawAt);
        stroke.rawDelivery.push(Math.max(0, now - event.timeStamp));
        stroke.rawAt = now;
        const batch = event.getCoalescedEvents();
        for (const sample of batch.length ? batch : [event]) stroke.rawPoints.push(point(sample));
      }, { capture: true, passive: true });
      function sampleTiming(points) {
        const intervals = [];
        let maxDistanceAfter64ms = 0;
        const gaps = [];
        for (let i = 1; i < points.length; i++) {
          const previous = points[i - 1];
          const current = points[i];
          const interval = current.time - previous.time;
          if (interval < 0) continue;
          intervals.push(interval);
          if (interval >= 64) {
            const distance = Math.round(Math.hypot(current.x - previous.x, current.y - previous.y));
            maxDistanceAfter64ms = Math.max(maxDistanceAfter64ms, distance);
            gaps.push({ startMs: Math.round(previous.time - points[0].time), durationMs: Math.round(interval), distance });
          }
        }
        gaps.sort((a, b) => b.durationMs - a.durationMs);
        return { intervalMs: timing(intervals), maxDistanceAfter64ms, largestGaps: gaps.slice(0, 5) };
      }
      function summarize(stroke, batches, endTime) {
        const nearStart = timeOrigin + stroke.begin - matchMs;
        const nearEnd = timeOrigin + endTime + matchMs;
        const dom = stroke.points.slice().sort((a, b) => a.time - b.time);
        let first = 0;
        let lastTime = -Infinity;
        let collected = 0, hover = 0, releases = 0, gaps = 0, aligned = 0;
        let min = 1, max = 0;
        const delivery = [];
        const beforePublish = [];
        const beforeCapture = [];
        const newestBeforeCapture = [];
        const beforeMessage = [];
        const messageToCapture = [];
        const captureToForward = [];
        const forwardToDrain = [];
        const afterCapture = [];
        const beforeDrain = [];
        const afterDrain = [];
        const afterPublish = [];
        const batchIntervals = [];
        const dispatches = {};
        const intervals = [];
        const contactTimes = new Map();
        const nativePoints = [];
        let previousBatchAt;
        for (const { receivedAt, incoming, publishedAt, dispatch } of batches) {
          let used = false;
          for (const sample of incoming) {
            if (sample.time < nearStart || sample.time > nearEnd) continue;
            used = true;
            if (sample.gapBefore) gaps++;
            if (!sample.contact) {
              if (contactTimes.has(sample.cursor)) releases++;
              else hover++;
              contactTimes.delete(sample.cursor);
              continue;
            }
            const previous = contactTimes.get(sample.cursor);
            if (previous !== undefined && sample.time >= previous) intervals.push(sample.time - previous);
            contactTimes.set(sample.cursor, sample.time);
            collected++;
            min = Math.min(min, sample.pressure);
            max = Math.max(max, sample.pressure);
            const at = sample.time - timeOrigin;
            nativePoints.push({ x: sample.x, y: sample.y, time: at });
            delivery.push(Math.max(0, receivedAt - at));
            if (Number.isFinite(publishedAt)) {
              beforePublish.push(Math.max(0, publishedAt - sample.time));
              afterPublish.push(Math.max(0, receivedAt - (publishedAt - timeOrigin)));
              if (Number.isFinite(sample.capturedAt)) {
                beforeCapture.push(Math.max(0, sample.capturedAt - sample.time));
                if (sample.newestInMessage) newestBeforeCapture.push(Math.max(0, sample.capturedAt - sample.time));
                if (sample.messageAt !== undefined) {
                  beforeMessage.push(Math.max(0, sample.messageAt - sample.time));
                  if (sample.newestInMessage) messageToCapture.push(Math.max(0, sample.capturedAt - sample.messageAt));
                }
                afterCapture.push(Math.max(0, publishedAt - sample.capturedAt));
                if (Number.isFinite(sample.drainedAt)) {
                  beforeDrain.push(Math.max(0, sample.drainedAt - sample.capturedAt));
                  afterDrain.push(Math.max(0, publishedAt - sample.drainedAt));
                  if (Number.isFinite(sample.forwardedAt)) {
                    captureToForward.push(Math.max(0, sample.forwardedAt - sample.capturedAt));
                    forwardToDrain.push(Math.max(0, sample.drainedAt - sample.forwardedAt));
                  }
                }
              }
            }
            if (at < lastTime) first = 0;
            lastTime = at;
            while (first < dom.length && dom[first].time < at - matchMs) first++;
            for (let idx = first; idx < dom.length && dom[idx].time <= at + matchMs; idx++) {
              const p = dom[idx];
              if ((sample.x - p.x) ** 2 + (sample.y - p.y) ** 2 > 18 ** 2) continue;
              aligned++;
              break;
            }
          }
          if (used) {
            if (dispatch) dispatches[dispatch] = (dispatches[dispatch] ?? 0) + 1;
            if (previousBatchAt !== undefined) batchIntervals.push(receivedAt - previousBatchAt);
            previousBatchAt = receivedAt;
          }
        }
        return {
          packets: collected, hover, releases, gaps, pressure: collected ? [min, max] : null, aligned,
          sampleIntervalMs: timing(intervals), deliveryMs: timing(delivery),
          samples: sampleTiming(nativePoints),
          beforePublishMs: timing(beforePublish), afterPublishMs: timing(afterPublish),
          beforeCaptureMs: timing(beforeCapture), captureToPublishMs: timing(afterCapture),
          newestBeforeCaptureMs: timing(newestBeforeCapture), beforeMessageMs: timing(beforeMessage),
          messageToCaptureMs: timing(messageToCapture), captureToForwardMs: timing(captureToForward),
          forwardToDrainMs: timing(forwardToDrain),
          captureToDrainMs: timing(beforeDrain), drainToPublishMs: timing(afterDrain),
          batchIntervalMs: timing(batchIntervals), dispatches,
        };
      }
      function end(event) {
        const stroke = strokes.get(event.pointerId);
        if (!stroke || stroke.ended) return;
        stroke.ended = true;
        const mode = document.querySelector('[data-tablet-mode]');
        const selected = mode?.getAttribute('data-tablet-mode');
        const nativeSource = document.documentElement.dataset.drawingInput ?? 'pointer';
        const undoAtRelease = stroke.location === '畫布' ? readUndo() : null;
        pending.add(stroke);
        setTimeout(() => {
          pending.delete(stroke);
          if (strokes.get(event.pointerId) === stroke) strokes.delete(event.pointerId);
          window.__tabletDiagnosticLog({
            location: stroke.location, pointerType: stroke.kind, event: event.type,
            preference: stroke.preference, mode: selected, nativeSource, driver: stroke.driver,
            mouseCapture: stroke.mouseCapture, domPoints: stroke.points.length,
            startMs: Math.round(stroke.begin), releaseMs: Math.round(event.timeStamp),
            durationMs: Math.round(event.timeStamp - stroke.begin),
            hoverAfterRelease: stroke.nextHover ? {
              delayMs: Math.round(stroke.nextHover.time - event.timeStamp),
              distance: Math.round(Math.hypot(stroke.nextHover.x - event.clientX, stroke.nextHover.y - event.clientY)),
            } : null,
            undoBefore: stroke.undoBefore, undoAtRelease,
            undoAtReport: stroke.location === '畫布' ? readUndo() : null,
            frameIntervalMs: timing(stroke.frameIntervals), domIntervalMs: timing(stroke.domIntervals),
            domDeliveryMs: timing(stroke.domDelivery),
            domSamples: sampleTiming(stroke.points), rawSamples: sampleTiming(stroke.rawPoints),
            rawPoints: stroke.rawPoints.length - 1, rawIntervalMs: timing(stroke.rawIntervals), rawDeliveryMs: timing(stroke.rawDelivery),
            wintab: summarize(stroke, packets.wintab, event.timeStamp),
            ink: summarize(stroke, packets.ink, event.timeStamp),
            mouse: summarize(stroke, packets.mouse, event.timeStamp),
          });
          let oldest = performance.now();
          for (const waiting of [...strokes.values(), ...pending]) oldest = Math.min(oldest, waiting.begin);
          for (const source of Object.keys(packets)) {
            packets[source] = packets[source].filter(batch => batch.receivedAt >= oldest - 200);
          }
        }, 350);
      }
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(type, end, true);
      window.addEventListener('keydown', event => {
        if (event.ctrlKey && !event.shiftKey && event.code === 'KeyZ' && !event.repeat) {
          const before = readUndo();
          const atMs = Math.round(event.timeStamp);
          setTimeout(() => window.__tabletDiagnosticLog({ shortcut: 'Ctrl+Z', atMs, before, after: readUndo() }), 120);
        }
      }, true);
    });
    await page.getByRole('button', { name: '偏好設定', exact: true }).click();
    await page.getByRole('tab', { name: '筆壓測試', exact: true }).click();
    const select = page.locator('section:has([data-tablet-mode]) select');
    await select.selectOption('ink');
    await select.selectOption('auto');
    await page.locator('[data-tablet-native-source]').waitFor();
    await page.waitForFunction(() => typeof window.atelierDesktop?.tablet?.subscribe === 'function');
    record({ ready: true, log });
    if (smoke) {
      const entries = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const captureReady = () => entries().some(entry => entry.driver === 'ready' &&
        entry.mouseCapture === 'ready' && entry.dispatch === 'capture');
      for (let attempt = 0; attempt < 50 && !captureReady(); attempt++) await delay(100);
      assert.ok(captureReady(), 'WinTab readiness and Raw Input registration reached the page over the capture port.');
      await page.evaluate(() => {
        const stop = window.atelierDesktop.tablet.subscribe(update => {
          if (update.status !== 'disabled' || update.dispatch !== 'status') return;
          window.__tabletSmokeReceivedAt = performance.timeOrigin + performance.now();
          stop();
        });
      });
      await app.evaluate(({ ipcMain }) => {
        ipcMain.once('atelier:wintab-configure', () => {
          const now = () => performance.timeOrigin + performance.now();
          const start = now();
          while (now() < start + 220) { /* Simulate a blocked window thread. */ }
          globalThis.__tabletSmokeBlocked = { start, end: now() };
        });
      });
      await select.selectOption('ink');
      await page.waitForFunction(() => Number.isFinite(window.__tabletSmokeReceivedAt));
      const receivedAt = await page.evaluate(() => window.__tabletSmokeReceivedAt);
      const blocked = await app.evaluate(() => globalThis.__tabletSmokeBlocked);
      assert.ok(blocked && receivedAt >= blocked.start - 5 && receivedAt < blocked.end - 20,
        'The page received the capture update while the window thread was blocked.');
      record({ captureWhileWindowBlocked: true, blockedMs: Math.round(blocked.end - blocked.start),
        receivedAfterMs: Math.round(receivedAt - blocked.start) });
      const preview = await page.getByRole('dialog').locator('canvas').boundingBox();
      assert.ok(preview, 'The packaged app displays the test canvas.');
      const x = preview.x + 30;
      const y = preview.y + 40;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 40, y, { steps: 5 });
      await delay(120);
      await page.mouse.move(x + 120, y);
      await page.mouse.move(x + 160, y, { steps: 5 });
      await page.mouse.up();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '關閉', exact: true }).last().click();
      await dialog.waitFor({ state: 'hidden' });
      const undoCount = () => window.__debugPixi?.undo.getUndoCount();
      await page.waitForFunction(() => Boolean(window.__debugPixi?.undo));
      const coordinates = await page.evaluate(() => {
        const { app, viewport } = window.__debugPixi;
        const rect = app.canvas.getBoundingClientRect();
        const mid = viewport.screenToCanvas(rect.width / 2, rect.height / 2);
        return [mid, { x: mid.x + 50, y: mid.y + 25 }].map(({ x, y }) => {
          const point = viewport.canvasToScreen(x, y);
          return { x: rect.left + point.x, y: rect.top + point.y };
        });
      });
      const [start, end] = coordinates;
      await page.waitForFunction(([start, end]) => [start, end].every(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.atelier-canvas-viewport')), coordinates);
      const initial = await page.evaluate(undoCount);
      async function draw(offset) {
        await page.mouse.move(start.x, start.y + offset);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y + offset, { steps: 8 });
        await page.mouse.up();
        await page.mouse.move(start.x, start.y - 25);
      }
      await draw(0);
      const baseline = initial + 1;
      await page.waitForFunction(count => window.__debugPixi?.undo.getUndoCount() === count, baseline);
      const previousStroke = await page.evaluate(() => window.__debugPixi.undo.inspect().undo.at(-1).opId);
      await draw(15);
      await page.waitForFunction(count => window.__debugPixi?.undo.getUndoCount() === count, baseline + 1);
      await page.keyboard.press('Control+z');
      await page.waitForFunction(count => window.__debugPixi?.undo.getUndoCount() === count, baseline);
      for (let attempt = 0; attempt < 30; attempt++) {
        const recorded = entries();
        if (recorded.some(entry => entry.location === '試筆區' && entry.rawPoints > 0) &&
            recorded.some(entry => entry.location === '畫布' && entry.rawPoints > 0) &&
            recorded.some(entry => entry.shortcut === 'Ctrl+Z' && entry.before?.top === 'STROKE' &&
              entry.before.count === baseline + 1 && entry.after?.count === baseline &&
              entry.after.stroke === previousStroke)) {
          console.log('Smoke passed: direct capture port, driver registration, Chromium raw events on both surfaces, and one-step undo.');
          return;
        }
        await delay(100);
      }
      assert.fail('The packaged diagnostic did not log all required input and undo checks.');
    } else {
      await new Promise(resolve => app.once('close', resolve));
    }
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
