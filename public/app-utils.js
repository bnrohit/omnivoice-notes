function renderLibraryNavigation(sessions) {
  els.countAll.textContent = sessions.length; els.countFavorites.textContent = sessions.filter(s => s.favorite).length;
  const folders = [...new Set(sessions.map(s => s.folder || 'Inbox'))].sort(); els.folderList.replaceChildren(...folders.map(folder => navButton(folder, sessions.filter(s => (s.folder || 'Inbox') === folder).length, () => setLibraryFilter('folder', folder))));
  els.folderOptions.innerHTML = folders.map(f => `<option value="${escapeHtml(f)}"></option>`).join('');
  const tags = [...new Set(sessions.flatMap(s => [...(s.tags || []), ...(s.summary?.tags || [])]))].slice(0, 40); els.tagList.replaceChildren(...tags.map(tag => { const b = document.createElement('button'); b.className = 'tag-filter'; b.textContent = tag; b.onclick = () => setLibraryFilter('tag', tag); return b; }));
}
function navButton(label, count, handler) { const b = document.createElement('button'); b.className = 'nav-item'; b.innerHTML = `<span>${escapeHtml(label)}</span><span>${count}</span>`; b.onclick = handler; return b; }
function setLibraryFilter(type, value) { activeLibraryFilter = { type, value }; $$('.nav-item[data-filter]').forEach(b => b.classList.toggle('active', type === b.dataset.filter)); renderSessions(); }
function filterSessions(sessions) {
  const q = els.search.value.trim().toLowerCase(); const today = new Date().toDateString();
  return sessions.filter(s => {
    if (activeLibraryFilter.type === 'favorites' && !s.favorite) return false; if (activeLibraryFilter.type === 'today' && new Date(s.createdAt).toDateString() !== today) return false;
    if (activeLibraryFilter.type === 'folder' && (s.folder || 'Inbox') !== activeLibraryFilter.value) return false;
    if (activeLibraryFilter.type === 'tag' && ![...(s.tags || []), ...(s.summary?.tags || [])].includes(activeLibraryFilter.value)) return false;
    if (!q) return true; const hay = [s.title, s.transcript, s.folder, ...(s.tags || []), ...(s.summary?.tags || []), ...(s.notes || []).map(n => n.text), s.summary?.summary, ...(s.summary?.topics || [])].filter(Boolean).join(' ').toLowerCase(); return q.split(/\s+/).every(term => hay.includes(term));
  });
}
function sortSessions(sessions, sort) { return [...sessions].sort((a,b) => sort === 'oldest' ? Date.parse(a.createdAt)-Date.parse(b.createdAt) : sort === 'longest' ? (b.durationMs||0)-(a.durationMs||0) : sort === 'title' ? String(a.title).localeCompare(String(b.title)) : Date.parse(b.createdAt)-Date.parse(a.createdAt)); }
async function createFolderPrompt() { const name = prompt('New folder name'); if (!name?.trim()) return; els.folder.value = name.trim(); saveDraft(); }

async function showAnalytics() {
  const sessions = await listSessions(); const totalMs = sessions.reduce((n,s)=>n+(s.durationMs||0),0); const words = sessions.reduce((n,s)=>n+String(s.transcript||'').trim().split(/\s+/).filter(Boolean).length,0); const processed = sessions.filter(s=>s.summary).length;
  const folderCounts = Object.entries(sessions.reduce((o,s)=>{const k=s.folder||'Inbox';o[k]=(o[k]||0)+1;return o;},{})).sort((a,b)=>b[1]-a[1]).slice(0,8); const max = Math.max(1,...folderCounts.map(x=>x[1]));
  els.analyticsContent.innerHTML = `<div class="metric-grid"><div class="metric"><span class="muted tiny">Sessions</span><strong>${sessions.length}</strong></div><div class="metric"><span class="muted tiny">Recording time</span><strong>${formatDurationLong(totalMs)}</strong></div><div class="metric"><span class="muted tiny">Transcript words</span><strong>${words.toLocaleString()}</strong></div><div class="metric"><span class="muted tiny">AI analyzed</span><strong>${processed}</strong></div></div><h3>Folders</h3>${folderCounts.map(([name,count])=>`<div><div class="tiny">${escapeHtml(name)} — ${count}</div><div class="bar"><span style="width:${Math.round(count/max*100)}%"></span></div></div>`).join('') || '<p class="muted">No data yet.</p>'}<p class="muted small">Analytics are computed locally from this browser library.</p>`;
  els.analyticsDialog.showModal();
}

function keyboardShortcuts(e) {
  const tag = document.activeElement?.tagName; const typing = ['INPUT','TEXTAREA','SELECT'].includes(tag);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); els.search.focus(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && recorder?.state && recorder.state !== 'inactive') { e.preventDefault(); addTimestampedNote('Manual save marker', 'bookmark'); return; }
  if (!typing && e.key.toLowerCase() === 'r') { e.preventDefault(); recorder && recorder.state !== 'inactive' ? stopRecording() : startRecording(); }
  if (!typing && e.key.toLowerCase() === 'b' && recorder?.state === 'recording') { e.preventDefault(); addTimestampedNote('Keyboard bookmark', 'bookmark'); }
}

function saveDraft() { localStorage.setItem('omnivoice-draft', JSON.stringify({ title: els.title.value, folder: els.folder.value, template: els.template.value, language: els.language.value, vocabulary: els.vocabulary.value })); }
function restoreDraft() { try { const d = JSON.parse(localStorage.getItem('omnivoice-draft') || '{}'); if (d.title) els.title.value=d.title; if(d.folder) els.folder.value=d.folder; if(d.template) els.template.value=d.template; if(d.language) els.language.value=d.language; if(d.vocabulary) els.vocabulary.value=d.vocabulary; } catch {} }
function applySavedTheme(){document.documentElement.dataset.theme=localStorage.getItem('omnivoice-theme')||'system'}
function toggleTheme(){const current=document.documentElement.dataset.theme;const next=current==='system'?'dark':current==='dark'?'light':'system';document.documentElement.dataset.theme=next;localStorage.setItem('omnivoice-theme',next)}

async function deleteSessionWithConfirm(id) { const s=await getSession(id); if(!s||!confirm(`Delete “${s.title}” from this browser? This cannot be undone.`))return; await deleteSession(id); await renderSessions(); }
async function requestPersistentStorage() { if(!navigator.storage?.persist){els.persistStatus.textContent='Persistent storage API is not available.';return;} const granted=await navigator.storage.persist(); els.persistStatus.textContent=granted?'Browser granted persistent storage.':'Browser did not grant persistent storage.'; }
async function requestWakeLock(){try{if('wakeLock'in navigator)wakeLock=await navigator.wakeLock.request('screen')}catch{}}
function detectPlatform(){const ua=navigator.userAgent;const label=/iPhone|iPad|iPod/.test(ua)?'iOS/iPadOS':/Android/.test(ua)?'Android':/Windows/.test(ua)?'Windows':/Mac/.test(ua)?'macOS':'Browser';els.platform.textContent=label;els.iosWarning.classList.toggle('hidden',!isIOS())}
function isIOS(){return /iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)}
function setStatus(text){els.status.textContent=text}

function summaryHtml(s){
  const list=(title,arr)=>arr?.length?`<h4>${escapeHtml(title)}</h4><ul>${arr.map(x=>`<li class="${typeof x==='object'&&x.done?'action-done':''}">${escapeHtml(typeof x==='string'?x:x.task||'')}</li>`).join('')}</ul>`:'';
  const evidence=s.evidence?.length?`<div class="truthtrace"><div class="truthtrace-head"><strong>TruthTrace</strong><span class="pill secondary">Auditable AI</span></div>${s.evidence.slice(0,20).map(e=>`<div class="truth-claim"><div><span class="truth-type">${escapeHtml(e.claimType||'evidence')}</span><strong>${escapeHtml(e.claim)}</strong><span class="truth-confidence">${Math.round((e.confidence||0)*100)}%</span></div><div class="truth-sources">${(e.sources||[]).map(src=>src.startMs==null?`<span class="truth-source text-only" title="No reliable timestamp available">${escapeHtml(src.speaker||'Evidence')}: “${escapeHtml(src.quote)}”</span>`:`<button type="button" class="truth-source" data-time-ms="${Number(src.startMs)}">▶ ${formatDuration(src.startMs)}${src.speaker?` • ${escapeHtml(src.speaker)}`:''}: “${escapeHtml(src.quote)}”</button>`).join('')}</div></div>`).join('')}</div>`:'';
  return `<h3>${escapeHtml(s.headline||'Analysis')}</h3><p>${escapeHtml(s.summary||'')}</p>${list('Key points',s.keyPoints)}${list('Decisions',s.decisions)}${list('Action items',s.actionItems)}${list('Follow-ups',s.followUps)}${list('Topics',s.topics)}${s.sentiment?.label?`<h4>Sentiment</h4><p>${escapeHtml(s.sentiment.label)}${s.sentiment.explanation?` — ${escapeHtml(s.sentiment.explanation)}`:''}</p>`:''}${list('Questions',s.questions)}${s.flashcards?.length?`<h4>Flashcards</h4><ul>${s.flashcards.slice(0,10).map(f=>`<li><strong>${escapeHtml(f.front)}</strong> — ${escapeHtml(f.back)}</li>`).join('')}</ul>`:''}${evidence}`
}
function sessionText(s){return `${s.title}\nRecorded: ${new Date(s.createdAt).toLocaleString()}\nFolder: ${s.folder||'Inbox'}\nTags: ${(s.tags||[]).join(', ')}\n\nNOTES\n${(s.notes||[]).map(n=>`[${formatDuration(n.timeMs)}] ${n.text}`).join('\n')||'(none)'}\n\nTRANSCRIPT\n${s.transcript||'(none)'}\n\nSUMMARY\n${s.summary?.summary||'(none)'}`}
function sessionMarkdown(s){return `# ${s.title}\n\n- Recorded: ${new Date(s.createdAt).toLocaleString()}\n- Folder: ${s.folder||'Inbox'}\n- Tags: ${(s.tags||[]).join(', ')}\n- Template: ${s.template||'general'}\n\n## Notes\n${(s.notes||[]).map(n=>`- **${formatDuration(n.timeMs)}** ${n.kind&&n.kind!=='note'?`_${n.kind}_ `:''}${n.text}`).join('\n')||'_None_'}\n\n## Transcript\n\n${s.transcript||'_None_'}\n\n## AI summary\n\n${s.summary?.summary||'_None_'}\n${s.summary?.keyPoints?.length?`\n### Key points\n${s.summary.keyPoints.map(x=>`- ${x}`).join('\n')}`:''}\n${s.summary?.actionItems?.length?`\n### Action items\n${s.summary.actionItems.map(a=>`- [ ] ${a.task}${a.owner?` — ${a.owner}`:''}${a.due?` — ${a.due}`:''}`).join('\n')}`:''}\n`}
function segmentsToSrt(s){const segs=s.segments?.length?s.segments:sentenceSegments(s.transcript||'',s.durationMs||0);return segs.map((seg,i)=>`${i+1}\n${srtTime(seg.startMs||0)} --> ${srtTime(seg.endMs||((seg.startMs||0)+4000))}\n${seg.speaker?`${seg.speaker}: `:''}${seg.text||''}\n`).join('\n')}
function sentenceSegments(text,durationMs){const parts=text.split(/(?<=[.!?])\s+/).filter(Boolean);const step=parts.length?Math.max(2000,durationMs/parts.length):4000;return parts.map((p,i)=>({startMs:i*step,endMs:(i+1)*step,text:p}))}
function stripBlob(s){const {blob,...rest}=s;return rest}
function makeAudioFileName(s){const ext=(s.mimeType||'').includes('mp4')?'m4a':(s.mimeType||'').includes('ogg')?'ogg':(s.mimeType||'').includes('wav')?'wav':'webm';return `${safeName(s.title)}.${ext}`}
function inferMime(name){const ext=name.toLowerCase().split('.').pop();return({mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',webm:'audio/webm'})[ext]||'application/octet-stream'}
function formatDuration(ms){const t=Math.max(0,Math.floor(Number(ms||0)/1000));return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`}
function formatDurationLong(ms){const total=Math.floor(ms/1000),h=Math.floor(total/3600),m=Math.floor(total%3600/60);return h?`${h}h ${m}m`:`${m}m`}
function formatBytes(bytes){if(bytes<1024)return`${bytes} B`;if(bytes<1024**2)return`${(bytes/1024).toFixed(1)} KB`;return`${(bytes/1024**2).toFixed(1)} MB`}
function srtTime(ms){const t=Math.max(0,Math.floor(ms)),h=Math.floor(t/3600000),m=Math.floor(t%3600000/60000),s=Math.floor(t%60000/1000),x=t%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(x).padStart(3,'0')}`}
function icsDate(d){return d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}
function parseDueDate(v){if(!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d}
function icsEscape(v){return String(v||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;')}
function safeName(v){return String(v||'omnivoice-note').replace(/[^a-z0-9-_]+/gi,'_').slice(0,80)}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function uid(){return crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`}
function spanNode(cls,text){const s=document.createElement('span');s.className=cls;s.textContent=text;return s}
function divNode(cls,children=[]){const d=document.createElement('div');d.className=cls;d.append(...children);return d}
function clearObjectUrls(){objectUrls.forEach(URL.revokeObjectURL);objectUrls=[]}
function downloadText(name,text,type){const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function blobToBase64(blob){const bytes=new Uint8Array(await blob.arrayBuffer());return bytesToBase64(bytes)}
function bytesToBase64(bytes){let binary='';const step=0x8000;for(let i=0;i<bytes.length;i+=step)binary+=String.fromCharCode(...bytes.subarray(i,i+step));return btoa(binary)}
function base64ToBytes(v){const b=atob(v),out=new Uint8Array(b.length);for(let i=0;i<b.length;i++)out[i]=b.charCodeAt(i);return out}
function base64Url(bytes){return bytesToBase64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function base64UrlToBytes(v){let b=v.replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';return base64ToBytes(b)}
function concatFloat32(buffers,total){const out=new Float32Array(total);let off=0;for(const b of buffers){out.set(b,off);off+=b.length}return out}
function encodeWavMono(samples,sampleRate,normalize){let gain=1;if(normalize){let peak=0;for(const x of samples)peak=Math.max(peak,Math.abs(x));if(peak>.0001)gain=Math.min(8,.95/peak)}const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer);writeAscii(view,0,'RIFF');view.setUint32(4,36+samples.length*2,true);writeAscii(view,8,'WAVE');writeAscii(view,12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);writeAscii(view,36,'data');view.setUint32(40,samples.length*2,true);let o=44;for(let i=0;i<samples.length;i++,o+=2){const s=Math.max(-1,Math.min(1,samples[i]*gain));view.setInt16(o,s<0?s*0x8000:s*0x7fff,true)}return new Blob([buffer],{type:'audio/wav'})}
function writeAscii(view,offset,text){for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))}
async function fingerprintBlob(blob){if(!blob?.size)return'';const size=Math.min(blob.size,512*1024);const head=new Uint8Array(await blob.slice(0,size).arrayBuffer());const tail=blob.size>size?new Uint8Array(await blob.slice(Math.max(size,blob.size-size)).arrayBuffer()):new Uint8Array();const meta=new TextEncoder().encode(`${blob.size}|${blob.type}|`);const all=new Uint8Array(meta.length+head.length+tail.length);all.set(meta);all.set(head,meta.length);all.set(tail,meta.length+head.length);const digest=await crypto.subtle.digest('SHA-256',all);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}

function openDb(){if(dbPromise)return dbPromise;dbPromise=new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});return dbPromise}
async function tx(mode,fn){const db=await openDb();return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),store=t.objectStore(STORE);let result;try{result=fn(store)}catch(e){reject(e);return}t.oncomplete=()=>resolve(result?.result??result);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error)})}
async function putSession(s){return tx('readwrite',store=>store.put(s))}
async function getSession(id){const db=await openDb();return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function listSessions(){const db=await openDb();return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
async function deleteSession(id){return tx('readwrite',store=>store.delete(id))}
