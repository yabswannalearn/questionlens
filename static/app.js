const video = document.querySelector('#camera');
const startButton = document.querySelector('#start');
const scanNowButton = document.querySelector('#scanNow');
const pollToggleButton = document.querySelector('#pollToggle');
const retryButton = document.querySelector('#retry');
const statusText = document.querySelector('#status');
const step = document.querySelector('#step');
const answers = document.querySelector('#answers');
const frameText = document.querySelector('#frameText');
const focusButton = document.querySelector('#focus');
const rotateButton = document.querySelector('#rotateLandscape');
const ocrText = document.querySelector('#ocrText');
const zoomToggle = document.querySelector('#zoomToggle');
const zoomPanel = document.querySelector('#zoomPanel');
const zoomRange = document.querySelector('#zoomRange');
const zoomValue = document.querySelector('#zoomValue');
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
let lastOcrAt = 0;
const sessionAnswers = new Map();
let currentRequest;
let generation = 0;
let scanning = false;
let processing = false;
let pendingManualScan = false;
let pollingInterval = null;
let lastError = '';
let lastAnswer = null;
let waitingForAnswer = false;
let digitalZoom = 1;
let viewRevision = 0;
let manualRotationRequest = 0;

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
    manualRotationRequest++;
    setLandscapeFallback(false);
  }
  lastImage = null;
  viewRevision++;
  focusButton.setAttribute('aria-pressed', String(enabled));
  focusButton.textContent = enabled ? 'Exit full screen ↙' : 'Full screen ⛶';
}

function setLandscapeFallback(enabled) {
  document.body.classList.toggle('landscape-fallback', enabled);
  rotateButton.textContent = enabled ? '↺ Undo rotation' : '↻ Landscape';
  lastImage = null;
  viewRevision++;
}

rotateButton.addEventListener('click', async () => {
  if (!document.body.classList.contains('focus-mode')) return;
  if (document.body.classList.contains('landscape-fallback')) {
    manualRotationRequest++;
    setLandscapeFallback(false);
    return;
  }
  if (globalThis.innerWidth >= globalThis.innerHeight) return;
  const request = ++manualRotationRequest;
  try {
    if (!globalThis.screen?.orientation?.lock) throw new Error('Orientation lock unavailable');
    await globalThis.screen.orientation.lock('landscape');
  } catch (_) {
    if (request === manualRotationRequest && document.body.classList.contains('focus-mode') && globalThis.innerWidth < globalThis.innerHeight) {
      setLandscapeFallback(true);
    }
  }
});

globalThis.addEventListener?.('resize', () => {
  if (!document.body.classList.contains('focus-mode')) return;
  if (document.body.classList.contains('landscape-fallback') && globalThis.innerWidth > globalThis.innerHeight) {
    setLandscapeFallback(false);
  } else {
    lastImage = null;
    viewRevision++;
  }
});

zoomToggle.addEventListener('click', () => {
  zoomPanel.hidden = !zoomPanel.hidden;
  zoomToggle.setAttribute('aria-expanded', String(!zoomPanel.hidden));
});

zoomRange.addEventListener('input', () => {
  digitalZoom = Math.max(1, Math.min(4, Number(zoomRange.value) || 1));
  const label = `${digitalZoom.toFixed(1)}×`;
  video.style.transform = `scale(${digitalZoom})`;
  zoomValue.textContent = label;
  zoomToggle.textContent = label;
  zoomRange.setAttribute('aria-valuetext', label);
  lastImage = null;
  viewRevision++;
});

let orientationRequest = 0;

async function requestNativeFullscreen() {
  const request = ++orientationRequest;
  try {
    if (document.fullscreenEnabled && document.documentElement?.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch (_) { /* The full-screen layout remains available without browser fullscreen. */ }
  if (request !== orientationRequest || !document.body.classList.contains('focus-mode')) return;
  try {
    await globalThis.screen?.orientation?.lock?.('landscape');
    if (request !== orientationRequest) globalThis.screen?.orientation?.unlock?.();
  } catch (_) { /* Some browsers require the user to rotate the device. */ }
}

focusButton.addEventListener('click', () => {
  const enabled = !document.body.classList.contains('focus-mode');
  setFocusMode(enabled);
  if (enabled) requestNativeFullscreen();
  else {
    orientationRequest++;
    try { globalThis.screen?.orientation?.unlock?.(); } catch (_) { /* Not supported by this browser. */ }
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

function shouldUseVision(image, now) {
  if (!lastImage) return true;
  const elapsed = now - lastOcrAt;
  if (lastIncomplete) return elapsed >= 10000;
  return elapsed >= 5000 && imageChanged(lastImage, image);
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
  pollingInterval = setInterval(scan, 15000);
  pollToggleButton.textContent = 'Stop polling';
}

function stopPolling() {
  if (pollingInterval === null) return;
  clearInterval(pollingInterval);
  pollingInterval = null;
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
  const now = Date.now();
  if (!force && !shouldUseVision(image, now)) return;
  const sceneChanged = lastImage && imageChanged(lastImage, image);
  if (sceneChanged && currentText) {
    answers.replaceChildren();
    retryButton.hidden = true;
    awaitingSceneCheck = true;
    showStatus('SCANNING', 'Connecting to Google Vision…');
  }
  lastImage = image;
  lastOcrAt = now;
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
    zoomToggle.hidden = false;
    startButton.textContent = 'Camera is running';
    document.body.classList.add('running');
    showStatus('SCANNING', 'Keep the complete question and choices in view.');
    startPolling();
    scan();
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
