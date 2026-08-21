const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const els = {
  title: $('#titleInput'), template: $('#meetingTemplate'), folder: $('#folderInput'), mode: $('#captureMode'), systemOption: $('#systemOption'),
  language: $('#languageSelect'), quality: $('#qualitySelect'), live: $('#liveTranscription'), noise: $('#noiseSuppression'), gain: $('#autoGain'),
  voiceCommands: $('#voiceCommands'), vocabulary: $('#customVocabulary'), consent: $('#consentInput'), timer: $('#timer'), status: $('#recorderStatus'),
  badge: $('#recordingBadge'), start: $('#startBtn'), pause: $('#pauseBtn'), stop: $('#stopBtn'), bookmark: $('#bookmarkBtn'), note: $('#noteInput'), addNote: $('#addNoteBtn'),
  activeNotes: $('#activeNotes'), liveTranscript: $('#liveTranscript'), liveStatus: $('#liveStatus'), waveform: $('#waveform'), sessions: $('#sessions'),
  refresh: $('#refreshBtn'), persist: $('#persistBtn'), persistStatus: $('#persistStatus'), platform: $('#platformPill'), iosWarning: $('#iosWarning'),
  systemWarning: $('#systemWarning'), fileInput: $('#fileInput'), sessionTemplate: $('#sessionTemplate'), search: $('#searchInput'), sort: $('#sortSelect'),
  folderList: $('#folderList'), tagList: $('#tagList'), folderOptions: $('#folderOptions'), countAll: $('#countAll'), countFavorites: $('#countFavorites'),
  newFolder: $('#newFolderBtn'), theme: $('#themeBtn'), memoryBtn: $('#memoryBtn'), actionsBtn: $('#actionsBtn'), analytics: $('#analyticsBtn'), analyticsDialog: $('#analyticsDialog'), analyticsContent: $('#analyticsContent'),
  memoryDialog: $('#memoryDialog'), memoryQuestion: $('#memoryQuestion'), memoryRun: $('#memoryRunBtn'), memoryStatus: $('#memoryStatus'), memoryResults: $('#memoryResults'), actionsDialog: $('#actionsDialog'), actionsContent: $('#actionsContent'),
  shareDialog: $('#shareDialog'), shareLink: $('#shareLink'), copyShare: $('#copyShareBtn'), trimDialog: $('#trimDialog'), trimSessionId: $('#trimSessionId'),
  trimStart: $('#trimStart'), trimEnd: $('#trimEnd'), trimNormalize: $('#trimNormalize'), trimSave: $('#trimSaveBtn'), trimStatus: $('#trimStatus'),
  sharedDialog: $('#sharedImportDialog'), sharedContent: $('#sharedImportContent'), importShared: $('#importSharedBtn')
};

const DB_NAME = 'omnivoice-notes';
const DB_VERSION = 2;
const STORE = 'sessions';
const LIVE_CHUNK_SECONDS = 4;
let dbPromise;
let recorder = null;
let chunks = [];
let sessionStart = 0;
let pausedAt = 0;
let accumulatedPause = 0;
let timerHandle = null;
let activeNotes = [];
let liveSegments = [];
let captureStreams = [];
let mixContext = null;
let analysisContext = null;
let analyser = null;
let animationFrame = null;
let pcmNode = null;
let pcmBuffers = [];
let pcmSamples = 0;
let liveInFlight = false;
let liveCursorMs = 0;
let wakeLock = null;
let currentMimeType = '';
let objectUrls = [];
let activeLibraryFilter = { type: 'all', value: '' };
let sharedPending = null;
let lastVoiceCommandText = '';


async function init() {
  applySavedTheme();
  detectPlatform();
  await openDb();
  await renderSessions();
  restoreDraft();
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker?.addEventListener('message', event => { if (event.data?.type === 'BACKGROUND_SYNC') renderSessions(); });
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus('This browser cannot record audio directly. You can still import audio files.');
    els.start.disabled = true;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    els.systemOption.disabled = true;
    els.systemOption.textContent = 'Microphone + tab/system audio (not supported here)';
  }
  bindIntelligenceEvents();
  await maybeOpenSharedLink();
}

function bindEvents() {
  els.start.addEventListener('click', startRecording);
  els.pause.addEventListener('click', togglePause);
  els.stop.addEventListener('click', stopRecording);
  els.bookmark.addEventListener('click', () => addTimestampedNote('Bookmark', 'bookmark'));
  els.addNote.addEventListener('click', () => addTimestampedNote());
  els.note.addEventListener('keydown', e => { if (e.key === 'Enter') addTimestampedNote(); });
  els.refresh.addEventListener('click', renderSessions);
  els.persist.addEventListener('click', requestPersistentStorage);
  els.fileInput.addEventListener('change', importAudio);
  els.search.addEventListener('input', renderSessions);
  els.sort.addEventListener('change', renderSessions);
  els.newFolder.addEventListener('click', createFolderPrompt);
  els.theme.addEventListener('click', toggleTheme);
  els.analytics.addEventListener('click', showAnalytics);
  els.copyShare.addEventListener('click', () => navigator.clipboard?.writeText(els.shareLink.value));
  els.trimSave.addEventListener('click', saveTrimmedCopy);
  els.importShared.addEventListener('click', importSharedNote);
  [els.title, els.folder, els.template, els.language, els.vocabulary].forEach(el => el.addEventListener('input', saveDraft));
  document.addEventListener('keydown', keyboardShortcuts);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recorder?.state === 'recording' && isIOS()) setStatus('Warning: iOS may suspend recording while backgrounded.');
  });
  window.addEventListener('beforeunload', e => { if (recorder && recorder.state !== 'inactive') { e.preventDefault(); e.returnValue = ''; } });
  $$('.nav-item[data-filter]').forEach(btn => btn.addEventListener('click', () => setLibraryFilter(btn.dataset.filter, '')));
}
