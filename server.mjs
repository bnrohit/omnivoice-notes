import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const shareDir = path.join(__dirname, 'data', 'shares');
await loadDotEnv(path.join(__dirname, '.env'));
await fs.mkdir(shareDir, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const MAX_AUDIO_MB = Math.max(1, Number(process.env.MAX_AUDIO_MB || 18));
const MAX_JSON_BYTES = Math.ceil(MAX_AUDIO_MB * 1024 * 1024 * 1.45) + 1024 * 1024;
const MAX_SHARE_KB = Math.max(16, Number(process.env.MAX_SHARE_KB || 512));
const SHARE_TTL_HOURS = Math.max(1, Number(process.env.SHARE_TTL_HOURS || 168));
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const LIVE_TRANSCRIBE_MODEL = process.env.OPENAI_LIVE_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || 'gpt-5.6-luna';
const rateWindowMs = 60_000;
const rateMax = 24;
const buckets = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        configured: Boolean(process.env.OPENAI_API_KEY),
        transcribeModel: TRANSCRIBE_MODEL,
        liveTranscribeModel: LIVE_TRANSCRIBE_MODEL,
        summaryModel: SUMMARY_MODEL,
        maxAudioMb: MAX_AUDIO_MB,
        diarizationConfigured: Boolean(process.env.DIARIZATION_ENDPOINT),
        encryptedShares: true,
        outboundWebhookConfigured: Boolean(process.env.OUTBOUND_WEBHOOK_URL)
      });
    }

    if (url.pathname === '/api/live/transcribe' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many live transcription requests.' });
      requireAI();
      const body = await readJson(req, 5 * 1024 * 1024);
      const { audioBase64, mimeType = 'audio/wav', language = '', vocabulary = '' } = body || {};
      if (!audioBase64) return json(res, 400, { error: 'Missing audio data.' });
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      if (!audioBuffer.length || audioBuffer.length > 3 * 1024 * 1024) return json(res, 413, { error: 'Live audio chunk is empty or too large.' });
      const text = await transcribeAudio(audioBuffer, mimeType, 'live-chunk.wav', { model: LIVE_TRANSCRIBE_MODEL, language, vocabulary });
      return json(res, 200, { text });
    }

    if (url.pathname === '/api/process' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many processing requests. Try again in a minute.' });
      requireAI();
      const body = await readJson(req, MAX_JSON_BYTES);
      const { audioBase64, mimeType = 'audio/webm', fileName = 'recording.webm', title = 'Voice note', notes = [], template = 'general', language = '', vocabulary = '', transcript: providedTranscript = '', segments = [], durationMs = 0 } = body || {};
      let transcript = String(providedTranscript || '').trim();
      if (!transcript) {
        if (!audioBase64 || typeof audioBase64 !== 'string') return json(res, 400, { error: 'Missing audio data or transcript.' });
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        if (!audioBuffer.length) return json(res, 400, { error: 'Audio is empty.' });
        if (audioBuffer.length > MAX_AUDIO_MB * 1024 * 1024) return json(res, 413, { error: `Audio exceeds the ${MAX_AUDIO_MB} MB processing limit.` });
        transcript = await transcribeAudio(audioBuffer, mimeType, sanitizeFileName(fileName), { model: TRANSCRIBE_MODEL, language, vocabulary });
      }
      const summary = await summarizeTranscript({ title, transcript, notes, template, language, segments, durationMs });
      await fireConfiguredWebhook({ event: 'session.processed', title, transcript, summary }).catch(err => console.warn('Webhook:', err.message));
      return json(res, 200, { transcript, summary });
    }

    if (url.pathname === '/api/diarize' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many diarization requests.' });
      if (!process.env.DIARIZATION_ENDPOINT) return json(res, 501, { error: 'Automatic diarization provider is not configured. Manual speaker labels remain available.' });
      const body = await readJson(req, MAX_JSON_BYTES);
      const provider = await fetch(process.env.DIARIZATION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.DIARIZATION_BEARER_TOKEN ? { Authorization: `Bearer ${process.env.DIARIZATION_BEARER_TOKEN}` } : {})
        },
        body: JSON.stringify(body)
      });
      const payload = await safeJson(provider);
      if (!provider.ok) throw upstreamError('Diarization provider failed', provider.status, payload);
      return json(res, 200, payload);
    }



    if (url.pathname === '/api/memory/query' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many memory requests.' });
      requireAI();
      const body = await readJson(req, 1024 * 1024);
      const question = String(body?.question || '').trim();
      const sessions = Array.isArray(body?.sessions) ? body.sessions.slice(0, 16) : [];
      if (!question) return json(res, 400, { error: 'Ask a question first.' });
      if (!sessions.length) return json(res, 400, { error: 'No memory candidates were supplied.' });
      const result = await answerMemoryQuestion(question, sessions);
      return json(res, 200, result);
    }

    if (url.pathname === '/api/compare' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many comparison requests.' });
      requireAI();
      const body = await readJson(req, 768 * 1024);
      if (!body?.current || !body?.previous) return json(res, 400, { error: 'Current and previous sessions are required.' });
      const result = await compareMeetings(body.current, body.previous);
      return json(res, 200, result);
    }

    if (url.pathname === '/api/shares' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many share requests.' });
      const body = await readJson(req, MAX_SHARE_KB * 1024 + 4096);
      const ciphertext = String(body?.ciphertext || '');
      const iv = String(body?.iv || '');
      if (!ciphertext || !iv || ciphertext.length > MAX_SHARE_KB * 1400) return json(res, 400, { error: 'Invalid encrypted share payload.' });
      const id = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const share = { id, ciphertext, iv, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SHARE_TTL_HOURS * 3600_000).toISOString() };
      await fs.writeFile(path.join(shareDir, `${id}.json`), JSON.stringify(share), { flag: 'wx' });
      return json(res, 201, { id, expiresAt: share.expiresAt });
    }

    const shareMatch = url.pathname.match(/^\/api\/shares\/([a-f0-9]{32})$/);
    if (shareMatch && req.method === 'GET') {
      const share = await readShare(shareMatch[1]);
      if (!share) return json(res, 404, { error: 'Share not found or expired.' });
      return json(res, 200, share);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    await serveStatic(url.pathname, req, res);
  } catch (error) {
    const status = error?.statusCode || 500;
    console.error(error);
    json(res, status, { error: status === 500 ? 'Unexpected server error.' : error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OmniVoice Notes v2 running on http://localhost:${PORT}`);
  console.log(process.env.OPENAI_API_KEY ? 'AI processing: configured' : 'AI processing: disabled until OPENAI_API_KEY is set');
});

function requireAI() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('AI processing is not configured. Set OPENAI_API_KEY on the server.');
    err.statusCode = 503;
    throw err;
  }
}

async function transcribeAudio(buffer, mimeType, fileName, { model, language, vocabulary } = {}) {
  const form = new FormData();
  form.append('model', model || TRANSCRIBE_MODEL);
  if (language) form.append('language', String(language).slice(0, 20));
  if (vocabulary) form.append('prompt', `Preferred vocabulary/spellings: ${String(vocabulary).slice(0, 1000)}`);
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form
  });
  const payload = await safeJson(response);
  if (!response.ok) throw upstreamError('Transcription failed', response.status, payload);
  const text = payload?.text?.trim();
  if (!text) throw new Error('Transcription returned no text.');
  return text;
}

async function summarizeTranscript({ title, transcript, notes, template, language, segments = [], durationMs = 0 }) {
  const noteLines = Array.isArray(notes) ? notes.slice(0, 300).map(n => `[${formatMs(Number(n.timeMs || 0))}] ${String(n.kind || 'note').toUpperCase()}: ${String(n.text || '').slice(0, 700)}`).join('\n') : '';
  const timeline = buildEvidenceTimeline(segments, transcript, durationMs);
  const templateGuidance = {
    standup: 'Emphasize yesterday/today/blockers and concrete owners.',
    'one-on-one': 'Emphasize coaching themes, commitments, concerns, and follow-ups.',
    interview: 'Emphasize questions, candidate answers, evidence, and unresolved topics. Do not make a hiring decision.',
    lecture: 'Create study-ready concepts, definitions, examples, questions, and flashcard candidates.',
    podcast: 'Emphasize themes, memorable claims, segments, and follow-up references.',
    retrospective: 'Organize what went well, what did not, lessons, and experiments.',
    journal: 'Summarize themes without inventing psychological diagnoses.',
    dictation: 'Preserve intent and produce clean structured prose.',
    general: 'Produce a concise, useful voice-note summary.'
  }[template] || 'Produce a concise, useful voice-note summary.';

  const input = `Analyze this voice note. ${templateGuidance}\nLanguage hint: ${language || 'auto'}\nTitle: ${String(title).slice(0, 200)}\nTimestamped notes:\n${noteLines || '(none)'}\n\nEVIDENCE TIMELINE (cite only these rows; null times mean the timestamp is not reliable):\n${timeline}\n\nTranscript:\n${transcript}\n\nReturn ONLY valid JSON with this exact shape:\n{\n"headline":"one line",\n"summary":"concise paragraph",\n"keyPoints":["..."],\n"decisions":["..."],\n"actionItems":[{"task":"...","owner":"","due":""}],\n"followUps":["..."],\n"tags":["..."],\n"topics":["..."],\n"sentiment":{"label":"positive|neutral|mixed|negative|unknown","explanation":"brief evidence-based explanation"},\n"questions":["..."],\n"flashcards":[{"front":"...","back":"..."}],\n"evidence":[{"claimType":"decision|action|keyPoint|followUp|sentiment|other","claim":"claim supported by the recording","confidence":0.0,"sources":[{"segmentIndex":0,"startMs":0,"endMs":4000,"speaker":"Speaker 1","quote":"short exact supporting phrase"}]}]\n}\nFor evidence: confidence must be 0 to 1. Never fabricate timestamps, speakers, quotes, owners, dates, decisions, or facts. If the timeline row has startMs=null, return startMs/endMs as null. Quotes must be short and visibly supported by the supplied evidence timeline.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SUMMARY_MODEL, input })
  });
  const payload = await safeJson(response);
  if (!response.ok) throw upstreamError('Summary generation failed', response.status, payload);
  return parseSummary(extractResponseText(payload));
}

function buildEvidenceTimeline(segments, transcript, durationMs) {
  const cleanSegments = Array.isArray(segments) ? segments.slice(0, 240).filter(s => String(s?.text || '').trim()) : [];
  if (cleanSegments.length) return cleanSegments.map((s, i) => `SEGMENT ${i} | startMs=${finiteOrNull(s.startMs)} | endMs=${finiteOrNull(s.endMs)} | speaker=${String(s.speaker || '') || 'unknown'} | ${String(s.text || '').replace(/\s+/g, ' ').slice(0, 700)}`).join('\n');
  const parts = String(transcript || '').split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 160);
  return parts.map((text, i) => `SEGMENT ${i} | startMs=null | endMs=null | speaker=unknown | ${text.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n') || '(no timeline available)';
}

function finiteOrNull(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 'null'; }

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) for (const content of item?.content || []) if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
  return parts.join('\n').trim();
}

function parseSummary(text) {
  const fallback = { headline: 'Analysis generated', summary: text || '', keyPoints: [], decisions: [], actionItems: [], followUps: [], tags: [], topics: [], sentiment: { label: 'unknown', explanation: '' }, questions: [], flashcards: [], evidence: [] };
  if (!text) return fallback;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const p = JSON.parse(cleaned);
    return {
      headline: String(p.headline || fallback.headline), summary: String(p.summary || ''), keyPoints: stringArray(p.keyPoints), decisions: stringArray(p.decisions),
      actionItems: Array.isArray(p.actionItems) ? p.actionItems.slice(0, 50).map(a => ({ task: String(a?.task || ''), owner: String(a?.owner || ''), due: String(a?.due || ''), done: Boolean(a?.done) })).filter(a => a.task) : [],
      followUps: stringArray(p.followUps), tags: stringArray(p.tags).slice(0, 16), topics: stringArray(p.topics).slice(0, 16),
      sentiment: { label: String(p.sentiment?.label || 'unknown'), explanation: String(p.sentiment?.explanation || '') },
      questions: stringArray(p.questions),
      flashcards: Array.isArray(p.flashcards) ? p.flashcards.slice(0, 30).map(f => ({ front: String(f?.front || ''), back: String(f?.back || '') })).filter(f => f.front && f.back) : [],
      evidence: normalizeEvidence(p.evidence)
    };
  } catch { return fallback; }
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map(e => ({
    claimType: String(e?.claimType || 'other').slice(0, 30),
    claim: String(e?.claim || '').slice(0, 700),
    confidence: Math.max(0, Math.min(1, Number(e?.confidence || 0))),
    sources: Array.isArray(e?.sources) ? e.sources.slice(0, 6).map(src => ({
      segmentIndex: Number.isInteger(Number(src?.segmentIndex)) ? Number(src.segmentIndex) : null,
      startMs: src?.startMs == null ? null : (Number.isFinite(Number(src.startMs)) ? Math.max(0, Number(src.startMs)) : null),
      endMs: src?.endMs == null ? null : (Number.isFinite(Number(src.endMs)) ? Math.max(0, Number(src.endMs)) : null),
      speaker: String(src?.speaker || '').slice(0, 100),
      quote: String(src?.quote || '').slice(0, 240)
    })).filter(src => src.quote) : []
  })).filter(e => e.claim && e.sources.length);
}

async function answerMemoryQuestion(question, sessions) {
  const memory = sessions.map((s, i) => `SESSION ${i}\nid=${String(s.id || '').slice(0,120)}\ntitle=${String(s.title || '').slice(0,200)}\ndate=${String(s.createdAt || '').slice(0,40)}\nfolder=${String(s.folder || '').slice(0,100)}\ntags=${(Array.isArray(s.tags) ? s.tags : []).slice(0,20).join(', ')}\nsummary=${String(s.summary || '').slice(0,3000)}\ntopics=${(Array.isArray(s.topics) ? s.topics : []).slice(0,20).join(', ')}\ntranscript=${String(s.transcript || '').slice(0,7000)}`).join('\n\n');
  const input = `Answer the user's question using ONLY the supplied OmniVoice memory. If the answer is not supported, say so. Prefer more recent evidence when statements conflict, but explicitly mention conflicts.\n\nQuestion: ${question.slice(0,1000)}\n\nMEMORY:\n${memory}\n\nReturn ONLY valid JSON:\n{"answer":"...","sources":[{"sessionId":"...","title":"...","quote":"short supporting quote","startMs":null,"confidence":0.0}],"relatedTopics":["..."],"openCommitments":[{"task":"...","owner":"","due":"","sessionId":"..."}]}\nNever invent a source, timestamp, owner, due date, or quote.`;
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: SUMMARY_MODEL, input }) });
  const payload = await safeJson(response); if (!response.ok) throw upstreamError('OmniMemory failed', response.status, payload);
  const raw = extractResponseText(payload).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const p = JSON.parse(raw);
    return { answer: String(p.answer || ''), sources: Array.isArray(p.sources) ? p.sources.slice(0,12).map(x => ({ sessionId: String(x?.sessionId || ''), title: String(x?.title || ''), quote: String(x?.quote || '').slice(0,300), startMs: x?.startMs == null ? null : Number(x.startMs), confidence: Math.max(0,Math.min(1,Number(x?.confidence || 0))) })).filter(x => x.sessionId && x.quote) : [], relatedTopics: stringArray(p.relatedTopics).slice(0,20), openCommitments: Array.isArray(p.openCommitments) ? p.openCommitments.slice(0,20).map(a => ({ task:String(a?.task||''), owner:String(a?.owner||''), due:String(a?.due||''), sessionId:String(a?.sessionId||'') })).filter(a=>a.task) : [] };
  } catch { return { answer: raw || 'No supported answer returned.', sources: [], relatedTopics: [], openCommitments: [] }; }
}

async function compareMeetings(current, previous) {
  const compact = s => ({ id:String(s?.id||''), title:String(s?.title||'').slice(0,200), createdAt:String(s?.createdAt||''), summary:String(s?.summary||'').slice(0,6000), transcript:String(s?.transcript||'').slice(0,10000), decisions:Array.isArray(s?.decisions)?s.decisions.slice(0,30):[], actions:Array.isArray(s?.actions)?s.actions.slice(0,30):[], topics:Array.isArray(s?.topics)?s.topics.slice(0,30):[] });
  const input = `Compare two recurring meeting records. Report only supported changes. Do not infer completion unless the current record supports it.\nPREVIOUS:\n${JSON.stringify(compact(previous))}\n\nCURRENT:\n${JSON.stringify(compact(current))}\n\nReturn ONLY valid JSON:\n{"headline":"...","changes":[{"type":"decision|deadline|owner|status|risk|topic|other","before":"...","after":"...","importance":"high|medium|low"}],"unresolved":["..."],"newlyCompleted":["..."],"newRisks":["..."]}`;
  const response = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({ model:SUMMARY_MODEL, input }) });
  const payload=await safeJson(response); if(!response.ok) throw upstreamError('Meeting comparison failed',response.status,payload);
  const raw=extractResponseText(payload).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { const p=JSON.parse(raw); return { headline:String(p.headline||'What changed'), changes:Array.isArray(p.changes)?p.changes.slice(0,40).map(c=>({type:String(c?.type||'other'),before:String(c?.before||''),after:String(c?.after||''),importance:String(c?.importance||'medium')})).filter(c=>c.before||c.after):[], unresolved:stringArray(p.unresolved), newlyCompleted:stringArray(p.newlyCompleted), newRisks:stringArray(p.newRisks) }; } catch { return {headline:'What changed',changes:[],unresolved:[],newlyCompleted:[],newRisks:[],raw}; }
}

async function readShare(id) {
  try {
    const file = path.join(shareDir, `${id}.json`);
    const share = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Date.parse(share.expiresAt) <= Date.now()) { await fs.unlink(file).catch(() => {}); return null; }
    return share;
  } catch { return null; }
}

async function fireConfiguredWebhook(payload) {
  if (!process.env.OUTBOUND_WEBHOOK_URL) return;
  const response = await fetch(process.env.OUTBOUND_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.OUTBOUND_WEBHOOK_BEARER_TOKEN ? { Authorization: `Bearer ${process.env.OUTBOUND_WEBHOOK_BEARER_TOKEN}` } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Configured webhook returned ${response.status}`);
}

function stringArray(value) { return Array.isArray(value) ? value.slice(0, 60).map(v => String(v)).filter(Boolean) : []; }
function allowRequest(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > rateWindowMs) { buckets.set(ip, { start: now, count: 1 }); return true; }
  if (bucket.count >= rateMax) return false;
  bucket.count += 1; return true;
}
async function readJson(req, maxBytes) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { const e = new Error('Request is too large.'); e.statusCode = 413; throw e; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { const e = new Error('Invalid JSON.'); e.statusCode = 400; throw e; }
}
async function serveStatic(requestPath, req, res) {
  let pathname = decodeURIComponent(requestPath); if (pathname === '/') pathname = '/index.html';
  const candidate = path.normalize(path.join(publicDir, pathname));
  if (!candidate.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
  try {
    const stat = await fs.stat(candidate); if (stat.isDirectory()) return serveStatic(path.posix.join(requestPath, 'index.html'), req, res);
    const data = await fs.readFile(candidate); res.statusCode = 200; res.setHeader('Content-Type', MIME[path.extname(candidate)] || 'application/octet-stream');
    res.setHeader('Cache-Control', candidate.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300'); if (req.method === 'HEAD') return res.end(); res.end(data);
  } catch { json(res, 404, { error: 'Not found' }); }
}
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), display-capture=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}
function json(res, status, body) { if (res.headersSent) return; res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
function upstreamError(prefix, status, payload) { const message = payload?.error?.message || payload?.message || `HTTP ${status}`; const e = new Error(`${prefix}: ${message}`); e.statusCode = status >= 400 && status < 500 ? 502 : 503; return e; }
async function safeJson(response) { try { return await response.json(); } catch { return {}; } }
function sanitizeFileName(name) { const safe = String(name || 'recording.webm').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120); return safe || 'recording.webm'; }
function formatMs(ms) { const total = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }
async function loadDotEnv(file) {
  try { const content = await fs.readFile(file, 'utf8'); for (const raw of content.split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith('#')) continue; const idx = line.indexOf('='); if (idx < 1) continue; const key = line.slice(0, idx).trim(); let value = line.slice(idx + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (!(key in process.env)) process.env[key] = value; } } catch {}
}
