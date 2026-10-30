const video = document.querySelector('#camera');
const startButton = document.querySelector('#start');
const scanNowButton = document.querySelector('#scanNow');
const pollToggleButton = document.querySelector('#pollToggle');
const pollCountdown = document.querySelector('#pollCountdown');
const retryButton = document.querySelector('#retry');
const statusText = document.querySelector('#status');
const step = document.querySelector('#step');
const answers = document.querySelector('#answers');
const frameText = document.querySelector('#frameText');
const focusButton = document.querySelector('#focus');
const rotateButton = document.querySelector('#rotateLandscape');
const settingsButton = document.querySelector('#settingsButton');
const settingsPanel = document.querySelector('#settingsPanel');
const closeSettings = document.querySelector('#closeSettings');
const pollSecondsInput = document.querySelector('#pollSeconds');
const landscapeFirstInput = document.querySelector('#landscapeFirst');
const ocrText = document.querySelector('#ocrText');
const zoomControl = document.querySelector('#zoomControl');
const zoomToggle = document.querySelector('#zoomToggle');
const zoomSlider = document.querySelector('#zoomSlider');
const zoomRange = document.querySelector('#zoomRange');
const zoomValue = document.querySelector('#zoomValue');
const zoomHint = document.querySelector('#zoomHint');
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const thumbnail = document.createElement('canvas');
thumbnail.width = 128;
thumbnail.height = 72;
const thumbnailContext = thumbnail.getContext('2d', { willReadFrequently: true });

let currentText = '';
let currentScanId = '';
let awaitingSceneCheck = false;
let lastIncomplete = false;
let lastImage = null;
const sessionAnswers = new Map();
let currentRequest;
let generation = 0;
let scanning = false;
let processing = false;
let pendingManualScan = false;
let pollingInterval = null;
let countdownInterval = null;
let nextPollAt = 0;
let lastError = '';
let lastAnswer = null;
let waitingForAnswer = false;
let digitalZoom = 1;
let requestedZoom = 1;
let standardDeviceId = null;
let ultraWideDeviceId = null;
let activeLens = 'standard';
let cameraSwitching = false;
let viewRevision = 0;
let controlsRotation = 0;
let pollingSeconds = 15;
let landscapeFirst = 'left';

try {
  const savedSeconds = Number(globalThis.localStorage?.getItem('questionlens.pollSeconds'));
  if (Number.isInteger(savedSeconds) && savedSeconds >= 1 && savedSeconds <= 300) pollingSeconds = savedSeconds;
  if (globalThis.localStorage?.getItem('questionlens.landscapeFirst') === 'right') landscapeFirst = 'right';
} catch (_) { /* Settings remain usable for this page session. */ }
pollSecondsInput.value = String(pollingSeconds);
landscapeFirstInput.value = landscapeFirst;

function saveSetting(key, value) {
  try { globalThis.localStorage?.setItem(`questionlens.${key}`, String(value)); } catch (_) { /* Storage is optional. */ }
}

function showSettings(show) {
  settingsPanel.hidden = !show;
  settingsButton.setAttribute('aria-expanded', String(show));
}

settingsButton.addEventListener('click', () => showSettings(settingsPanel.hidden));
closeSettings.addEventListener('click', () => showSettings(false));
pollSecondsInput.addEventListener('change', () => {
  const value = Number(pollSecondsInput.value);
  if (!Number.isInteger(value) || value < 1 || value > 300) {
    pollSecondsInput.value = String(pollingSeconds);
    return;
  }
  if (value === pollingSeconds) return;
  pollingSeconds = value;
  saveSetting('pollSeconds', value);
  if (pollingInterval !== null) {
    stopPolling();
    startPolling();
  }
});
landscapeFirstInput.addEventListener('change', () => {
  landscapeFirst = landscapeFirstInput.value === 'right' ? 'right' : 'left';
  landscapeFirstInput.value = landscapeFirst;
  saveSetting('landscapeFirst', landscapeFirst);
  setControlsRotation(controlsRotation);
});

function logEvent(name, details = {}) {
  fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...details }), keepalive: true,
  }).catch(() => {});
}

function setFocusMode(enabled) {
  document.body.classList.toggle('focus-mode', enabled);
  rotateButton.hidden = !enabled;
  if (!enabled) {
    setControlsRotation(0);
  }
  updateZoomLayout();
  lastImage = null;
  viewRevision++;
  focusButton.setAttribute('aria-pressed', String(enabled));
  focusButton.textContent = enabled ? 'Exit full screen ↙' : 'Full screen ⛶';
}

function setControlsRotation(rotation) {
  controlsRotation = rotation;
  document.body.classList.toggle('controls-left', rotation === 1);
  document.body.classList.toggle('controls-right', rotation === 2);
  updateZoomLayout();
  const first = landscapeFirst === 'left' ? 1 : 2;
  const next = rotation === 0 ? first : rotation === first ? 3 - first : 0;
  rotateButton.setAttribute('aria-label', ['Return controls to portrait', 'Rotate controls left', 'Rotate controls right'][next]);
}

function updateZoomLayout() {
  document.body.classList.toggle('vertical-zoom', document.body.classList.contains('focus-mode') &&
    (controlsRotation !== 0 || globalThis.innerWidth > globalThis.innerHeight));
}

rotateButton.addEventListener('click', () => {
  if (!document.body.classList.contains('focus-mode')) return;
  const first = landscapeFirst === 'left' ? 1 : 2;
  setControlsRotation(controlsRotation === 0 ? first : controlsRotation === first ? 3 - first : 0);
});

globalThis.addEventListener?.('resize', () => {
  if (!document.body.classList.contains('focus-mode')) return;
  updateZoomLayout();
  lastImage = null;
  viewRevision++;
});

function showZoom(value) {
  zoomRange.value = String(value);
  const label = `${value.toFixed(1)}×`;
  zoomValue.textContent = label;
  zoomToggle.textContent = label;
  zoomRange.setAttribute('aria-valuetext', label);
}

zoomToggle.addEventListener('click', () => {
  zoomSlider.hidden = !zoomSlider.hidden;
  zoomToggle.setAttribute('aria-expanded', String(!zoomSlider.hidden));
  zoomToggle.setAttribute('aria-label', zoomSlider.hidden ? 'Open zoom slider' : 'Close zoom slider');
});

function applyDigitalZoom(value) {
  digitalZoom = activeLens === 'ultra' ? value / 0.5 : value;
  video.style.transform = `scale(${digitalZoom})`;
  lastImage = null;
  viewRevision++;
  showZoom(value);
}

async function findUltraWideCamera() {
  try {
    const track = video.srcObject?.getVideoTracks?.()[0];
    const currentDeviceId = track?.getSettings?.().deviceId || null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(device => device.kind === 'videoinput');
    const ultra = cameras.find(device => /ultra[\s-]*wide/i.test(device.label));
    if (ultra?.deviceId && currentDeviceId) {
      ultraWideDeviceId = ultra.deviceId;
      if (currentDeviceId === ultraWideDeviceId) {
        activeLens = 'ultra';
        standardDeviceId = cameras.find(device => device.deviceId !== currentDeviceId && /(?:back|rear).*camera|wide[\s-]*angle/i.test(device.label) && !/ultra[\s-]*wide/i.test(device.label))?.deviceId || null;
      } else {
        standardDeviceId = currentDeviceId;
      }
      zoomRange.min = '0.5';
      zoomHint.hidden = true;
    }
  } catch (_) { /* The browser may not expose separate camera lenses. */ }
  if (activeLens === 'ultra') applyDigitalZoom(requestedZoom);
  else showZoom(requestedZoom);
}

async function updateZoom() {
  if (cameraSwitching) return;
  const lens = ultraWideDeviceId && (requestedZoom < 1 || !standardDeviceId) ? 'ultra' : 'standard';
  if (lens === activeLens) {
    applyDigitalZoom(requestedZoom);
    return;
  }
  cameraSwitching = true;
  lastImage = null;
  viewRevision++;
  const previousStream = video.srcObject;
  let nextStream;
  try {
    const deviceId = lens === 'ultra' ? ultraWideDeviceId : standardDeviceId;
    nextStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    video.srcObject = nextStream;
    await video.play();
    previousStream?.getTracks().forEach(track => track.stop());
    activeLens = lens;
  } catch (_) {
    nextStream?.getTracks().forEach(track => track.stop());
    try {
      if (previousStream?.getVideoTracks?.()[0]?.readyState === 'ended') {
        const deviceId = activeLens === 'ultra' ? ultraWideDeviceId : standardDeviceId;
        video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
      } else {
        video.srcObject = previousStream;
      }
      await video.play();
    } catch (_) {
      scanning = false;
      stopPolling();
      showStatus('NEEDS ATTENTION', 'Could not restore the camera. Reload the page and start it again.');
      cameraSwitching = false;
      return;
    }
    requestedZoom = activeLens === 'ultra' ? 0.5 : 1;
    showStatus('NEEDS ATTENTION', 'Could not switch camera lenses. Try again.');
  } finally {
    cameraSwitching = false;
  }
  await updateZoom();
  if (pendingManualScan && !processing) {
    pendingManualScan = false;
    scan(true);
  }
}

zoomRange.addEventListener('input', () => {
  requestedZoom = Math.max(Number(zoomRange.min) || 1, Math.min(4, Number(zoomRange.value) || 1));
  lastImage = null;
  viewRevision++;
  updateZoom();
});

async function requestNativeFullscreen() {
  try {
    if (document.fullscreenEnabled && document.documentElement?.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch (_) { /* The full-screen layout remains available without browser fullscreen. */ }
}

focusButton.addEventListener('click', () => {
  const enabled = !document.body.classList.contains('focus-mode');
  setFocusMode(enabled);
  if (enabled) requestNativeFullscreen();
  else {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }
});

function showStatus(label, message) {
  step.textContent = label;
  statusText.textContent = message;
}

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// OCR may change a few characters between scans. Keep the threshold conservative.
function sameText(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return false;
  if (a === b) return true;
  // A small OCR error must not hide a changed number or a word that reverses a question.
  const critical = text => (text.match(/\b(?:not|no|never|except|least|most|only|all|first|last|\d+)\b/g) || []).join(' ');
  if (critical(a) !== critical(b)) return false;
  const max = Math.min(6, Math.floor(Math.max(a.length, b.length) * 0.025));
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = Array(b.length + 1).fill(Infinity);
    if (i <= max) row[0] = i;
    for (let j = Math.max(1, i - max); j <= Math.min(b.length, i + max); j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length] <= max;
}

function plausibleQuestion(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  return text.trim().length >= 50 && lines.length >= 3;
}

function imageChanged(previous, current) {
  if (!previous) return true;
  const mean = data => data.reduce((total, pixel) => total + pixel, 0) / data.length;
  const offset = mean(current) - mean(previous);
  let changed = 0;
  for (let i = 0; i < current.length; i++) {
    if (Math.abs(current[i] - previous[i] - offset) > 20) changed++;
  }
  return changed / current.length > 0.02;
}

function shouldUseVision(image) {
  if (!lastImage) return true;
  return lastIncomplete || imageChanged(lastImage, image);
}

function visibleCameraArea() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const viewWidth = video.clientWidth || width;
  const viewHeight = video.clientHeight || height;
  const fit = document.body.classList.contains('focus-mode')
    ? Math.max(viewWidth / width, viewHeight / height)
    : Math.min(viewWidth / width, viewHeight / height);
  const visibleWidth = Math.min(width, viewWidth / (fit * digitalZoom));
  const visibleHeight = Math.min(height, viewHeight / (fit * digitalZoom));
  return { x: (width - visibleWidth) / 2, y: (height - visibleHeight) / 2, width: visibleWidth, height: visibleHeight };
}

function frameFingerprint(area) {
  thumbnailContext.drawImage(video, area.x, area.y, area.width, area.height, 0, 0, thumbnail.width, thumbnail.height);
  const pixels = thumbnailContext.getImageData(0, 0, thumbnail.width, thumbnail.height).data;
  const gray = new Uint8Array(thumbnail.width * thumbnail.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114);
  }
  return gray;
}

function renderAnswer(data) {
  answers.replaceChildren();
  if (data.choices.length > 1) {
    const summary = document.createElement('div');
    summary.className = 'answer-summary';
    summary.textContent = data.choices.map(choice => choice.position).join(', ');
    answers.append(summary);
  }
  for (const choice of data.choices) {
    const row = document.createElement('div');
    row.className = 'answer';
    const label = document.createElement('span');
    label.className = 'answer-label';
    label.textContent = choice.position;
    const text = document.createElement('span');
    text.className = 'answer-text';
    text.textContent = choice.text;
    row.append(label, text);
    answers.append(row);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startPolling() {
  if (pollingInterval !== null) return;
  nextPollAt = Date.now() + pollingSeconds * 1000;
  pollCountdown.hidden = false;
  updatePollCountdown();
  countdownInterval = setInterval(updatePollCountdown, 1000);
  pollingInterval = setInterval(() => {
    nextPollAt = Date.now() + pollingSeconds * 1000;
    updatePollCountdown();
    scan();
  }, pollingSeconds * 1000);
  pollToggleButton.textContent = 'Stop polling';
}

function updatePollCountdown() {
  pollCountdown.textContent = `Next: ${Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000))}s`;
}

function stopPolling() {
  if (pollingInterval === null) return;
  clearInterval(pollingInterval);
  clearInterval(countdownInterval);
  pollingInterval = null;
  countdownInterval = null;
  pollCountdown.hidden = true;
  pollToggleButton.textContent = 'Start polling';
}

async function askGemini(text, requestGeneration) {
  if (currentRequest) currentRequest.abort();
  currentRequest = new AbortController();
  const controller = currentRequest;
  retryButton.hidden = true;
  lastError = '';
  waitingForAnswer = true;
  for (let attempt = 0; attempt <= 5; attempt++) {
    if (requestGeneration !== generation) return;
    if (!awaitingSceneCheck) showStatus('GEMINI', attempt ? `Retrying Gemini (${attempt}/5)…` : 'Connecting to Gemini…');
    logEvent('ai_attempt', { attempt: attempt + 1 });
    try {
      const response = await fetch('/api/answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, scan_id: currentScanId }), signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || 'Could not reach Gemini.');
      }
      const data = await response.json();
      if (requestGeneration !== generation) return;
      waitingForAnswer = false;
      lastAnswer = data;
      sessionAnswers.set(normalize(text), data);
      if (!awaitingSceneCheck) {
        renderAnswer(data);
        showStatus('ANSWER READY', '');
      }
      return;
    } catch (error) {
      if (error.name === 'AbortError' || requestGeneration !== generation) return;
      lastError = error.message || 'Could not reach Gemini.';
      if (attempt < 5) await delay(2000);
    }
  }
  if (requestGeneration === generation) {
    waitingForAnswer = false;
    if (!awaitingSceneCheck) {
      showStatus('NEEDS ATTENTION', lastError);
      retryButton.hidden = false;
    }
  }
}

async function scan(force = false) {
  if (!scanning) return;
  if (cameraSwitching) {
    if (force) pendingManualScan = true;
    return;
  }
  if (processing) {
    if (force) {
      pendingManualScan = true;
      showStatus('SCANNING', 'Finishing the current scan, then taking another snapshot…');
    }
    return;
  }
  if (video.readyState < 2) {
    showStatus('SCANNING', 'Waiting for the camera image…');
    return;
  }
  const area = visibleCameraArea();
  const image = frameFingerprint(area);
  if (!force && !shouldUseVision(image)) return;
  const sceneChanged = lastImage && imageChanged(lastImage, image);
  if (sceneChanged && currentText) {
    answers.replaceChildren();
    retryButton.hidden = true;
    awaitingSceneCheck = true;
    showStatus('SCANNING', 'Connecting to Google Vision…');
  }
  lastImage = image;
  processing = true;
  const snapshotRevision = viewRevision;
  logEvent('ocr_started');
  if (force || !currentText) showStatus('SCANNING', 'Connecting to Google Vision…');
  const slowScanTimer = setTimeout(() => {
    if (processing) logEvent('ocr_slow');
    if (processing && !waitingForAnswer && !lastAnswer) {
      showStatus('SCANNING', 'Still reading the screen. The first scan may take a little longer.');
    }
  }, 8000);
  try {
    // Capture the same camera area shown in the preview, including digital zoom.
    const width = Math.min(Math.round(area.width), 1600);
    canvas.width = width;
    canvas.height = Math.round(area.height * width / area.width);
    context.drawImage(video, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
    const encodedImage = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    const response = await fetch('/api/ocr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: encodedImage }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(response.status === 404
        ? 'The laptop backend is out of date. Restart it, then reload this page.'
        : error.detail || 'Google Vision could not read the snapshot.');
    }
    const { text: detectedText } = await response.json();
    if (snapshotRevision !== viewRevision) {
      showStatus('SCANNING', 'Camera view changed. Scan again for the new view.');
      return;
    }
    const text = detectedText.trim();
    ocrText.textContent = text || 'No text recognized yet.';
    const result = { characters: text.length, lines: text.split('\n').filter(line => line.trim()).length };
    if (!plausibleQuestion(text)) {
      lastIncomplete = true;
      logEvent('ocr_result', { ...result, outcome: 'incomplete' });
      awaitingSceneCheck = Boolean(currentText);
      answers.replaceChildren();
      retryButton.hidden = true;
      showStatus('SCANNING', 'Keep the complete question and choices in view.');
      return;
    }
    if (sameText(text, currentText)) {
      lastIncomplete = false;
      logEvent('ocr_result', { ...result, outcome: 'unchanged' });
      if (awaitingSceneCheck || force) {
        if (lastAnswer) {
          renderAnswer(lastAnswer);
          showStatus('ANSWER READY', '');
        } else if (waitingForAnswer) {
          showStatus('GEMINI', 'Asking Gemini…');
        } else if (lastError) {
          showStatus('NEEDS ATTENTION', lastError);
          retryButton.hidden = false;
        }
      }
      awaitingSceneCheck = false;
      return;
    }
    currentText = text;
    lastIncomplete = false;
    logEvent('ocr_result', { ...result, outcome: 'confirmed' });
    currentScanId = crypto.randomUUID();
    awaitingSceneCheck = false;
    answers.replaceChildren();
    retryButton.hidden = true;
    generation++;
    lastAnswer = null;
    const cached = sessionAnswers.get(normalize(text));
    if (cached) {
      if (currentRequest) currentRequest.abort();
      waitingForAnswer = false;
      lastAnswer = cached;
      renderAnswer(cached);
      showStatus('ANSWER READY', '');
      logEvent('answer_cached');
    } else {
      askGemini(text, generation);
    }
  } catch (error) {
    lastIncomplete = true;
    logEvent('ocr_error');
    showStatus('NEEDS ATTENTION', error.message || 'Could not read the screen. Keep the question and choices in view.');
    console.error('OCR failed:', error);
  } finally {
    clearTimeout(slowScanTimer);
    processing = false;
    if (pendingManualScan) {
      pendingManualScan = false;
      scan(true);
    }
  }
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  setFocusMode(true);
  requestNativeFullscreen();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS. Open this app using its trusted HTTPS address.');
    showStatus('CAMERA', 'Starting the camera…');
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    await video.play();
    logEvent('camera_started');
    frameText.hidden = true;
    logEvent('ocr_ready');
    scanning = true;
    scanNowButton.hidden = false;
    pollToggleButton.hidden = false;
    pollToggleButton.textContent = 'Start polling';
    zoomControl.hidden = false;
    startButton.textContent = 'Camera is running';
    document.body.classList.add('running');
    showStatus('POLLING OFF', 'Tap Start polling or Scan now when you are ready.');
    await findUltraWideCamera();
  } catch (error) {
    logEvent('camera_error');
    video.srcObject?.getTracks().forEach(track => track.stop());
    video.srcObject = null;
    frameText.hidden = false;
    showStatus('NEEDS ATTENTION', error.message || 'Could not start the camera. Check Safari camera permissions.');
    startButton.disabled = false;
  }
});

retryButton.addEventListener('click', () => {
  if (currentText) askGemini(currentText, generation);
});

scanNowButton.addEventListener('click', () => scan(true));

pollToggleButton.addEventListener('click', () => {
  if (pollingInterval === null) {
    startPolling();
    scan();
  } else {
    stopPolling();
  }
});
