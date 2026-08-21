# OmniVoice Notes v2.1 beta

OmniVoice Notes is a **local-first, cross-device voice notebook** for modern browsers. It records only after explicit user action and microphone permission, stores recordings in IndexedDB by default, supports near-real-time transcription, and can optionally send chosen audio/transcripts to a server-side AI pipeline for transcription and structured analysis.

> Recording laws and workplace rules vary. OmniVoice never auto-starts or hides recording. The person using it is responsible for obtaining required consent.

## v2.1 intelligence layer

- **TruthTrace:** AI claims carry confidence plus short evidence citations. When real timestamped live/diarized segments exist, clicking a source jumps audio playback to that moment. Untimed transcripts are cited textually and are never given fake timestamps.
- **OmniMemory:** cross-meeting Q&A. The browser first ranks likely relevant sessions locally; only the top candidate text snippets are sent when the user explicitly asks a question. Answers cite source sessions.
- **Action Center:** aggregates AI action items across meetings, preserves completion state, creates ICS calendar items, opens an email draft, and supports one-click copy.
- **What changed?:** recurring-meeting comparison finds an earlier matching session by normalized title, then folder/template fallback, and records supported decision/deadline/owner/status/risk/topic changes.
- **Semantic-like retrieval:** local query expansion and weighted ranking reduce how much library text must leave the device before the optional AI reasoning step.

## What works in v2 beta

### Capture and audio
- Microphone recording on modern iOS/iPadOS, Android, Windows, macOS and Linux browsers that expose `MediaRecorder`.
- Desktop mic + tab/system audio when `getDisplayMedia()` returns a shared audio track.
- Browser noise suppression, echo cancellation and automatic gain control controls.
- Mixed-stream dynamics compression for mic + system capture.
- Live waveform visualization.
- Selectable recording bitrate.
- Client-side trimming to a new WAV copy with optional peak normalization.
- Playback speed control.
- Bookmarks while recording.

### Live transcription and AI
- Near-real-time transcription using an `AudioWorklet` PCM capture path and short WAV chunks sent to `/api/live/transcribe`. The compatibility default is `gpt-4o-mini-transcribe`; operators can change the model after validating their preferred transcription endpoint.
- Final/post-recording transcription when a live transcript is not available.
- Multi-language hint selection.
- Custom vocabulary/spelling hints.
- Structured AI analysis: summary, key points, decisions, action items, follow-ups, tags, topics, evidence-based sentiment label, questions, and flashcard candidates.
- Meeting modes: general, standup, 1:1, interview, lecture, podcast, retrospective, journal, and dictation.
- Voice-command markers detected from live transcript phrases such as “mark this as important”, “action item”, “bookmark this”, and “follow up”.

### Organization and editing
- Folders, tags and favorites.
- Search across titles, transcripts, notes, folders, tags, topics and summaries.
- Newest/oldest/longest/title sorting.
- Transcript editing with local save.
- Timestamped notes and bookmark list.
- Duplicate-audio detection based on a local SHA-256 fingerprint sample.
- Auto-saved recording draft metadata.
- Local analytics for session count, recording time, transcript words and folder distribution.
- Light/dark/system theme.
- Keyboard shortcuts (`Ctrl/Cmd+K` search, `R` record/stop when not typing, `B` bookmark).

### Export and sharing
- Markdown, JSON, TXT and SRT exports.
- ICS calendar export for AI action items with parseable due dates.
- End-to-end encrypted **transcript/note/summary sharing**: encryption happens in the browser with AES-GCM; the server stores only ciphertext and an IV. The encryption key stays in the URL fragment and is not sent to the server.
- Optional fixed outbound webhook configured by the server operator.

### PWA / offline
- Offline-first app-shell cache.
- IndexedDB local library.
- Background Sync hook where the browser supports it.
- Service-worker notification capability for future reminder delivery.

## Important platform limits

- iOS/iPadOS may suspend browser/PWA microphone capture after backgrounding or screen lock. Keep the app foregrounded for reliable long recordings.
- A browser cannot universally capture phone calls or arbitrary audio from other apps. Desktop shared audio is controlled by the browser/OS capture picker.
- “Live transcription” in this beta uses short PCM/WAV chunks, not a permanent hidden connection. It is designed for compatibility and graceful fallback.

## Provider-dependent capability

Automatic **speaker diarization** is intentionally provider-pluggable. Set `DIARIZATION_ENDPOINT` to a service you trust that accepts the documented JSON and returns timestamped speaker segments. Without it, OmniVoice does not pretend to know who spoke.

## Not falsely marked as finished

The following are architectural roadmap items rather than fake checkboxes in this beta: true multi-user live co-editing, native iOS/Android background capture, SAML/SSO, billing, team admin/audit policy console, full cloud audio sync, native Electron/Tauri/React-Native apps, browser/VS Code extensions, phone/SIP capture, remote push scheduling, DOCX/PDF binary generation, WebRTC meeting ingestion, and third-party OAuth integrations such as Notion/Slack/Google Calendar.

## Run locally

Requirements: Node.js 20+.

```bash
cp .env.example .env
# add OPENAI_API_KEY to .env for AI features
npm run check
npm start
```

Open `http://localhost:3000`.

For microphone access from another device, deploy over **HTTPS**; browsers normally require a secure context for microphone APIs outside localhost.

## Environment variables

See `.env.example`. Primary settings:

- `OPENAI_API_KEY`
- `OPENAI_TRANSCRIBE_MODEL`
- `OPENAI_LIVE_TRANSCRIBE_MODEL`
- `OPENAI_SUMMARY_MODEL`
- `MAX_AUDIO_MB`
- `DIARIZATION_ENDPOINT` / `DIARIZATION_BEARER_TOKEN`
- `OUTBOUND_WEBHOOK_URL` / `OUTBOUND_WEBHOOK_BEARER_TOKEN`
- `SHARE_TTL_HOURS`
- `MAX_SHARE_KB`

## Privacy model

1. Recordings are local IndexedDB blobs by default.
2. Live transcription sends only short PCM/WAV chunks when enabled.
3. Final AI processing is explicit and sends audio only when a transcript is unavailable; otherwise the transcript can be analyzed directly.
4. Server secrets remain server-side.
5. Encrypted share payloads exclude audio in v2.1 beta and are opaque ciphertext to the share server.
6. No arbitrary user-supplied webhook target is accepted, avoiding an SSRF-style integration endpoint.

## License

MIT. See `LICENSE`.
