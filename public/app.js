const $ = sel => document.querySelector(sel);
const els = {
  title: $('#titleInput'), mode: $('#captureMode'), systemOption: $('#systemOption'), consent: $('#consentInput'),
  timer: $('#timer'), status: $('#recorderStatus'), badge: $('#recordingBadge'), start: $('#startBtn'), pause: $('#pauseBtn'), stop: $('#stopBtn'),
  note: $('#noteInput'), addNote: $('#addNoteBtn'), activeNotes: $('#activeNotes'), sessions: $('#sessions'),
  refresh: $('#refreshBtn'), persist: $('#persistBtn'), persistStatus: $('#persistStatus'), platform: $('#platformPill'),
  iosWarning: $('#iosWarning'), systemWarning: $('#systemWarning'), fileInput: $('#fileInput'), template: $('#sessionTemplate')
};

let recorder = null;
let chunks = [];
let sessionStart = 0;
let pausedAt = 0;
let accumulatedPause = 0;
let timerHandle = null;
let activeNotes = [];
let captureStreams = [];
let audioContext = null;
let wakeLock = null;
let currentMimeType = '';
let objectUrls = [];

const DB_NAME = 'omnivoice-notes';
const DB_VERSION = 1;
const STORE = 'sessions';

init();

async function init() {
  detectPlatform();
  await openDb();
  await renderSessions();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    els.status.textContent = 'This browser cannot record audio directly. You can still import an audio file.';
    els.start.disabled = true;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    els.systemOption.disabled = true;
    els.systemOption.textContent = 'Microphone + tab/system audio (not supported here)';
  }
}

els.start.addEventListener('click', startRecording);
els.pause.addEventListener('click', togglePause);
els.stop.addEventListener('click', stopRecording);
els.addNote.addEventListener('click', addTimestampedNote);
els.note.addEventListener('keydown', e => { if (e.key === 'Enter') addTimestampedNote(); });
els.refresh.addEventListener('click', renderSessions);
els.persist.addEventListener('click', requestPersistentStorage);
els.fileInput.addEventListener('change', importAudio);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && recorder?.state === 'recording' && isIOS()) {
    els.status.textContent = 'Warning: iOS may suspend this recording while the app is backgrounded.';
  }
});
window.addEventListener('beforeunload', e => {
  if (recorder && recorder.state !== 'inactive') {
    e.preventDefault();
    e.returnValue = '';
  }
});

async function startRecording() {
  if (!els.consent.checked) {
    setStatus('Confirm the recording permission/consent acknowledgement first.');
    els.consent.focus();
    return;
  }

  resetActiveSession();
  try {
    setStatus('Requesting microphone permission…');
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    captureStreams.push(mic);
    let recordStream = mic;

    if (els.mode.value === 'mic-system') {
      setStatus('Choose the browser tab/window/screen to capture. Enable shared audio when the browser offers it.');
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      captureStreams.push(display);
      const systemTracks = display.getAudioTracks();
      if (systemTracks.length) {
        recordStream = await mixAudioStreams(mic, display);
        els.systemWarning.classList.add('hidden');
      } else {
        els.systemWarning.textContent = 'The selected screen/tab did not provide an audio track, so this recording is microphone-only.';
        els.systemWarning.classList.remove('hidden');
      }
      display.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (recorder?.state === 'recording') setStatus('Screen sharing ended; microphone recording continues if supported.');
      }));
    }

    currentMimeType = chooseMimeType();
    const options = currentMimeType ? { mimeType: currentMimeType, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 };
    recorder = new MediaRecorder(recordStream, options);
    currentMimeType = recorder.mimeType || currentMimeType || 'audio/webm';
    chunks = [];
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onerror = e => setStatus(`Recorder error: ${e.error?.message || 'unknown error'}`);
    recorder.onstop = finalizeRecording;
    recorder.start(1000);

    sessionStart = Date.now();
    timerHandle = setInterval(updateTimer, 250);
    await requestWakeLock();
    setRecordingUi(true);
    updateTimer();
    setStatus('Recording locally on this device.');
  } catch (error) {
    cleanupCapture();
    recorder = null;
    setRecordingUi(false);
    if (error?.name === 'NotAllowedError') setStatus('Recording permission was denied or the capture picker was cancelled.');
    else setStatus(`Could not start recording: ${error?.message || error}`);
  }
}

function togglePause() {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause();
    pausedAt = Date.now();
    els.pause.textContent = 'Resume';
    setStatus('Paused.');
  } else if (recorder.state === 'paused') {
    recorder.resume();
    accumulatedPause += Date.now() - pausedAt;
    pausedAt = 0;
    els.pause.textContent = 'Pause';
    setStatus('Recording resumed.');
  }
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return;
  if (recorder.state === 'paused' && pausedAt) accumulatedPause += Date.now() - pausedAt;
  setStatus('Stopping and saving locally…');
  recorder.stop();
}

async function finalizeRecording() {
  clearInterval(timerHandle);
  timerHandle = null;
  const end = Date.now();
  const durationMs = Math.max(0, end - sessionStart - accumulatedPause);
  const blob = new Blob(chunks, { type: currentMimeType || chunks[0]?.type || 'audio/webm' });
  const title = els.title.value.trim() || `Voice note ${new Date(sessionStart).toLocaleString()}`;
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const session = {
    id, title, createdAt: new Date(sessionStart).toISOString(), durationMs,
    mimeType: blob.type || currentMimeType, blob, notes: [...activeNotes], transcript: '', summary: null
  };

  try {
    await putSession(session);
    setStatus(`Saved locally (${formatBytes(blob.size)}).`);
  } catch (error) {
    setStatus(`Could not save locally: ${error?.message || error}`);
  } finally {
    cleanupCapture();
    setRecordingUi(false);
    recorder = null;
    chunks = [];
    await renderSessions();
  }
}

async function mixAudioStreams(mic, display) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const destination = audioContext.createMediaStreamDestination();
  const micSource = audioContext.createMediaStreamSource(new MediaStream(mic.getAudioTracks()));
  micSource.connect(destination);
  if (display.getAudioTracks().length) {
    const systemSource = audioContext.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
    systemSource.connect(destination);
  }
  return destination.stream;
}

function chooseMimeType() {
  const candidates = [
    'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}

function addTimestampedNote() {
  if (!recorder || recorder.state === 'inactive') return;
  const text = els.note.value.trim();
  if (!text) return;
  const timeMs = currentElapsed();
  activeNotes.push({ id: crypto.randomUUID?.() || String(Date.now()), timeMs, text });
  els.note.value = '';
  renderActiveNotes();
}

function renderActiveNotes() {
  if (!activeNotes.length) {
    els.activeNotes.className = 'notes-list empty';
    els.activeNotes.textContent = 'No notes yet.';
    return;
  }
  els.activeNotes.className = 'notes-list';
  els.activeNotes.replaceChildren(...activeNotes.map(n => {
    const row = document.createElement('div');
    row.className = 'note-item';
    const time = document.createElement('span');
    time.className = 'time-chip';
    time.textContent = formatDuration(n.timeMs);
    const text = document.createElement('span');
    text.textContent = n.text;
    row.append(time, text);
    return row;
  }));
}

function currentElapsed() {
  if (!sessionStart) return 0;
  const now = pausedAt || Date.now();
  return Math.max(0, now - sessionStart - accumulatedPause);
}

function updateTimer() { els.timer.textContent = formatDuration(currentElapsed()); }

function setRecordingUi(isRecording) {
  els.badge.classList.toggle('hidden', !isRecording);
  els.start.disabled = isRecording || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  els.pause.disabled = !isRecording;
  els.stop.disabled = !isRecording;
  els.note.disabled = !isRecording;
  els.addNote.disabled = !isRecording;
  els.title.disabled = isRecording;
  els.mode.disabled = isRecording;
  els.consent.disabled = isRecording;
  if (!isRecording) {
    els.pause.textContent = 'Pause';
    els.timer.textContent = '00:00';
  }
}

function resetActiveSession() {
  activeNotes = [];
  renderActiveNotes();
  accumulatedPause = 0;
  pausedAt = 0;
  sessionStart = 0;
  chunks = [];
  els.systemWarning.classList.add('hidden');
}

async function cleanupCapture() {
  captureStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
  captureStreams = [];
  if (audioContext) {
    try { await audioContext.close(); } catch {}
    audioContext = null;
  }
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
}

async function importAudio(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = new Date();
  const session = {
    id, title: file.name.replace(/\.[^.]+$/, '') || `Imported audio ${now.toLocaleString()}`,
    createdAt: now.toISOString(), durationMs: 0, mimeType: file.type || inferMime(file.name),
    blob: file, notes: [], transcript: '', summary: null
  };
  try {
    await putSession(session);
    setStatus(`Imported ${file.name} locally.`);
    await renderSessions();
  } catch (error) { setStatus(`Import failed: ${error?.message || error}`); }
}

async function renderSessions() {
  clearObjectUrls();
  const sessions = await listSessions();
  els.sessions.innerHTML = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No saved sessions yet. Start a recording or import an audio file.';
    els.sessions.append(empty);
    return;
  }

  for (const session of sessions) {
    const node = els.template.content.cloneNode(true);
    const article = node.querySelector('.session');
    article.dataset.id = session.id;
    node.querySelector('.session-title').textContent = session.title;
    const sizeText = session.blob?.size ? ` • ${formatBytes(session.blob.size)}` : '';
    const durationText = session.durationMs ? ` • ${formatDuration(session.durationMs)}` : '';
    node.querySelector('.session-meta').textContent = `${new Date(session.createdAt).toLocaleString()}${durationText}${sizeText}`;
    const audio = node.querySelector('.session-audio');
    const url = URL.createObjectURL(session.blob);
    objectUrls.push(url);
    audio.src = url;

    const summarizeBtn = node.querySelector('.summarize-btn');
    summarizeBtn.textContent = session.transcript ? 'Re-summarize' : 'Summarize';
    summarizeBtn.addEventListener('click', () => processSession(session.id, article));
    node.querySelector('.export-btn').addEventListener('click', () => exportSession(session.id));
    node.querySelector('.delete-btn').addEventListener('click', () => deleteSessionWithConfirm(session.id, session.title));

    renderStoredContent(node, session);
    els.sessions.append(node);
  }
}

function renderStoredContent(root, session) {
  const summaryArea = root.querySelector('.summary-area');
  const tags = root.querySelector('.session-tags');
  const transcriptDetails = root.querySelector('.transcript-details');
  const notesDetails = root.querySelector('.notes-details');

  if (session.summary) {
    summaryArea.classList.remove('hidden');
    summaryArea.innerHTML = summaryHtml(session.summary);
    tags.innerHTML = (session.summary.tags || []).slice(0, 8).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  }
  if (session.transcript) {
    transcriptDetails.classList.remove('hidden');
    root.querySelector('.transcript').textContent = session.transcript;
  }
  if (session.notes?.length) {
    notesDetails.classList.remove('hidden');
    root.querySelector('.saved-notes').textContent = session.notes.map(n => `[${formatDuration(n.timeMs)}] ${n.text}`).join('\n');
  }
}

async function processSession(id, article) {
  const status = article.querySelector('.process-status');
  const button = article.querySelector('.summarize-btn');
  const session = await getSession(id);
  if (!session) return;
  if (!session.blob?.size) { status.textContent = 'This session has no audio.'; return; }

  try {
    button.disabled = true;
    status.textContent = 'Preparing audio…';
    const health = await fetch('/api/health').then(r => r.json()).catch(() => null);
    if (!health?.configured) throw new Error('AI processing is not configured on the server. Add OPENAI_API_KEY to .env.');
    const maxBytes = Number(health.maxAudioMb || 18) * 1024 * 1024;
    if (session.blob.size > maxBytes) throw new Error(`This audio is ${formatBytes(session.blob.size)}; the server processing limit is ${health.maxAudioMb} MB.`);

    const audioBase64 = await blobToBase64(session.blob);
    status.textContent = 'Transcribing and summarizing…';
    const response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64,
        mimeType: session.mimeType || session.blob.type || 'audio/webm',
        fileName: makeAudioFileName(session),
        title: session.title,
        notes: session.notes || []
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Processing failed (${response.status}).`);

    session.transcript = payload.transcript || '';
    session.summary = payload.summary || null;
    await putSession(session);
    status.textContent = 'Summary saved locally.';
    await renderSessions();
  } catch (error) {
    status.textContent = error?.message || String(error);
  } finally {
    button.disabled = false;
  }
}

async function exportSession(id) {
  const s = await getSession(id);
  if (!s) return;
  const lines = [
    s.title,
    `Recorded: ${new Date(s.createdAt).toLocaleString()}`,
    s.durationMs ? `Duration: ${formatDuration(s.durationMs)}` : '',
    '',
    'TIMESTAMPED NOTES',
    ...(s.notes?.length ? s.notes.map(n => `[${formatDuration(n.timeMs)}] ${n.text}`) : ['(none)']),
    '',
    'SUMMARY',
    s.summary?.headline || '',
    s.summary?.summary || '',
    '',
    'KEY POINTS',
    ...(s.summary?.keyPoints || []).map(x => `- ${x}`),
    '',
    'DECISIONS',
    ...(s.summary?.decisions || []).map(x => `- ${x}`),
    '',
    'ACTION ITEMS',
    ...(s.summary?.actionItems || []).map(a => `- ${a.task}${a.owner ? ` | Owner: ${a.owner}` : ''}${a.due ? ` | Due: ${a.due}` : ''}`),
    '',
    'FOLLOW-UPS',
    ...(s.summary?.followUps || []).map(x => `- ${x}`),
    '',
    'TRANSCRIPT',
    s.transcript || '(not transcribed)'
  ].filter((x, i, arr) => !(x === '' && arr[i - 1] === ''));
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), `${safeName(s.title)}.txt`);
}

async function deleteSessionWithConfirm(id, title) {
  if (!confirm(`Delete "${title}" from this browser? This cannot be undone.`)) return;
  await deleteSession(id);
  await renderSessions();
}

function summaryHtml(summary) {
  const list = items => items?.length ? `<ul>${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<span class="muted small">None identified.</span>';
  const actions = summary.actionItems?.length
    ? summary.actionItems.map(a => `<div class="action-line">• ${escapeHtml(a.task)}${a.owner ? ` <span class="muted">— ${escapeHtml(a.owner)}</span>` : ''}${a.due ? ` <span class="muted">(${escapeHtml(a.due)})</span>` : ''}</div>`).join('')
    : '<span class="muted small">None identified.</span>';
  return `
    <h4>${escapeHtml(summary.headline || 'Summary')}</h4>
    <p>${escapeHtml(summary.summary || '')}</p>
    <div class="summary-grid">
      <div class="summary-block"><strong>Key points</strong>${list(summary.keyPoints)}</div>
      <div class="summary-block"><strong>Decisions</strong>${list(summary.decisions)}</div>
      <div class="summary-block"><strong>Action items</strong>${actions}</div>
      <div class="summary-block"><strong>Follow-ups</strong>${list(summary.followUps)}</div>
    </div>`;
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    els.persistStatus.textContent = 'Persistent Storage API is not available in this browser.';
    return;
  }
  try {
    const granted = await navigator.storage.persist();
    els.persistStatus.textContent = granted
      ? 'Persistent storage granted. The browser is less likely to evict local recordings automatically.'
      : 'The browser did not grant persistent storage. Export important recordings separately.';
  } catch (error) { els.persistStatus.textContent = `Could not request persistence: ${error?.message || error}`; }
}

async function requestWakeLock() {
  if (!navigator.wakeLock?.request) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function detectPlatform() {
  const ua = navigator.userAgent;
  let platform = 'Browser';
  if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS/iPadOS';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  els.platform.textContent = platform;
  if (isIOS()) els.iosWarning.classList.remove('hidden');
}

function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function setStatus(text) { els.status.textContent = text; }
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function formatBytes(bytes) {
  const units = ['B','KB','MB','GB'];
  let value = Number(bytes || 0), i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function inferMime(name) {
  const ext = name.toLowerCase().split('.').pop();
  return ({ mp3:'audio/mpeg', m4a:'audio/mp4', mp4:'audio/mp4', wav:'audio/wav', webm:'audio/webm', ogg:'audio/ogg' })[ext] || 'application/octet-stream';
}
function makeAudioFileName(session) {
  const mime = session.mimeType || session.blob?.type || '';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
  return `${safeName(session.title)}.${ext}`;
}
function safeName(value) { return String(value || 'voice-note').trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'voice-note'; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}
function clearObjectUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function dbRequest(mode, action) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let out;
      try { out = action(store); } catch (e) { db.close(); reject(e); return; }
      tx.oncomplete = () => { db.close(); resolve(out?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}
function putSession(session) { return dbRequest('readwrite', store => store.put(session)); }
function getSession(id) { return dbRequest('readonly', store => store.get(id)); }
function deleteSession(id) { return dbRequest('readwrite', store => store.delete(id)); }
function listSessions() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const getAll = store.getAll();
      getAll.onsuccess = () => resolve(getAll.result.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))));
      getAll.onerror = () => reject(getAll.error);
      tx.oncomplete = () => db.close();
    };
    req.onerror = () => reject(req.error);
  });
}
