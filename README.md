# OmniVoice Notes

A cross-device, local-first voice recorder and AI note summarizer that runs in the browser and can be installed as a Progressive Web App (PWA).

## What it does

- Records microphone audio in supported browsers on iPhone/iPad, Android, Windows, macOS and Linux.
- Supports **microphone + shared tab/system audio** on desktop browsers that expose `getDisplayMedia()` audio.
- Shows a visible recording indicator and requires an explicit recording/consent acknowledgement before starting.
- Adds timestamped notes while a recording is in progress.
- Saves recordings and notes locally in IndexedDB.
- Lets users import existing audio files.
- Sends audio to the configured server only when **Summarize** is pressed.
- Transcribes audio, then creates a structured summary with key points, decisions, action items and follow-ups.
- Exports transcript/summary/notes as a `.txt` file.
- Works offline for recording/library access after the PWA assets have been cached. AI processing still requires network access.

## Important browser limitations

A normal website/PWA cannot guarantee unrestricted background or system-wide audio capture on every operating system.

- **iOS/iPadOS:** Safari and installed PWAs may suspend microphone capture after the app is backgrounded or the screen locks. Keep the recorder in the foreground for reliable long sessions.
- **Android:** microphone recording is broadly supported in modern browsers, but background behavior varies by browser/device power management.
- **Windows/macOS/Linux:** microphone recording works in modern browsers. Chromium-based browsers can often share tab/system audio when the user explicitly chooses a source and enables audio sharing.
- **Phone calls / other mobile apps:** browsers generally cannot record another app's call/system audio. Native mobile apps require separate OS-specific permissions and APIs.

This project intentionally does **not** auto-start, silently record, or attempt to bypass browser/OS permission indicators.

## Architecture

```text
Browser / PWA
  ├─ MediaDevices + MediaRecorder
  ├─ Web Audio API (desktop mic + shared audio mixing)
  ├─ IndexedDB (recordings, transcript, summaries, timestamped notes)
  ├─ Service Worker (offline shell)
  └─ POST /api/process only when user chooses Summarize
             │
             ▼
Node 20+ server (zero external runtime dependencies)
  ├─ size/rate limits + security headers
  ├─ audio transcription API
  └─ Responses API for structured notes/summary
```

The current server defaults to OpenAI transcription and summary models. OpenAI's current platform documentation exposes `/v1/audio/transcriptions` for transcription and `/v1/responses` for text generation. Keep the API key on the server only.

## Run locally

Requirements: **Node.js 20+**.

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY if you want transcription/summaries.

npm start
```

Open:

```text
http://localhost:3000
```

`localhost` is treated as a secure context by browsers. For testing from a phone over your LAN, microphone access normally requires the site to be served over **HTTPS** instead of plain `http://192.168.x.x`.

## Environment variables

```dotenv
OPENAI_API_KEY=
PORT=3000
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_SUMMARY_MODEL=gpt-5.6-luna
MAX_AUDIO_MB=18
```

`MAX_AUDIO_MB` is intentionally conservative because the browser sends the selected recording to this small reference server as base64 JSON before the server converts it to multipart audio for transcription. For very long recordings, production deployments should implement chunked/multipart uploads or direct-to-object-storage uploads with short-lived signed URLs.

## Install on devices

### iPhone / iPad

1. Open the HTTPS site in Safari.
2. Tap **Share**.
3. Choose **Add to Home Screen**.
4. Open the installed app and allow microphone access when prompted.

### Android

1. Open the HTTPS site in Chrome/Edge.
2. Use **Install app** / **Add to Home screen** when offered.
3. Allow microphone access.

### Windows / macOS / Linux

Open the HTTPS site in Chrome/Edge (or another PWA-capable browser) and use the browser's **Install app** action. Regular browser use also works without installation.

## Deploy with Docker

```bash
docker build -t omnivoice-notes .
docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY='your-key' \
  omnivoice-notes
```

Put the container behind an HTTPS reverse proxy or a hosting platform that provides TLS.

## Data model

Each local session contains:

```json
{
  "id": "uuid",
  "title": "Meeting name",
  "createdAt": "ISO timestamp",
  "durationMs": 123456,
  "mimeType": "audio/webm",
  "blob": "IndexedDB Blob",
  "notes": [{ "timeMs": 42000, "text": "Important decision" }],
  "transcript": "...",
  "summary": {
    "headline": "...",
    "summary": "...",
    "keyPoints": [],
    "decisions": [],
    "actionItems": [{ "task": "...", "owner": "", "due": "" }],
    "followUps": [],
    "tags": []
  }
}
```

## Privacy and security defaults

- Audio is local until the user explicitly presses **Summarize**.
- The API key never appears in browser JavaScript.
- A visible red recording badge remains on-screen during capture.
- Recording requires the browser's microphone permission plus the in-app acknowledgement.
- The server sends restrictive CSP, Permissions Policy, no-sniff, no-referrer and anti-framing headers.
- `/api/process` has a per-IP basic in-memory rate limit and maximum request/audio size.
- No recordings are committed to Git or stored on the server by this reference implementation.

For an organizational deployment, add authenticated user accounts, encrypted object storage, retention policies, audit logs, tenant isolation, malware/content checks on uploaded files, and a documented consent/records policy.

## Development checks

```bash
npm run check
```

No package installation is required for the current codebase.

## Roadmap

- Chunked uploads for multi-hour recordings.
- Optional S3/Azure Blob/Google Cloud Storage sync with client-controlled retention.
- User authentication and cross-device encrypted sync.
- Speaker diarization when the selected transcription provider supports it.
- Search across transcripts and summaries.
- Calendar-linked meeting titles.
- Webhook/export integrations (email, Slack, Teams, Markdown, PDF).
- Optional native iOS/Android wrappers for stronger background recording behavior where platform policy allows it.
- End-to-end encryption mode where transcription runs locally/on a user-controlled worker.

## Legal / consent

Recording laws and workplace/school policies differ by jurisdiction and context. Users are responsible for obtaining any required consent and complying with applicable privacy, employment, education and records-retention rules.

## License

MIT — see [LICENSE](LICENSE).
