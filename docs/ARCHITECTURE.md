# Architecture and production path

## 1. Capture layer

The browser explicitly requests audio permission with `navigator.mediaDevices.getUserMedia()` and records with `MediaRecorder`.

For desktop shared audio, the user chooses **Microphone + tab/system audio**. The app calls `getDisplayMedia()` and, when an audio track is actually supplied, mixes microphone and shared audio using `AudioContext.createMediaStreamDestination()`.

The selected browser/OS decides what can be captured. The app does not bypass those limits.

## 2. Local session storage

Recordings are represented as `Blob` objects and stored in IndexedDB together with metadata, timestamped notes, transcript and summary. This keeps the default flow local-first and enables playback without uploading the recording.

For stronger production durability, use File System Access API where supported or authenticated encrypted object storage, but retain IndexedDB as the offline cache.

## 3. AI processing path

The user presses **Summarize**. The browser loads the selected local Blob, verifies it is below the server-advertised processing limit, converts it to base64 and POSTs it to `/api/process`.

The Node server:

1. Enforces request size and basic per-IP rate limits.
2. Reconstructs the audio bytes.
3. Sends them as multipart form data to the configured transcription model.
4. Sends the transcript plus the user's timestamped notes to the configured text model.
5. Returns structured JSON.
6. Does not write the audio to disk.

## 4. Multi-hour production upgrade

The reference base64 transport is intentionally simple. For multi-hour meetings:

1. Record in 30-60 second chunks using `MediaRecorder.start(timeslice)`.
2. Persist each chunk locally immediately.
3. Upload chunks with resumable multipart upload to encrypted object storage.
4. Create a processing job referencing the object rather than embedding base64 in JSON.
5. Concatenate/normalize audio server-side or transcribe chunks sequentially.
6. Merge transcripts with timestamp offsets.
7. Run hierarchical summaries for large transcripts.

## 5. Cross-device sync

Add an authenticated API and a server-side session record containing only metadata and encrypted object references. Recommended controls:

- OIDC/OAuth login.
- Per-user/tenant authorization on every object.
- Signed short-lived upload/download URLs.
- TLS everywhere.
- Server-side encryption plus optional per-user client-side encryption.
- Configurable retention and delete-now workflow.
- Audit events for upload, transcription, export and deletion.

## 6. Always-on/background recording

A PWA is not a universal always-on recorder. iOS in particular can suspend pages/PWAs in the background. If a legitimate use case requires longer background capture, build native apps with explicit platform permissions and visible OS recording indicators. Do not attempt to conceal capture or bypass platform privacy controls.
