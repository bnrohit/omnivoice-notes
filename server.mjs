import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
await loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const MAX_AUDIO_MB = Math.max(1, Number(process.env.MAX_AUDIO_MB || 18));
const MAX_JSON_BYTES = Math.ceil(MAX_AUDIO_MB * 1024 * 1024 * 1.45) + 1024 * 1024;
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || 'gpt-5.6-luna';
const rateWindowMs = 60_000;
const rateMax = 12;
const buckets = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
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
        summaryModel: SUMMARY_MODEL,
        maxAudioMb: MAX_AUDIO_MB
      });
    }

    if (url.pathname === '/api/process' && req.method === 'POST') {
      if (!allowRequest(req)) return json(res, 429, { error: 'Too many processing requests. Try again in a minute.' });
      if (!process.env.OPENAI_API_KEY) {
        return json(res, 503, { error: 'AI processing is not configured. Set OPENAI_API_KEY on the server.' });
      }

      const body = await readJson(req, MAX_JSON_BYTES);
      const { audioBase64, mimeType = 'audio/webm', fileName = 'recording.webm', title = 'Voice note', notes = [] } = body || {};
      if (!audioBase64 || typeof audioBase64 !== 'string') return json(res, 400, { error: 'Missing audio data.' });

      const audioBuffer = Buffer.from(audioBase64, 'base64');
      if (!audioBuffer.length) return json(res, 400, { error: 'Audio is empty.' });
      if (audioBuffer.length > MAX_AUDIO_MB * 1024 * 1024) {
        return json(res, 413, { error: `Audio exceeds the ${MAX_AUDIO_MB} MB processing limit.` });
      }

      const transcript = await transcribeAudio(audioBuffer, mimeType, sanitizeFileName(fileName));
      const summary = await summarizeTranscript({ title, transcript, notes });
      return json(res, 200, { transcript, summary });
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
  console.log(`OmniVoice Notes running on http://localhost:${PORT}`);
  console.log(process.env.OPENAI_API_KEY ? 'AI processing: configured' : 'AI processing: disabled until OPENAI_API_KEY is set');
});

async function transcribeAudio(buffer, mimeType, fileName) {
  const form = new FormData();
  form.append('model', TRANSCRIBE_MODEL);
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  const payload = await safeJson(response);
  if (!response.ok) throw upstreamError('Transcription failed', response.status, payload);
  const text = payload?.text?.trim();
  if (!text) throw new Error('Transcription returned no text.');
  return text;
}

async function summarizeTranscript({ title, transcript, notes }) {
  const noteLines = Array.isArray(notes)
    ? notes.slice(0, 200).map(n => `[${formatMs(Number(n.timeMs || 0))}] ${String(n.text || '').slice(0, 500)}`).join('\n')
    : '';

  const input = `Create a useful meeting/voice-note summary from the transcript below.\n\nTitle: ${String(title).slice(0, 200)}\n\nTimestamped user notes:\n${noteLines || '(none)'}\n\nTranscript:\n${transcript}\n\nReturn ONLY valid JSON with this exact shape:\n{\n  "headline": "one-line summary",\n  "summary": "concise paragraph",\n  "keyPoints": ["..."],\n  "decisions": ["..."],\n  "actionItems": [{"task":"...","owner":"","due":""}],\n  "followUps": ["..."],\n  "tags": ["..."]\n}\nUse empty arrays when a category is not present. Do not invent owners, dates, decisions, or facts.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: SUMMARY_MODEL, input })
  });
  const payload = await safeJson(response);
  if (!response.ok) throw upstreamError('Summary generation failed', response.status, payload);
  const outputText = extractResponseText(payload);
  return parseSummary(outputText);
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function parseSummary(text) {
  const fallback = {
    headline: 'Summary generated',
    summary: text || 'No summary text returned.',
    keyPoints: [], decisions: [], actionItems: [], followUps: [], tags: []
  };
  if (!text) return fallback;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return {
      headline: String(parsed.headline || 'Summary generated'),
      summary: String(parsed.summary || ''),
      keyPoints: stringArray(parsed.keyPoints),
      decisions: stringArray(parsed.decisions),
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.slice(0, 50).map(a => ({
        task: String(a?.task || ''), owner: String(a?.owner || ''), due: String(a?.due || '')
      })).filter(a => a.task) : [],
      followUps: stringArray(parsed.followUps),
      tags: stringArray(parsed.tags).slice(0, 12)
    };
  } catch {
    return fallback;
  }
}

function stringArray(value) {
  return Array.isArray(value) ? value.slice(0, 50).map(v => String(v)).filter(Boolean) : [];
}

function allowRequest(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > rateWindowMs) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  if (bucket.count >= rateMax) return false;
  bucket.count += 1;
  return true;
}

async function readJson(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('Request is too large.');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch {
    const err = new Error('Invalid JSON.');
    err.statusCode = 400;
    throw err;
  }
}

async function serveStatic(requestPath, req, res) {
  let pathname = decodeURIComponent(requestPath);
  if (pathname === '/') pathname = '/index.html';
  const candidate = path.normalize(path.join(publicDir, pathname));
  if (!candidate.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return serveStatic(path.posix.join(requestPath, 'index.html'), req, res);
    const data = await fs.readFile(candidate);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(candidate)] || 'application/octet-stream');
    res.setHeader('Cache-Control', candidate.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300');
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), display-capture=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function json(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function upstreamError(prefix, status, payload) {
  const message = payload?.error?.message || payload?.message || `HTTP ${status}`;
  const err = new Error(`${prefix}: ${message}`);
  err.statusCode = status >= 400 && status < 500 ? 502 : 503;
  return err;
}

async function safeJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function sanitizeFileName(name) {
  const safe = String(name || 'recording.webm').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  return safe || 'recording.webm';
}

function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function loadDotEnv(file) {
  try {
    const content = await fs.readFile(file, 'utf8');
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}
