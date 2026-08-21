async function importAudio(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  const fingerprint = await fingerprintBlob(file); const existing = (await listSessions()).find(s => s.fingerprint === fingerprint);
  if (existing && !confirm(`This file looks like a duplicate of “${existing.title}”. Import anyway?`)) return;
  const now = new Date();
  const session = { id: uid(), title: file.name.replace(/\.[^.]+$/, '') || `Imported audio ${now.toLocaleString()}`, createdAt: now.toISOString(), durationMs: 0, mimeType: file.type || inferMime(file.name), blob: file, notes: [], transcript: '', segments: [], summary: null, folder: els.folder.value.trim() || 'Inbox', tags: [], favorite: false, template: els.template.value, language: els.language.value, vocabulary: els.vocabulary.value.trim(), fingerprint, version: 2.1 };
  try { await putSession(session); setStatus(`Imported ${file.name} locally.`); await renderSessions(); } catch (error) { setStatus(`Import failed: ${error?.message || error}`); }
}

async function renderSessions() {
  clearObjectUrls(); const all = await listSessions(); renderLibraryNavigation(all);
  let sessions = filterSessions(all); sessions = sortSessions(sessions, els.sort.value); els.sessions.innerHTML = '';
  if (!sessions.length) { const empty = divNode('muted', [document.createTextNode('No sessions match this view.')]); empty.style.padding = '28px'; els.sessions.append(empty); return; }
  for (const session of sessions) {
    const node = els.sessionTemplate.content.cloneNode(true); const article = node.querySelector('.session'); article.dataset.id = session.id;
    node.querySelector('.session-title').textContent = session.title; node.querySelector('.favorite-btn').textContent = session.favorite ? '★' : '☆';
    const sizeText = session.blob?.size ? ` • ${formatBytes(session.blob.size)}` : ''; const durationText = session.durationMs ? ` • ${formatDuration(session.durationMs)}` : '';
    node.querySelector('.session-meta').textContent = `${new Date(session.createdAt).toLocaleString()}${durationText}${sizeText} • ${session.template || 'general'}`;
    node.querySelector('.folder-line').textContent = `Folder: ${session.folder || 'Inbox'}`;
    const audio = node.querySelector('.session-audio'); if (session.blob) { const url = URL.createObjectURL(session.blob); objectUrls.push(url); audio.src = url; }
    node.querySelector('.speed-select').addEventListener('change', e => { audio.playbackRate = Number(e.target.value); });
    bindSessionActions(node, session.id, article); renderStoredContent(node, session); els.sessions.append(node);
  }
}

function bindSessionActions(root, id, article) {
  root.querySelector('.favorite-btn').addEventListener('click', async () => { const s = await getSession(id); s.favorite = !s.favorite; await putSession(s); renderSessions(); });
  root.querySelector('.summarize-btn').addEventListener('click', () => processSession(id, article));
  root.querySelector('.compare-btn').addEventListener('click', () => compareWithPrevious(id, article));
  root.querySelector('.diarize-btn').addEventListener('click', () => diarizeSession(id, article));
  root.querySelector('.trim-btn').addEventListener('click', () => openTrim(id));
  root.querySelector('.export-btn').addEventListener('click', () => exportSessionPrompt(id));
  root.querySelector('.share-btn').addEventListener('click', () => shareSession(id, article));
  root.querySelector('.delete-btn').addEventListener('click', () => deleteSessionWithConfirm(id));
  root.querySelector('.bookmark-list-btn').addEventListener('click', async () => { const s = await getSession(id); const marks = (s.notes || []).filter(n => n.kind === 'bookmark' || n.kind === 'important'); alert(marks.length ? marks.map(n => `${formatDuration(n.timeMs)} — ${n.text}`).join('\n') : 'No bookmarks.'); });
  root.querySelector('.save-transcript-btn').addEventListener('click', async e => { e.preventDefault(); const s = await getSession(id); s.transcript = root.querySelector('.transcript-editor').value.trim(); await putSession(s); article.querySelector('.process-status').textContent = 'Transcript edits saved locally.'; });
  root.querySelector('.srt-btn').addEventListener('click', e => { e.preventDefault(); exportSrt(id); });
  root.querySelector('.save-meta-btn').addEventListener('click', async e => { e.preventDefault(); const s = await getSession(id); s.folder = root.querySelector('.session-folder').value.trim() || 'Inbox'; s.tags = root.querySelector('.session-tags-input').value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 30); await putSession(s); renderSessions(); });
}

function renderStoredContent(root, session) {
  const summaryArea = root.querySelector('.summary-area'); const tags = root.querySelector('.session-tags'); const transcriptDetails = root.querySelector('.transcript-details'); const notesDetails = root.querySelector('.notes-details');
  const mergedTags = [...new Set([...(session.tags || []), ...(session.summary?.tags || [])])].slice(0, 10); tags.replaceChildren(...mergedTags.map(tag => spanNode('tag', tag)));
  if (session.summary) { summaryArea.classList.remove('hidden'); summaryArea.innerHTML = summaryHtml(session.summary); bindTruthTraceSources(root); }
  renderComparisonArea(root, session);
  if (session.transcript) { transcriptDetails.classList.remove('hidden'); root.querySelector('.transcript-editor').value = session.transcript; }
  if (session.notes?.length) { notesDetails.classList.remove('hidden'); root.querySelector('.saved-notes').textContent = session.notes.map(n => `[${formatDuration(n.timeMs)}]${n.kind && n.kind !== 'note' ? ` [${n.kind}]` : ''} ${n.text}`).join('\n'); }
  root.querySelector('.session-folder').value = session.folder || 'Inbox'; root.querySelector('.session-tags-input').value = (session.tags || []).join(', ');
}

async function processSession(id, article) {
  const status = article.querySelector('.process-status'); const button = article.querySelector('.summarize-btn'); const session = await getSession(id); if (!session) return;
  try {
    button.disabled = true; status.textContent = 'Checking AI configuration…'; const health = await fetch('/api/health').then(r => r.json()).catch(() => null);
    if (!health?.configured) throw new Error('AI processing is not configured on the server.');
    let audioBase64 = '';
    if (!session.transcript) {
      if (!session.blob?.size) throw new Error('No transcript or audio is available.');
      if (session.blob.size > Number(health.maxAudioMb || 18) * 1024 * 1024) throw new Error(`Audio exceeds the server ${health.maxAudioMb} MB processing limit.`);
      status.textContent = 'Preparing audio…'; audioBase64 = await blobToBase64(session.blob);
    }
    status.textContent = session.transcript ? 'Analyzing transcript…' : 'Transcribing and analyzing…';
    const response = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioBase64, mimeType: session.mimeType || session.blob?.type || 'audio/webm', fileName: makeAudioFileName(session), title: session.title, notes: session.notes || [], template: session.template || 'general', language: session.language || '', vocabulary: session.vocabulary || '', transcript: session.transcript || '', segments: session.segments || [], durationMs: session.durationMs || 0 }) });
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || `Processing failed (${response.status}).`);
    const completedTasks = new Set((session.summary?.actionItems || []).filter(a => a.done).map(a => String(a.task || '').trim().toLowerCase())); session.transcript = payload.transcript || session.transcript || ''; session.summary = payload.summary || null; if (session.summary?.actionItems) session.summary.actionItems = session.summary.actionItems.map(a => ({ ...a, done: completedTasks.has(String(a.task || '').trim().toLowerCase()) })); session.tags = [...new Set([...(session.tags || []), ...(session.summary?.tags || [])])].slice(0, 30); await putSession(session);
    status.textContent = 'Analysis saved locally.'; await renderSessions();
  } catch (error) { status.textContent = error?.message || String(error); } finally { button.disabled = false; }
}

async function diarizeSession(id, article) {
  const status = article.querySelector('.process-status'); const s = await getSession(id); if (!s?.blob?.size) { status.textContent = 'No audio available for diarization.'; return; }
  try {
    const health = await fetch('/api/health').then(r => r.json());
    if (!health.diarizationConfigured) throw new Error('Automatic diarization provider is not configured. Live segments currently use editable/manual speaker labels.');
    status.textContent = 'Sending audio to configured diarization provider…';
    const response = await fetch('/api/diarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioBase64: await blobToBase64(s.blob), mimeType: s.mimeType || s.blob.type, fileName: makeAudioFileName(s), language: s.language || '' }) });
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || 'Diarization failed.');
    if (Array.isArray(payload.segments)) { s.segments = payload.segments; s.transcript = payload.segments.map(seg => `${seg.speaker ? `${seg.speaker}: ` : ''}${seg.text || ''}`).join('\n'); await putSession(s); }
    status.textContent = 'Speaker diarization saved.'; await renderSessions();
  } catch (error) { status.textContent = error.message; }
}

async function shareSession(id, article) {
  const status = article.querySelector('.process-status'); const s = await getSession(id); if (!s) return;
  try {
    status.textContent = 'Encrypting share in this browser…';
    const payload = { version: 2, title: s.title, createdAt: s.createdAt, durationMs: s.durationMs, notes: s.notes || [], transcript: s.transcript || '', segments: s.segments || [], summary: s.summary || null, folder: s.folder || 'Inbox', tags: s.tags || [], template: s.template || 'general', language: s.language || '' };
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)); const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']); const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(payload)); const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const response = await fetch('/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) }) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'Share creation failed.');
    const url = `${location.origin}/?share=${encodeURIComponent(result.id)}#key=${base64Url(keyBytes)}`; els.shareLink.value = url; els.shareDialog.showModal(); status.textContent = `Encrypted share created; expires ${new Date(result.expiresAt).toLocaleString()}.`;
  } catch (error) { status.textContent = error.message; }
}

async function maybeOpenSharedLink() {
  const id = new URLSearchParams(location.search).get('share'); if (!id) return;
  const keyMatch = location.hash.match(/(?:^|#|&)key=([^&]+)/); if (!keyMatch) return;
  try {
    const response = await fetch(`/api/shares/${encodeURIComponent(id)}`); const share = await response.json(); if (!response.ok) throw new Error(share.error || 'Share not found.');
    const keyBytes = base64UrlToBytes(keyMatch[1]); const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(share.iv) }, key, base64ToBytes(share.ciphertext));
    sharedPending = JSON.parse(new TextDecoder().decode(decrypted));
    els.sharedContent.innerHTML = `<h3>${escapeHtml(sharedPending.title || 'Shared note')}</h3><p>${escapeHtml(sharedPending.summary?.summary || sharedPending.transcript?.slice(0, 800) || 'No text')}</p>`; els.sharedDialog.showModal();
  } catch (error) { console.warn('Shared note:', error); }
}

async function importSharedNote() {
  if (!sharedPending) return; const now = new Date();
  const s = { ...sharedPending, id: uid(), title: `${sharedPending.title || 'Shared note'} (shared)`, createdAt: sharedPending.createdAt || now.toISOString(), blob: null, mimeType: '', fingerprint: '', favorite: false, version: 2 };
  await putSession(s); els.sharedDialog.close(); history.replaceState({}, '', '/'); sharedPending = null; await renderSessions();
}

function openTrim(id) { els.trimSessionId.value = id; els.trimStart.value = '0'; els.trimEnd.value = ''; els.trimStatus.textContent = ''; els.trimDialog.showModal(); }
async function saveTrimmedCopy() {
  const s = await getSession(els.trimSessionId.value); if (!s?.blob) return;
  try {
    els.trimStatus.textContent = 'Decoding audio…'; const ctx = new (window.AudioContext || window.webkitAudioContext)(); const decoded = await ctx.decodeAudioData(await s.blob.arrayBuffer());
    const start = Math.max(0, Number(els.trimStart.value || 0)); const end = Math.min(decoded.duration, Number(els.trimEnd.value || decoded.duration) || decoded.duration); if (!(end > start)) throw new Error('End time must be after start time.');
    const sr = decoded.sampleRate; const startFrame = Math.floor(start * sr); const endFrame = Math.floor(end * sr); const length = endFrame - startFrame;
    const mono = new Float32Array(length); for (let ch = 0; ch < decoded.numberOfChannels; ch++) { const data = decoded.getChannelData(ch); for (let i = 0; i < length; i++) mono[i] += data[startFrame + i] / decoded.numberOfChannels; }
    const wav = encodeWavMono(mono, sr, els.trimNormalize.checked); await ctx.close(); const fingerprint = await fingerprintBlob(wav);
    const copy = { ...s, id: uid(), title: `${s.title} (trimmed ${start.toFixed(1)}-${end.toFixed(1)}s)`, createdAt: new Date().toISOString(), durationMs: (end - start) * 1000, mimeType: 'audio/wav', blob: wav, notes: (s.notes || []).filter(n => n.timeMs >= start * 1000 && n.timeMs <= end * 1000).map(n => ({ ...n, timeMs: n.timeMs - start * 1000 })), transcript: '', segments: [], summary: null, fingerprint };
    await putSession(copy); els.trimStatus.textContent = 'Trimmed WAV saved as a new local session.'; await renderSessions();
  } catch (error) { els.trimStatus.textContent = `Trim failed: ${error.message}`; }
}

async function exportSessionPrompt(id) {
  const format = (prompt('Export format: md, json, txt, srt, ics', 'md') || '').toLowerCase(); if (!format) return;
  const s = await getSession(id); if (!s) return;
  if (format === 'json') return downloadText(`${safeName(s.title)}.json`, JSON.stringify(stripBlob(s), null, 2), 'application/json');
  if (format === 'srt') return exportSrt(id);
  if (format === 'ics') return exportIcs(s);
  if (format === 'txt') return downloadText(`${safeName(s.title)}.txt`, sessionText(s), 'text/plain');
  return downloadText(`${safeName(s.title)}.md`, sessionMarkdown(s), 'text/markdown');
}
async function exportSrt(id) { const s = await getSession(id); if (!s) return; downloadText(`${safeName(s.title)}.srt`, segmentsToSrt(s), 'application/x-subrip'); }
function exportIcs(s) {
  const actions = s.summary?.actionItems || []; if (!actions.length) return alert('No AI action items to export.');
  const events = actions.map((a, i) => { const dt = parseDueDate(a.due) || new Date(Date.now() + (i + 1) * 3600_000); return `BEGIN:VEVENT\r\nUID:${uid()}@omnivoice\r\nDTSTAMP:${icsDate(new Date())}\r\nDTSTART:${icsDate(dt)}\r\nSUMMARY:${icsEscape(a.task)}\r\nDESCRIPTION:${icsEscape(`From OmniVoice: ${s.title}${a.owner ? ` | Owner: ${a.owner}` : ''}`)}\r\nEND:VEVENT`; }).join('\r\n');
  downloadText(`${safeName(s.title)}-actions.ics`, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OmniVoice Notes//EN\r\n${events}\r\nEND:VCALENDAR\r\n`, 'text/calendar');
}
