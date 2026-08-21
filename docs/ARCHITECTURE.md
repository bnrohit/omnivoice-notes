# OmniVoice Notes v2 architecture

## Capture plane

The user explicitly starts capture. `getUserMedia()` supplies microphone audio. Desktop users may also choose a tab/window/screen with `getDisplayMedia()`; OmniVoice uses shared audio only when the browser actually returns an audio track.

`MediaRecorder` creates the durable local recording. For mic + system capture, Web Audio mixes both sources through a dynamics compressor into a `MediaStreamDestination`.

## Live transcription plane

A second Web Audio path attaches an `AudioWorklet` to the recording stream. It collects mono PCM without routing audible output to speakers. Roughly four seconds of PCM is encoded as WAV in the browser and POSTed to `/api/live/transcribe`.

This design gives near-real-time transcription without placing an API key in browser code. It also degrades cleanly on browsers without `AudioWorklet`. A future WebRTC transport can replace this chunk uploader without changing session storage.

## Local data model

IndexedDB `sessions` records contain:

- metadata: id, title, createdAt, duration, template, language
- organization: folder, tags, favorite
- audio: Blob + MIME type + local fingerprint
- notes/bookmarks with timestamps
- transcript and timestamped live/provider segments
- AI analysis

The default flow requires no account and no cloud database.

## AI processing

`/api/process` accepts either audio or an existing transcript. If no transcript exists, the server transcribes the audio first. It then requests structured analysis and returns summary fields that the browser stores locally.

`/api/live/transcribe` is rate-limited separately by the same in-memory per-IP bucket and limits chunk body size.

## Speaker diarization

OmniVoice does not infer speaker identity from text. `/api/diarize` is a provider adapter controlled through `DIARIZATION_ENDPOINT`. The expected response is timestamped segments with speaker labels. This keeps diarization explicit and replaceable.

## Encrypted sharing

The browser generates a random 256-bit AES-GCM key and IV, encrypts transcript/notes/summary metadata, and uploads only ciphertext. The server stores the opaque payload with an expiry time. The key is encoded in the URL fragment (`#key=...`), which browsers do not include in HTTP requests.

Audio is excluded from v2 encrypted share payloads to keep the reference server small and reduce accidental large-data retention.

## Offline-first PWA

The service worker caches the app shell, returns cached content immediately when available, and refreshes it from the network. IndexedDB contains user data. A Background Sync hook notifies open clients where supported; it does not promise unsupported background execution on iOS.

## Export plane

Client-side exporters create Markdown, JSON, TXT, SRT, and ICS. Audio trim uses browser decoding and produces normalized mono WAV output.

## Production evolution

For authenticated cloud/team deployment, add a separate service layer rather than weakening the local-first core:

- OIDC/passkeys and tenant authorization
- encrypted object storage with short-lived signed URLs
- PostgreSQL metadata, audit events and retention jobs
- queue-backed long transcription/diarization jobs
- WebSocket/WebRTC transport for true continuous live transcription
- collaboration CRDT/OT layer
- calendar/Slack/Notion OAuth workers
- VAPID push service
- KMS/HSM-backed tenant keys and optional customer-managed encryption
- policy engine for retention, legal hold and export/delete workflows

## Platform boundary

A PWA is not a universal hidden background recorder. Native apps are required for legitimate platform-approved long-running background capture scenarios, and they still need visible recording indicators and OS permissions.
