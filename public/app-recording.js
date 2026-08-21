async function startRecording() {
  if (!els.consent.checked) { setStatus('Confirm recording permission/consent first.'); els.consent.focus(); return; }
  resetActiveSession();
  try {
    setStatus('Requesting microphone permission…');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: els.noise.checked, autoGainControl: els.gain.checked, channelCount: 1 }, video: false });
    captureStreams.push(mic);
    let recordStream = mic;
    if (els.mode.value === 'mic-system') {
      setStatus('Choose a tab/window/screen and enable shared audio when offered.');
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      captureStreams.push(display);
      if (display.getAudioTracks().length) {
        recordStream = await mixAudioStreams(mic, display);
        els.systemWarning.classList.add('hidden');
      } else {
        els.systemWarning.textContent = 'No system audio track was provided; this session is microphone-only.';
        els.systemWarning.classList.remove('hidden');
      }
    }

    await setupAudioAnalysis(recordStream);
    currentMimeType = chooseMimeType();
    const audioBitsPerSecond = Number(els.quality.value || 128000);
    recorder = new MediaRecorder(recordStream, currentMimeType ? { mimeType: currentMimeType, audioBitsPerSecond } : { audioBitsPerSecond });
    currentMimeType = recorder.mimeType || currentMimeType || 'audio/webm';
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
    await cleanupCapture(); recorder = null; setRecordingUi(false);
    setStatus(error?.name === 'NotAllowedError' ? 'Recording permission was denied or capture selection was cancelled.' : `Could not start recording: ${error?.message || error}`);
  }
}

async function setupAudioAnalysis(stream) {
  analysisContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = analysisContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  analyser = analysisContext.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser); drawWaveform();
  if (els.live.checked && analysisContext.audioWorklet) {
    try {
      await analysisContext.audioWorklet.addModule('/live-capture-worklet.js');
      pcmNode = new AudioWorkletNode(analysisContext, 'omnivoice-pcm-capture');
      const silent = analysisContext.createGain(); silent.gain.value = 0;
      source.connect(pcmNode); pcmNode.connect(silent); silent.connect(analysisContext.destination);
      pcmNode.port.onmessage = event => collectPcm(event.data);
      els.liveStatus.textContent = 'listening';
    } catch (error) { els.liveStatus.textContent = 'unsupported'; console.warn(error); }
  } else els.liveStatus.textContent = els.live.checked ? 'unsupported' : 'off';
}

function collectPcm(data) {
  if (!recorder || recorder.state !== 'recording' || !(data instanceof Float32Array)) return;
  pcmBuffers.push(data); pcmSamples += data.length;
  const threshold = Math.floor((analysisContext?.sampleRate || 48000) * LIVE_CHUNK_SECONDS);
  if (pcmSamples >= threshold && !liveInFlight) flushLiveChunk();
}

async function flushLiveChunk() {
  if (!pcmSamples || liveInFlight || !analysisContext) return;
  liveInFlight = true;
  const buffers = pcmBuffers; const sampleCount = pcmSamples; pcmBuffers = []; pcmSamples = 0;
  const merged = concatFloat32(buffers, sampleCount);
  const durationMs = merged.length / analysisContext.sampleRate * 1000;
  const startMs = liveCursorMs; const endMs = startMs + durationMs; liveCursorMs = endMs;
  try {
    els.liveStatus.textContent = 'transcribing';
    const wav = encodeWavMono(merged, analysisContext.sampleRate, false);
    const response = await fetch('/api/live/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioBase64: await blobToBase64(wav), mimeType: 'audio/wav', language: els.language.value, vocabulary: els.vocabulary.value }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Live transcription failed (${response.status})`);
    const text = String(payload.text || '').trim();
    if (text) {
      liveSegments.push({ id: uid(), startMs, endMs, speaker: 'Speaker 1', text });
      renderLiveTranscript();
      if (els.voiceCommands.checked) detectVoiceCommands(text, endMs);
    }
    els.liveStatus.textContent = 'live';
  } catch (error) {
    console.warn(error); els.liveStatus.textContent = 'degraded';
  } finally {
    liveInFlight = false;
    const threshold = Math.floor((analysisContext?.sampleRate || 48000) * LIVE_CHUNK_SECONDS);
    if (pcmSamples >= threshold) flushLiveChunk();
  }
}

function detectVoiceCommands(text, timeMs) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === lastVoiceCommandText) return;
  const commands = [
    { re: /mark (this )?as important|this is important/, kind: 'important', label: 'Voice command: important' },
    { re: /action item|create (an )?action item/, kind: 'action', label: 'Voice command: action item' },
    { re: /bookmark (this|that)|mark (this|that)/, kind: 'bookmark', label: 'Voice command: bookmark' },
    { re: /follow up|remind me/, kind: 'followup', label: 'Voice command: follow-up' }
  ];
  const match = commands.find(c => c.re.test(normalized));
  if (match) {
    lastVoiceCommandText = normalized;
    activeNotes.push({ id: uid(), timeMs, text: match.label, kind: match.kind });
    renderActiveNotes();
  }
}

function drawWaveform() {
  if (!analyser) return;
  const ctx = els.waveform.getContext('2d'); const data = new Uint8Array(analyser.fftSize);
  const draw = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(data);
    const w = els.waveform.width, h = els.waveform.height;
    ctx.clearRect(0, 0, w, h); ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < data.length; i++) { const x = i / (data.length - 1) * w; const y = data[i] / 255 * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke(); animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function togglePause() {
  if (!recorder) return;
  if (recorder.state === 'recording') { recorder.pause(); pausedAt = Date.now(); els.pause.textContent = 'Resume'; setStatus('Paused.'); }
  else if (recorder.state === 'paused') { recorder.resume(); accumulatedPause += Date.now() - pausedAt; pausedAt = 0; els.pause.textContent = 'Pause'; setStatus('Recording resumed.'); }
}
function stopRecording() { if (!recorder || recorder.state === 'inactive') return; if (recorder.state === 'paused' && pausedAt) accumulatedPause += Date.now() - pausedAt; setStatus('Stopping and saving locally…'); recorder.stop(); }

async function finalizeRecording() {
  clearInterval(timerHandle); timerHandle = null;
  if (pcmSamples && !liveInFlight) await flushLiveChunk().catch(() => {});
  const end = Date.now(); const durationMs = Math.max(0, end - sessionStart - accumulatedPause);
  const blob = new Blob(chunks, { type: currentMimeType || chunks[0]?.type || 'audio/webm' });
  const title = els.title.value.trim() || `Voice note ${new Date(sessionStart).toLocaleString()}`;
  const fingerprint = await fingerprintBlob(blob);
  const sessions = await listSessions();
  const duplicate = sessions.find(s => s.fingerprint && s.fingerprint === fingerprint && Math.abs((s.durationMs || 0) - durationMs) < 1500);
  if (duplicate && !confirm(`This audio looks like a duplicate of “${duplicate.title}”. Save another copy anyway?`)) {
    await cleanupCapture(); setRecordingUi(false); recorder = null; setStatus('Duplicate copy discarded.'); return;
  }
  const session = {
    id: uid(), title, createdAt: new Date(sessionStart).toISOString(), durationMs, mimeType: blob.type || currentMimeType, blob,
    notes: [...activeNotes], transcript: liveSegments.map(s => s.text).join(' ').trim(), segments: [...liveSegments], summary: null,
    folder: els.folder.value.trim() || 'Inbox', tags: [], favorite: false, template: els.template.value, language: els.language.value,
    vocabulary: els.vocabulary.value.trim(), fingerprint, version: 2
  };
  try { await putSession(session); localStorage.removeItem('omnivoice-draft'); setStatus(`Saved locally (${formatBytes(blob.size)}).`); }
  catch (error) { setStatus(`Could not save locally: ${error?.message || error}`); }
  finally { await cleanupCapture(); setRecordingUi(false); recorder = null; chunks = []; await renderSessions(); }
}

async function mixAudioStreams(mic, display) {
  mixContext = new (window.AudioContext || window.webkitAudioContext)();
  const destination = mixContext.createMediaStreamDestination();
  const compressor = mixContext.createDynamicsCompressor(); compressor.threshold.value = -24; compressor.knee.value = 30; compressor.ratio.value = 5; compressor.attack.value = .003; compressor.release.value = .25;
  const micSource = mixContext.createMediaStreamSource(new MediaStream(mic.getAudioTracks())); micSource.connect(compressor);
  if (display.getAudioTracks().length) mixContext.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(compressor);
  compressor.connect(destination); return destination.stream;
}
function chooseMimeType() { return ['audio/webm;codecs=opus','audio/webm','audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported?.(type)) || ''; }

function addTimestampedNote(textOverride = '', kind = 'note') {
  if (!recorder || recorder.state === 'inactive') return;
  const text = String(textOverride || els.note.value).trim(); if (!text) return;
  activeNotes.push({ id: uid(), timeMs: currentElapsed(), text, kind }); els.note.value = ''; renderActiveNotes();
}
function renderActiveNotes() {
  if (!activeNotes.length) { els.activeNotes.className = 'notes-list empty'; els.activeNotes.textContent = 'No notes yet.'; return; }
  els.activeNotes.className = 'notes-list'; els.activeNotes.replaceChildren(...activeNotes.map(n => divNode('note-item', [spanNode('time-chip', formatDuration(n.timeMs)), document.createTextNode(`${n.kind && n.kind !== 'note' ? `[${n.kind}] ` : ''}${n.text}`)])));
}
function renderLiveTranscript() {
  if (!liveSegments.length) { els.liveTranscript.className = 'live-transcript empty'; els.liveTranscript.textContent = 'Live transcript will appear here.'; return; }
  els.liveTranscript.className = 'live-transcript'; els.liveTranscript.replaceChildren(...liveSegments.map(s => {
    const row = document.createElement('div'); row.className = 'live-segment';
    row.append(spanNode('time-chip', formatDuration(s.startMs)), spanNode('speaker', s.speaker || 'Speaker 1'), document.createTextNode(s.text)); return row;
  })); els.liveTranscript.scrollTop = els.liveTranscript.scrollHeight;
}
function currentElapsed() { if (!sessionStart) return 0; const now = pausedAt || Date.now(); return Math.max(0, now - sessionStart - accumulatedPause); }
function updateTimer() { els.timer.textContent = formatDuration(currentElapsed()); }
function setRecordingUi(on) {
  els.badge.classList.toggle('hidden', !on); els.start.disabled = on || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  [els.pause, els.stop, els.bookmark, els.note, els.addNote].forEach(el => el.disabled = !on); [els.title, els.mode, els.consent, els.template, els.folder, els.language, els.quality].forEach(el => el.disabled = on);
  if (!on) { els.pause.textContent = 'Pause'; els.timer.textContent = '00:00'; }
}
function resetActiveSession() {
  activeNotes = []; liveSegments = []; chunks = []; pcmBuffers = []; pcmSamples = 0; liveCursorMs = 0; accumulatedPause = 0; pausedAt = 0; sessionStart = 0; lastVoiceCommandText = '';
  renderActiveNotes(); renderLiveTranscript(); els.systemWarning.classList.add('hidden');
}
async function cleanupCapture() {
  captureStreams.forEach(s => s.getTracks().forEach(t => t.stop())); captureStreams = [];
  if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = null; analyser = null; pcmNode = null;
  for (const ctx of [analysisContext, mixContext]) if (ctx) try { await ctx.close(); } catch {}
  analysisContext = null; mixContext = null;
  if (wakeLock) try { await wakeLock.release(); } catch {} wakeLock = null;
  els.liveStatus.textContent = 'idle';
}
