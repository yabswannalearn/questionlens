const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/app.js', 'utf8');
const questionA = 'Which approach should a team use for the application?\nA. Use a database for persistent information.\nB. Use a queue for asynchronous processing.\nC. Use a cache for repeated reads.';
const questionB = 'What should an architect do to limit the risk of accidental exposure?\nA. Configure authorization and access policies.\nB. Disable security logs for the environment.\nC. Publish every credential in the application.';

function setup(fetchImpl, useVisionGate = false, ocrImpl = null) {
  const elements = {};
  const element = () => ({
    textContent: '', hidden: false, children: [],
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, fn) { this[name] = fn; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  for (const id of ['camera', 'start', 'scanNow', 'pollToggle', 'retry', 'status', 'step', 'answers', 'frameText', 'focus', 'rotateLandscape', 'ocrText', 'zoomToggle', 'zoomPanel', 'zoomRange', 'zoomValue']) elements[id] = element();
  Object.assign(elements.camera, { readyState: 2, videoWidth: 1200, videoHeight: 800, clientWidth: 600, clientHeight: 400, style: {}, play: async () => {} });
  elements.zoomRange.value = '1';
  elements.zoomPanel.hidden = true;
  const queue = [];
  const events = [];
  const intervals = [];
  const drawCalls = [];
  const activeIntervals = new Map();
  let nextIntervalId = 0;
  const orientationActions = [];
  const windowEvents = {};
  let ocrCalls = 0;
  const classes = new Set();
  const sandbox = {
    document: {
      body: { classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); },
        contains(name) { return classes.has(name); },
      } },
      querySelector(selector) { return elements[selector.slice(1)]; },
      createElement(tag) { return tag === 'canvas' ? {
        getContext: () => ({ drawImage: (...args) => drawCalls.push(args.slice(1)), getImageData: () => ({ data: new Uint8Array(128 * 72 * 4) }) }),
        toDataURL: () => 'data:image/jpeg;base64,dGVzdA==',
      } : element(); },
    },
    console, AbortController, crypto: require('node:crypto').webcrypto,
    innerWidth: 390, innerHeight: 844,
    addEventListener: (name, callback) => { windowEvents[name] = callback; },
    screen: { orientation: { lock: async value => { orientationActions.push(value); }, unlock: () => { orientationActions.push('unlock'); } } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
    setInterval: (callback, milliseconds) => {
      intervals.push(milliseconds);
      const id = ++nextIntervalId;
      activeIntervals.set(id, callback);
      return id;
    },
    clearInterval: id => activeIntervals.delete(id),
    fetch: (url, options) => {
      if (url === '/api/events') {
        events.push(JSON.parse(options.body));
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/ocr') {
        ocrCalls++;
        return ocrImpl ? ocrImpl(queue) : Promise.resolve({ ok: true, json: async () => ({ text: queue.shift() }) });
      }
      return fetchImpl(url, options);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  vm.runInContext('scanning = true', sandbox);
  if (!useVisionGate) vm.runInContext('shouldUseVision = () => true', sandbox);
  return { elements, queue, events, intervals, activeIntervals, drawCalls, orientationActions, windowEvents, classes, getOcrCalls: () => ocrCalls, run: code => vm.runInContext(code, sandbox) };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('answers after one OCR reading and reuses earlier answers during the session', async () => {
  const requests = [];
  const app = setup(async (url, options) => {
    requests.push(JSON.parse(options.body).text);
    return { ok: true, json: async () => ({ choices: [{ position: 'B', text: 'The answer' }] }) };
  });
  async function scan(text) { app.queue.push(text); await app.run('scan()'); await settle(); }
  await scan(questionA);
  assert.equal(requests.length, 1);
  await scan(questionA);
  assert.equal(requests.length, 1);
  assert.equal(app.elements.step.textContent, 'ANSWER READY');
  await scan(questionA);
  assert.equal(requests.length, 1);
  await scan(questionB);
  assert.equal(requests.length, 2);
  await scan(questionB);
  await scan(questionA);
  await scan(questionA);
  assert.deepEqual(requests, [questionA, questionB]);
  assert.ok(app.events.some(event => event.name === 'answer_cached'));
});

test('recovers the previous answer after an unreadable scan', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'An answer' }] }) }));
  async function scan(text) { app.queue.push(text); await app.run('scan()'); await settle(); }
  await scan(questionA);
  await scan(questionA);
  await scan('unreadable');
  assert.equal(app.elements.step.textContent, 'SCANNING');
  await scan(questionA);
  assert.equal(app.elements.step.textContent, 'ANSWER READY');
});

test('retries five times and then offers a manual retry', async () => {
  let attempts = 0;
  const scanIds = [];
  const app = setup(async (_, options) => { attempts++; scanIds.push(JSON.parse(options.body).scan_id); throw new Error('offline'); });
  app.queue.push(questionA);
  await app.run('scan()');
  await settle();
  assert.equal(app.elements.ocrText.textContent, questionA);
  assert.equal(attempts, 6);
  assert.equal(new Set(scanIds).size, 1);
  assert.ok(scanIds[0]);
  assert.equal(app.elements.step.textContent, 'NEEDS ATTENTION');
  assert.equal(app.elements.retry.hidden, false);
});

test('does not treat changed negations or numbers as OCR noise', () => {
  const app = setup(() => {});
  assert.equal(app.run(`sameText(${JSON.stringify(questionA)}, ${JSON.stringify(questionA.replace('should', 'should not'))})`), false);
  assert.equal(app.run(`sameText(${JSON.stringify(questionA + ' 1')}, ${JSON.stringify(questionA + ' 2')})`), false);
});

test('ignores an old Gemini response after a different question is read', async () => {
  let finishFirst;
  let count = 0;
  const app = setup(async () => {
    count++;
    if (count === 1) return new Promise(resolve => { finishFirst = resolve; });
    return { ok: true, json: async () => ({ choices: [{ position: 'B', text: 'New answer' }] }) };
  });
  async function scan(text) { app.queue.push(text); await app.run('scan()'); await settle(); }
  await scan(questionA);
  await scan(questionA);
  await scan(questionB);
  await scan(questionB);
  finishFirst({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Old answer' }] }) });
  await settle();
  assert.equal(app.elements.answers.children[0].children[1].textContent, 'New answer');
});

test('fullscreen requests landscape and unlocks it on exit', async () => {
  const app = setup(() => {});
  app.elements.focus.click();
  await settle();
  assert.equal(app.classes.has('focus-mode'), true);
  assert.equal(app.elements.focus['aria-pressed'], 'true');
  assert.equal(app.elements.rotateLandscape.hidden, false);
  assert.deepEqual(app.orientationActions, ['landscape']);
  app.elements.focus.click();
  assert.equal(app.classes.has('focus-mode'), false);
  assert.equal(app.elements.rotateLandscape.hidden, true);
  assert.deepEqual(app.orientationActions, ['landscape', 'unlock']);
});

test('fullscreen stays usable when the browser rejects orientation locking', async () => {
  const app = setup(() => {});
  app.run("screen.orientation.lock = async () => { throw new Error('unsupported'); }");
  app.elements.focus.click();
  await settle();
  assert.equal(app.classes.has('focus-mode'), true);
});

test('landscape button falls back to a rotated view and can undo it', async () => {
  const app = setup(() => {});
  app.run('setFocusMode(true)');
  app.run("screen.orientation.lock = async () => { throw new Error('unsupported'); }");
  await app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('landscape-fallback'), true);
  assert.match(app.elements.rotateLandscape.textContent, /Undo/);
  await app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('landscape-fallback'), false);
});

test('rotated fallback clears when the device itself enters landscape', async () => {
  const app = setup(() => {});
  app.run('setFocusMode(true)');
  app.run("screen.orientation.lock = async () => { throw new Error('unsupported'); }");
  await app.elements.rotateLandscape.click();
  app.run('innerWidth = 844; innerHeight = 390');
  app.windowEvents.resize();
  assert.equal(app.classes.has('landscape-fallback'), false);
});

test('landscape button uses the browser orientation lock when supported', async () => {
  const app = setup(() => {});
  app.run('setFocusMode(true)');
  await app.elements.rotateLandscape.click();
  assert.deepEqual(app.orientationActions, ['landscape']);
  assert.equal(app.classes.has('landscape-fallback'), false);
});

test('reports OCR and AI progress without sending question text in events', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }));
  app.queue.push(questionA);
  await app.run('scan()');
  await settle();
  assert.ok(app.events.some(event => event.name === 'ocr_started'));
  assert.ok(app.events.some(event => event.name === 'ocr_result' && event.outcome === 'confirmed' && event.characters === questionA.length));
  assert.ok(app.events.some(event => event.name === 'ai_attempt' && event.attempt === 1));
  assert.equal(JSON.stringify(app.events).includes(questionA), false);
});

test('incomplete OCR readings are not sent to Gemini', async () => {
  let calls = 0;
  const app = setup(async () => { calls++; return { ok: true, json: async () => ({ choices: [] }) }; });
  for (const length of [10, 20, 30, 38]) {
    app.queue.push(questionA.slice(0, length));
    await app.run('scan()');
  }
  assert.equal(calls, 0);
  assert.ok(app.events.some(event => event.name === 'ocr_result' && event.outcome === 'incomplete'));
});

test('only sends a new OCR request when the view changes or a reading was incomplete', () => {
  const app = setup(() => {}, true);
  app.run('lastImage = new Uint8Array(100); lastOcrAt = 1000; lastIncomplete = false');
  assert.equal(app.run('shouldUseVision(new Uint8Array(100), 3000)'), false);
  assert.equal(app.run('shouldUseVision(new Uint8Array(100), 31000)'), false);
  assert.equal(app.run('shouldUseVision(Uint8Array.from({length:100}, (_, i) => i < 50 ? 255 : 0), 7000)'), true);
  app.run('lastIncomplete = true');
  assert.equal(app.run('shouldUseVision(new Uint8Array(100), 11000)'), true);
});

test('manual scan bypasses the image-change and timing checks', async () => {
  let answers = 0;
  const app = setup(async () => { answers++; return { ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }; }, true);
  app.run('lastImage = new Uint8Array(128 * 72); lastOcrAt = Date.now(); lastIncomplete = false');
  app.queue.push(questionA);
  await app.run('scan()');
  assert.equal(app.getOcrCalls(), 0);
  await app.elements.scanNow.click();
  await settle();
  assert.equal(app.getOcrCalls(), 1);
  assert.equal(answers, 1);
  assert.equal(app.elements.ocrText.textContent, questionA);
});

test('manual requests during OCR queue one scan without overlapping', async () => {
  let finishFirst;
  let active = 0;
  let maxActive = 0;
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }), false, async queue => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (app.getOcrCalls() === 1) await new Promise(resolve => { finishFirst = resolve; });
    active--;
    return { ok: true, json: async () => ({ text: queue.shift() }) };
  });
  app.queue.push(questionA, questionA);
  const firstScan = app.run('scan()');
  await settle();
  await app.elements.scanNow.click();
  await app.elements.scanNow.click();
  assert.equal(app.getOcrCalls(), 1);
  finishFirst();
  await firstScan;
  await settle();
  assert.equal(app.getOcrCalls(), 2);
  assert.equal(maxActive, 1);
});

test('starts automatic polling at fifteen-second intervals', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
  app.queue.push(questionA);
  await app.elements.start.click();
  await settle();
  assert.deepEqual(app.intervals, [15000]);
  assert.equal(app.elements.scanNow.hidden, false);
  assert.equal(app.elements.pollToggle.hidden, false);
  assert.equal(app.elements.zoomToggle.hidden, false);
  assert.equal(app.elements.pollToggle.textContent, 'Stop polling');
});

test('stopping polling leaves manual scans available and restarting creates one timer', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }));
  app.queue.push(questionA);
  await app.elements.start.click();
  await settle();
  assert.equal(app.activeIntervals.size, 1);

  app.elements.pollToggle.click();
  assert.equal(app.activeIntervals.size, 0);
  assert.equal(app.elements.pollToggle.textContent, 'Start polling');
  app.queue.push(questionB);
  await app.elements.scanNow.click();
  await settle();
  assert.equal(app.getOcrCalls(), 2);
  assert.equal(app.activeIntervals.size, 0);

  app.queue.push(questionB);
  app.elements.pollToggle.click();
  await settle();
  assert.equal(app.activeIntervals.size, 1);
  assert.equal(app.elements.pollToggle.textContent, 'Stop polling');
  app.elements.pollToggle.click();
  assert.equal(app.activeIntervals.size, 0);
});

test('a missing OCR route tells the user to restart the backend', async () => {
  const app = setup(() => {}, false, async () => ({ ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) }));
  await app.run('scan()');
  assert.match(app.elements.status.textContent, /backend is out of date.*restart/i);
});

test('zoom control updates preview and captures the same enlarged camera region', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }));
  app.elements.zoomToggle.click();
  assert.equal(app.elements.zoomPanel.hidden, false);
  assert.equal(app.elements.zoomToggle['aria-expanded'], 'true');
  app.elements.zoomRange.value = '2';
  app.elements.zoomRange.input();
  assert.equal(app.elements.camera.style.transform, 'scale(2)');
  assert.equal(app.elements.zoomValue.textContent, '2.0×');
  app.queue.push(questionA);
  await app.run('scan()');
  assert.deepEqual(app.drawCalls[0].slice(0, 4), [300, 200, 600, 400]);
  assert.deepEqual(app.drawCalls[1].slice(0, 4), [300, 200, 600, 400]);
});

test('landscape full-screen zoom matches the cropped preview', () => {
  const app = setup(() => {});
  app.elements.camera.clientHeight = 300;
  app.run('setFocusMode(true)');
  app.elements.zoomRange.value = '2';
  app.elements.zoomRange.input();
  const area = app.run('visibleCameraArea()');
  assert.deepEqual([area.x, area.y, area.width, area.height], [300, 250, 600, 300]);
});

test('discards OCR result when zoom changes during a request', async () => {
  let finish;
  let answers = 0;
  const app = setup(async () => { answers++; return { ok: true, json: async () => ({ choices: [] }) }; }, false, async () => {
    await new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => ({ text: questionA }) };
  });
  const pending = app.run('scan()');
  await settle();
  app.elements.zoomRange.value = '2';
  app.elements.zoomRange.input();
  finish();
  await pending;
  assert.equal(answers, 0);
  assert.match(app.elements.status.textContent, /view changed/i);
});
