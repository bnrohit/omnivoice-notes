function bindIntelligenceEvents() {
  els.memoryBtn.addEventListener('click', () => { els.memoryQuestion.value = ''; els.memoryResults.innerHTML = '<p class="muted">Ask about decisions, commitments, changes, people, or topics across your local library.</p>'; els.memoryDialog.showModal(); els.memoryQuestion.focus(); });
  els.memoryRun.addEventListener('click', runOmniMemoryQuery);
  els.memoryQuestion.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runOmniMemoryQuery(); } });
  els.actionsBtn.addEventListener('click', showActionCenter);
}

function normalizeSeriesTitle(title) {
  return String(title || '').toLowerCase()
    .replace(/\b(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.](?:20)?\d{2})\b/g, ' ')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/g, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function findPreviousSession(current) {
  const all = await listSessions();
  const currentTime = Date.parse(current.createdAt || 0);
  const key = normalizeSeriesTitle(current.title);
  let candidates = all.filter(s => s.id !== current.id && Date.parse(s.createdAt || 0) < currentTime && normalizeSeriesTitle(s.title) === key);
  if (!candidates.length) candidates = all.filter(s => s.id !== current.id && Date.parse(s.createdAt || 0) < currentTime && (s.folder || 'Inbox') === (current.folder || 'Inbox') && (s.template || 'general') === (current.template || 'general'));
  return candidates.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] || null;
}

async function compareWithPrevious(id, article) {
  const status = article.querySelector('.process-status');
  const current = await getSession(id); if (!current) return;
  const previous = await findPreviousSession(current);
  if (!previous) { status.textContent = 'No earlier matching meeting was found. Use a consistent title, folder, or template for recurring meetings.'; return; }
  try {
    status.textContent = `Comparing with “${previous.title}”…`;
    const response = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: compactSessionForAI(current), previous: compactSessionForAI(previous) }) });
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || 'Comparison failed.');
    current.comparison = { ...payload, previousId: previous.id, previousTitle: previous.title, previousCreatedAt: previous.createdAt, comparedAt: new Date().toISOString() };
    await putSession(current); status.textContent = 'Meeting changes saved locally.'; await renderSessions();
  } catch (error) { status.textContent = error.message; }
}

function compactSessionForAI(s) {
  return {
    id: s.id, title: s.title, createdAt: s.createdAt,
    summary: s.summary?.summary || '', decisions: s.summary?.decisions || [], actions: s.summary?.actionItems || [], topics: s.summary?.topics || [],
    transcript: String(s.transcript || '').slice(0, 16000)
  };
}

function comparisonHtml(c) {
  if (!c) return '';
  const list = (title, items) => items?.length ? `<h5>${escapeHtml(title)}</h5><ul>${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
  const changes = c.changes?.length ? `<div class="change-list">${c.changes.map(ch => `<div class="change-item importance-${escapeHtml(ch.importance || 'medium')}"><span class="change-type">${escapeHtml(ch.type || 'change')}</span><div><del>${escapeHtml(ch.before || '—')}</del><br><strong>→ ${escapeHtml(ch.after || '—')}</strong></div></div>`).join('')}</div>` : '<p class="muted small">No supported changes were identified.</p>';
  return `<div class="comparison-card"><div class="comparison-head"><div><strong>${escapeHtml(c.headline || 'What changed')}</strong><div class="muted tiny">Compared with ${escapeHtml(c.previousTitle || 'previous meeting')}</div></div></div>${changes}${list('Still unresolved', c.unresolved)}${list('Newly completed', c.newlyCompleted)}${list('New risks', c.newRisks)}</div>`;
}

function bindTruthTraceSources(root) {
  const audio = root.querySelector('.session-audio');
  root.querySelectorAll('.truth-source[data-time-ms]').forEach(btn => btn.addEventListener('click', () => {
    const timeMs = Number(btn.dataset.timeMs); if (!audio || !Number.isFinite(timeMs)) return;
    audio.currentTime = Math.max(0, timeMs / 1000); audio.scrollIntoView({ behavior: 'smooth', block: 'center' }); audio.play().catch(() => {});
  }));
}

function renderComparisonArea(root, session) {
  const area = root.querySelector('.comparison-area');
  if (!area) return;
  if (!session.comparison) { area.classList.add('hidden'); area.innerHTML = ''; return; }
  area.classList.remove('hidden'); area.innerHTML = comparisonHtml(session.comparison);
}

async function runOmniMemoryQuery() {
  const question = els.memoryQuestion.value.trim(); if (!question) return;
  els.memoryRun.disabled = true; els.memoryStatus.textContent = 'Ranking your library locally…'; els.memoryResults.innerHTML = '';
  try {
    const sessions = await listSessions();
    const ranked = rankMemoryCandidates(question, sessions).slice(0, 12);
    if (!ranked.length) throw new Error('There are no transcript/summary memories to search yet.');
    els.memoryStatus.textContent = `Sending ${ranked.length} locally selected memories for AI reasoning…`;
    const payloadSessions = ranked.map(({ session }) => ({
      id: session.id, title: session.title, createdAt: session.createdAt, folder: session.folder || 'Inbox', tags: session.tags || [],
      summary: session.summary?.summary || '', topics: session.summary?.topics || [], transcript: memoryTimeline(session).slice(0, 7000)
    }));
    const response = await fetch('/api/memory/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, sessions: payloadSessions }) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'OmniMemory failed.');
    renderMemoryResult(result); els.memoryStatus.textContent = `Answer grounded in ${result.sources?.length || 0} cited memories.`;
  } catch (error) { els.memoryStatus.textContent = error.message; els.memoryResults.innerHTML = `<div class="notice warning">${escapeHtml(error.message)}</div>`; }
  finally { els.memoryRun.disabled = false; }
}

function memoryTimeline(session) {
  if (session.segments?.length) return session.segments.slice(0,120).map(seg => `[${Math.max(0,Math.round(Number(seg.startMs||0)))}ms] ${seg.speaker ? `${seg.speaker}: ` : ''}${seg.text || ''}`).join('\n');
  return String(session.transcript || '');
}

function rankMemoryCandidates(question, sessions) {
  const qTokens = expandedTokens(question); const now = Date.now();
  return sessions.map(session => {
    const text = [session.title, session.folder, ...(session.tags || []), session.summary?.summary, ...(session.summary?.topics || []), ...(session.summary?.decisions || []), ...(session.summary?.actionItems || []).map(a => a.task), session.transcript].filter(Boolean).join(' ');
    const tokens = new Set(expandedTokens(text));
    let overlap = 0; for (const token of qTokens) if (tokens.has(token)) overlap += token.length > 6 ? 2 : 1;
    const phraseBoost = String(text).toLowerCase().includes(question.toLowerCase()) ? 8 : 0;
    const ageDays = Math.max(0, (now - Date.parse(session.createdAt || now)) / 86400000); const recency = 1 / (1 + ageDays / 90);
    const contentBoost = session.summary ? 1.5 : session.transcript ? 1 : 0;
    return { session, score: overlap * 3 + phraseBoost + recency + contentBoost };
  }).filter(x => x.score > 1).sort((a, b) => b.score - a.score);
}

function expandedTokens(text) {
  const synonyms = { promise:['commitment','action','task','followup'], commitment:['promise','action','task'], deadline:['due','date','timeline'], due:['deadline','date'], decide:['decision','approved','agreed'], decision:['decide','approved','agreed'], risk:['blocker','issue','concern'], blocker:['risk','issue'], owner:['assigned','responsible'], changed:['change','different','moved','updated'] };
  const base = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  const out = new Set(base); for (const token of base) for (const x of synonyms[token] || []) out.add(x); return [...out].slice(0, 2000);
}

function renderMemoryResult(result) {
  els.memoryResults.innerHTML = `<div class="memory-answer"><h3>OmniMemory</h3><p>${escapeHtml(result.answer || 'No answer returned.')}</p></div>`;
  if (result.sources?.length) {
    const wrap = document.createElement('div'); wrap.innerHTML = '<h4>Evidence</h4>';
    for (const src of result.sources) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'memory-source';
      card.innerHTML = `<strong>${escapeHtml(src.title || 'Session')}</strong><span>${escapeHtml(src.quote || '')}</span><small>${Math.round((src.confidence || 0) * 100)}% confidence</small>`;
      card.addEventListener('click', () => focusSession(src.sessionId, src.startMs)); wrap.append(card);
    }
    els.memoryResults.append(wrap);
  }
  if (result.openCommitments?.length) els.memoryResults.insertAdjacentHTML('beforeend', `<h4>Open commitments mentioned</h4><ul>${result.openCommitments.map(a => `<li>${escapeHtml(a.task)}${a.owner ? ` — ${escapeHtml(a.owner)}` : ''}${a.due ? ` — ${escapeHtml(a.due)}` : ''}</li>`).join('')}</ul>`);
  if (result.relatedTopics?.length) els.memoryResults.insertAdjacentHTML('beforeend', `<div class="tag-cloud">${result.relatedTopics.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`);
}

async function focusSession(id, timeMs = null) {
  els.memoryDialog.close(); activeLibraryFilter = { type: 'all', value: '' }; els.search.value = ''; await renderSessions();
  const article = document.querySelector(`.session[data-id="${cssEscape(id)}"]`); if (!article) return;
  article.scrollIntoView({ behavior: 'smooth', block: 'center' }); article.classList.add('focus-flash'); setTimeout(() => article.classList.remove('focus-flash'), 1800);
  const audio = article.querySelector('.session-audio'); if (audio && Number.isFinite(Number(timeMs))) audio.currentTime = Math.max(0, Number(timeMs) / 1000);
}

function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&'); }

async function showActionCenter() {
  const sessions = await listSessions();
  const actions = sessions.flatMap(s => (s.summary?.actionItems || []).map((action, index) => ({ session: s, action, index })))
    .sort((a, b) => Number(a.action.done) - Number(b.action.done) || dueSort(a.action.due) - dueSort(b.action.due));
  els.actionsContent.innerHTML = '';
  if (!actions.length) els.actionsContent.innerHTML = '<p class="muted">Analyze recordings to build your cross-meeting commitment list.</p>';
  for (const item of actions) els.actionsContent.append(buildActionRow(item));
  if (!els.actionsDialog.open) els.actionsDialog.showModal();
}

function buildActionRow({ session, action, index }) {
  const row = document.createElement('div'); row.className = `action-row${action.done ? ' done' : ''}`;
  const info = document.createElement('div'); info.className = 'action-info'; info.innerHTML = `<strong>${escapeHtml(action.task)}</strong><div class="muted tiny">${escapeHtml(session.title)}${action.owner ? ` • ${escapeHtml(action.owner)}` : ''}${action.due ? ` • ${escapeHtml(action.due)}` : ''}</div>`;
  const controls = document.createElement('div'); controls.className = 'button-row';
  controls.append(actionButton(action.done ? 'Reopen' : 'Done', async () => { const s = await getSession(session.id); if (!s?.summary?.actionItems?.[index]) return; s.summary.actionItems[index].done = !s.summary.actionItems[index].done; await putSession(s); await showActionCenter(); await renderSessions(); }), actionButton('Calendar', () => exportSingleActionIcs(session, action)), actionButton('Email draft', () => openActionEmailDraft(session, action)), actionButton('Copy', () => navigator.clipboard?.writeText(action.task)));
  row.append(info, controls); return row;
}

function actionButton(label, handler) { const b = document.createElement('button'); b.type = 'button'; b.className = 'button small-button'; b.textContent = label; b.addEventListener('click', handler); return b; }
function dueSort(value) { const d = parseDueDate(value); return d ? d.getTime() : Number.MAX_SAFE_INTEGER; }
function exportSingleActionIcs(session, action) {
  const dt = parseDueDate(action.due) || new Date(Date.now() + 86400000);
  const event = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OmniVoice Notes//EN\r\nBEGIN:VEVENT\r\nUID:${uid()}@omnivoice\r\nDTSTAMP:${icsDate(new Date())}\r\nDTSTART:${icsDate(dt)}\r\nSUMMARY:${icsEscape(action.task)}\r\nDESCRIPTION:${icsEscape(`From OmniVoice: ${session.title}${action.owner ? ` | Owner: ${action.owner}` : ''}`)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  downloadText(`${safeName(action.task)}.ics`, event, 'text/calendar');
}
function openActionEmailDraft(session, action) {
  const subject = encodeURIComponent(`Follow-up: ${action.task}`); const body = encodeURIComponent(`Action item from “${session.title}”:\n\n${action.task}${action.owner ? `\nOwner: ${action.owner}` : ''}${action.due ? `\nDue: ${action.due}` : ''}\n\nGenerated from OmniVoice Notes.`);
  location.href = `mailto:?subject=${subject}&body=${body}`;
}
