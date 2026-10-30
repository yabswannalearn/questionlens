const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/app.js', 'utf8');
const questionA = 'Which approach should a team use for the application?\nA. Use a database for persistent information.\nB. Use a queue for asynchronous processing.\nC. Use a cache for repeated reads.';
const questionB = 'What should an architect do to limit the risk of accidental exposure?\nA. Configure authorization and access policies.\nB. Disable security logs for the environment.\nC. Publish every credential in the application.';

function setup(fetchImpl, useVisionGate = false, ocrImpl = null, savedSettings = {}) {
  const elements = {};
  const element = () => ({
    textContent: '', hidden: false, children: [], style: { setProperty(name, value) { this[name] = value; } },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, fn) { this[name] = fn; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  for (const id of ['camera', 'start', 'scanNow', 'pollToggle', 'pollCountdown', 'retry', 'status', 'step', 'answers', 'frameText', 'focus', 'rotateLandscape', 'settingsButton', 'settingsPanel', 'closeSettings', 'pollSeconds', 'landscapeFirst', 'ocrText', 'zoomControl', 'zoomToggle', 'zoomSlider', 'zoomHint', 'zoomRange', 'zoomValue']) elements[id] = element();
  Object.assign(elements.camera, { readyState: 2, videoWidth: 1200, videoHeight: 800, clientWidth: 600, clientHeight: 400, style: {}, play: async () => {} });
  elements.zoomRange.value = '1';
  elements.zoomRange.min = '1';
  elements.zoomSlider.hidden = true;
  elements.settingsPanel.hidden = true;
  const storage = new Map(Object.entries(savedSettings));
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
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    innerWidth: 390, innerHeight: 844,
    addEventListener: (name, callback) => { windowEvents[name] = callback; },
    screen: { orientation: { lock: async value => { orientationActions.push(value); }, unlock: () => { orientationActions.push('unlock'); } } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [] }), enumerateDevices: async () => [] } },
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
  return { elements, queue, events, intervals, activeIntervals, drawCalls, orientationActions, windowEvents, classes, storage, getOcrCalls: () => ocrCalls, run: code => vm.runInContext(code, sandbox) };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('shows multiple selected letters together and keeps each answer text', () => {
  const app = setup(() => {});
  app.run(`renderAnswer({choices: [
    {position: 'A', text: 'First answer'},
    {position: 'C', text: 'Third answer'}
  ]})`);
  assert.equal(app.elements.answers.children[0].textContent, 'A, C');
  assert.equal(app.elements.answers.children[1].children[1].textContent, 'First answer');
  assert.equal(app.elements.answers.children[2].children[1].textContent, 'Third answer');
});

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

test('fullscreen leaves the device orientation unchanged and resets controls on exit', async () => {
  const app = setup(() => {});
  app.elements.focus.click();
  await settle();
  assert.equal(app.classes.has('focus-mode'), true);
  assert.equal(app.elements.focus['aria-pressed'], 'true');
  assert.equal(app.elements.rotateLandscape.hidden, false);
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-left'), true);
  app.elements.focus.click();
  assert.equal(app.classes.has('focus-mode'), false);
  assert.equal(app.elements.rotateLandscape.hidden, true);
  assert.equal(app.classes.has('controls-left'), false);
  assert.deepEqual(app.orientationActions, []);
});

test('landscape cycles controls left, right, and portrait without changing the camera', () => {
  const app = setup(() => {});
  app.run('setFocusMode(true)');
  const areaBefore = app.run('visibleCameraArea()');
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-left'), true);
  assert.equal(app.classes.has('vertical-zoom'), true);
  assert.equal(app.classes.has('controls-right'), false);
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-left'), false);
  assert.equal(app.classes.has('controls-right'), true);
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-left'), false);
  assert.equal(app.classes.has('controls-right'), false);
  assert.equal(app.classes.has('vertical-zoom'), false);
  const areaAfter = app.run('visibleCameraArea()');
  assert.deepEqual([areaAfter.x, areaAfter.y, areaAfter.width, areaAfter.height],
                   [areaBefore.x, areaBefore.y, areaBefore.width, areaBefore.height]);
  assert.equal(app.elements.camera.style.transform, undefined);
  assert.deepEqual(app.orientationActions, []);
});

test('physical landscape shows vertical zoom and portrait restores the horizontal layout', () => {
  const app = setup(() => {});
  app.run('setFocusMode(true); innerWidth = 844; innerHeight = 390');
  app.windowEvents.resize();
  assert.equal(app.classes.has('vertical-zoom'), true);
  app.run('innerWidth = 390; innerHeight = 844');
  app.windowEvents.resize();
  assert.equal(app.classes.has('vertical-zoom'), false);
});

test('settings can make landscape cycle right, left, then portrait and remember the choice', () => {
  const app = setup(() => {});
  app.elements.settingsButton.click();
  assert.equal(app.elements.settingsPanel.hidden, false);
  app.elements.landscapeFirst.value = 'right';
  app.elements.landscapeFirst.change();
  app.elements.closeSettings.click();
  assert.equal(app.elements.settingsPanel.hidden, true);
  assert.equal(app.storage.get('questionlens.landscapeFirst'), 'right');
  app.run('setFocusMode(true)');
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-right'), true);
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-left'), true);
  app.elements.rotateLandscape.click();
  assert.equal(app.classes.has('controls-left'), false);
  assert.equal(app.classes.has('controls-right'), false);
  const reopened = setup(() => {}, false, null, Object.fromEntries(app.storage));
  assert.equal(reopened.elements.landscapeFirst.value, 'right');
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
  app.run('lastImage = new Uint8Array(100); lastIncomplete = false');
  assert.equal(app.run('shouldUseVision(new Uint8Array(100))'), false);
  assert.equal(app.run('shouldUseVision(Uint8Array.from({length:100}, (_, i) => i < 50 ? 255 : 0))'), true);
  app.run('lastIncomplete = true');
  assert.equal(app.run('shouldUseVision(new Uint8Array(100))'), true);
});

test('manual scan bypasses the image-change and timing checks', async () => {
  let answers = 0;
  const app = setup(async () => { answers++; return { ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }; }, true);
  app.run('lastImage = new Uint8Array(128 * 72); lastIncomplete = false');
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

test('starts the camera with polling off and no OCR request', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
  await app.elements.start.click();
  await settle();
  assert.deepEqual(app.intervals, []);
  assert.equal(app.getOcrCalls(), 0);
  assert.equal(app.elements.scanNow.hidden, false);
  assert.equal(app.elements.pollToggle.hidden, false);
  assert.equal(app.elements.zoomControl.hidden, false);
  assert.equal(app.elements.pollToggle.textContent, 'Start polling');

  app.queue.push(questionA);
  app.elements.pollToggle.click();
  await settle();
  assert.deepEqual(app.intervals, [1000, 15000]);
  assert.equal(app.getOcrCalls(), 1);
  assert.equal(app.elements.pollToggle.textContent, 'Stop polling');
});

test('stopping polling leaves manual scans available and restarting creates one timer', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }));
  app.queue.push(questionA);
  await app.elements.start.click();
  app.elements.pollToggle.click();
  await settle();
  assert.equal(app.activeIntervals.size, 2);

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
  assert.equal(app.activeIntervals.size, 2);
  assert.equal(app.elements.pollToggle.textContent, 'Stop polling');
  app.elements.pollToggle.click();
  assert.equal(app.activeIntervals.size, 0);
});

test('polling countdown updates and disappears when polling stops', () => {
  const app = setup(() => {});
  app.run('Date.now = () => 100000; scan = () => {}');
  app.elements.pollToggle.click();
  assert.equal(app.elements.pollCountdown.hidden, false);
  assert.equal(app.elements.pollCountdown.textContent, 'Next: 15s');
  app.run('Date.now = () => 104000');
  app.activeIntervals.get(1)();
  assert.equal(app.elements.pollCountdown.textContent, 'Next: 11s');
  app.run('Date.now = () => 115000');
  app.activeIntervals.get(2)();
  assert.equal(app.elements.pollCountdown.textContent, 'Next: 15s');
  app.elements.pollToggle.click();
  assert.equal(app.elements.pollCountdown.hidden, true);
  assert.equal(app.activeIntervals.size, 0);
});

test('changing the polling interval restarts the countdown without an extra scan', () => {
  const app = setup(() => {});
  app.run('Date.now = () => 100000; scan = () => {}');
  app.elements.pollToggle.click();
  app.elements.pollSeconds.value = '30';
  app.elements.pollSeconds.change();
  assert.equal(app.elements.pollCountdown.textContent, 'Next: 30s');
  assert.equal(app.intervals.at(-1), 30000);
  assert.equal(app.activeIntervals.size, 2);
  assert.equal(app.getOcrCalls(), 0);
  assert.equal(app.storage.get('questionlens.pollSeconds'), '30');
  app.elements.pollSeconds.value = '0';
  app.elements.pollSeconds.change();
  assert.equal(app.elements.pollSeconds.value, '30');
  const reopened = setup(() => {}, false, null, Object.fromEntries(app.storage));
  assert.equal(reopened.elements.pollSeconds.value, '30');
});

test('a scheduled changed view is scanned without a second elapsed-time gate', async () => {
  const app = setup(async () => ({ok: true, json: async () => ({choices: [{position: 'A', text: 'Answer'}]})}), true);
  app.run(`
    Date.now = () => 1000;
    lastImage = new Uint8Array(100);
    lastOcrAt = 1001;
    frameFingerprint = () => Uint8Array.from({length: 100}, (_, i) => i < 50 ? 255 : 0);
    startPolling();
    Date.now = () => 15999;
  `);
  app.queue.push(questionA);
  app.activeIntervals.get(2)();
  await settle();
  assert.equal(app.getOcrCalls(), 1);
  app.run('stopPolling()');
});

test('a missing OCR route tells the user to restart the backend', async () => {
  const app = setup(() => {}, false, async () => ({ ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) }));
  await app.run('scan()');
  assert.match(app.elements.status.textContent, /backend is out of date.*restart/i);
});

test('zoom control updates preview and captures the same enlarged camera region', async () => {
  const app = setup(async () => ({ ok: true, json: async () => ({ choices: [{ position: 'A', text: 'Answer' }] }) }));
  assert.equal(app.elements.zoomSlider.hidden, true);
  app.elements.zoomToggle.click();
  assert.equal(app.elements.zoomSlider.hidden, false);
  assert.equal(app.elements.zoomToggle['aria-expanded'], 'true');
  app.elements.zoomRange.value = '2';
  app.elements.zoomRange.input();
  assert.equal(app.elements.camera.style.transform, 'scale(2)');
  assert.equal(app.elements.zoomValue.textContent, '2.0×');
  assert.equal(app.elements.zoomToggle.textContent, '2.0×');
  app.elements.zoomToggle.click();
  assert.equal(app.elements.zoomSlider.hidden, true);
  assert.equal(app.elements.zoomToggle['aria-expanded'], 'false');
  assert.equal(app.elements.camera.style.transform, 'scale(2)');
  app.queue.push(questionA);
  await app.run('scan()');
  assert.deepEqual(app.drawCalls[0].slice(0, 4), [300, 200, 600, 400]);
  assert.deepEqual(app.drawCalls[1].slice(0, 4), [300, 200, 600, 400]);
});

test('0.5× switches to an exposed ultra-wide lens and 1× returns to the standard lens', async () => {
  const app = setup(() => {});
  app.run(`
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'standard', label: 'Back Camera' },
      { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' }
    ];
    navigator.mediaDevices.getUserMedia = async ({ video }) => {
      const id = video.deviceId?.exact || 'standard';
      const track = { getSettings: () => ({deviceId: id}), stop() {} };
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    };
  `);
  await app.elements.start.click();
  assert.equal(app.elements.zoomRange.min, '0.5');
  assert.equal(app.elements.zoomHint.hidden, true);
  app.elements.zoomRange.value = '0.5';
  app.elements.zoomRange.input();
  await settle();
  assert.equal(app.elements.camera.srcObject.getVideoTracks()[0].getSettings().deviceId, 'ultra');
  assert.equal(app.elements.camera.style.transform, 'scale(1)');
  assert.equal(app.elements.zoomValue.textContent, '0.5×');
  app.elements.zoomRange.value = '1';
  app.elements.zoomRange.input();
  await settle();
  assert.equal(app.elements.camera.srcObject.getVideoTracks()[0].getSettings().deviceId, 'standard');
  assert.equal(app.elements.zoomValue.textContent, '1.0×');
});

test('when the browser does not expose ultra-wide, zoom starts at 1×', async () => {
  const app = setup(() => {});
  await app.elements.start.click();
  assert.equal(app.elements.zoomRange.min, '1');
  assert.equal(app.elements.zoomHint.hidden, false);
});

test('failed lens switch restores the previous zoom and reports the error', async () => {
  const app = setup(() => {});
  app.run(`
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' }
    ];
    navigator.mediaDevices.getUserMedia = async ({video}) => {
      if (video.deviceId) throw new Error('camera unavailable');
      const track = {getSettings: () => ({deviceId: 'standard'}), stop() {}, readyState: 'live'};
      return {getTracks: () => [track], getVideoTracks: () => [track]};
    };
  `);
  await app.elements.start.click();
  app.elements.zoomRange.value = '0.5';
  app.elements.zoomRange.input();
  await settle();
  assert.equal(app.elements.zoomValue.textContent, '1.0×');
  assert.match(app.elements.status.textContent, /could not switch camera lenses/i);
  assert.equal(app.elements.camera.srcObject.getVideoTracks()[0].getSettings().deviceId, 'standard');
});

test('a manual scan during a lens switch waits for the new camera', async () => {
  const app = setup(async () => ({ok: true, json: async () => ({choices: [{position: 'A', text: 'Answer'}]})}));
  app.run(`
    navigator.mediaDevices.enumerateDevices = async () => [
      {kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera'}
    ];
    let finishSwitch;
    navigator.mediaDevices.getUserMedia = async ({video}) => {
      const id = video.deviceId?.exact || 'standard';
      if (id === 'ultra') await new Promise(resolve => { finishSwitch = resolve; });
      const track = {getSettings: () => ({deviceId: id}), stop() {}};
      return {getTracks: () => [track], getVideoTracks: () => [track]};
    };
  `);
  await app.elements.start.click();
  app.elements.zoomRange.value = '0.5';
  app.elements.zoomRange.input();
  app.queue.push(questionA);
  app.elements.scanNow.click();
  assert.equal(app.getOcrCalls(), 0);
  app.run('finishSwitch()');
  await settle();
  await settle();
  assert.equal(app.getOcrCalls(), 1);
  assert.equal(app.elements.camera.srcObject.getVideoTracks()[0].getSettings().deviceId, 'ultra');
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
