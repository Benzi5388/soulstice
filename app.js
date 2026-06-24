/* ============================================================
   SOULSTICE  —  front-end logic (cross-device)
   Two phones, one room code. Each player answers privately on
   their own device; the Netlify Function /api/room links them
   (Netlify Blobs) and computes the reading server-side once both
   have submitted. No API key ever touches the browser.
   ============================================================ */

/* ---------- 10 alternate-universe scenarios (must match room.js order) ---------- */
const SCENARIOS = [
  { name: "The Lost Island", desc: "Your plane goes down. Just the two of you, an endless ocean, and a single coconut.", self: "What is the very first thing you do once you realize you're stranded together?", predict: "What do you think THEY said they'd do first?" },
  { name: "Rival Chefs of 1920s Paris", desc: "Two legendary kitchens. One Michelin star. You are sworn culinary enemies.", self: "What's the secret dish you'd unveil to crush the competition?", predict: "What signature dish do you think THEY chose to defeat you?" },
  { name: "The Last Two Humans", desc: "Earth is silent. You are, as far as you know, the only two people left alive.", self: "Where on Earth do you decide to rebuild, and why there?", predict: "Where do you think THEY wanted to start over?" },
  { name: "Heist of the Floating Casino", desc: "A diamond the size of a fist orbits the moon in a velvet-lined vault. You're the crew.", self: "What's your role in the heist — and what's your getaway plan?", predict: "What role do you think THEY claimed for themselves?" },
  { name: "Soulmates in Reverse", desc: "You meet at the end of your lives and grow younger together until you're strangers.", self: "What is the one memory you'd fight hardest to keep as time unwinds?", predict: "Which memory do you think THEY refused to let go of?" },
  { name: "The Talking Cat Tribunal", desc: "Cats now rule Earth. You both stand accused of an unspeakable crime: being late to feed them.", self: "What's your impassioned defense before the Supreme Feline Court?", predict: "What ridiculous excuse do you think THEY tried to give the cats?" },
  { name: "Astronauts, Drifting", desc: "Your tether snaps. Oxygen for twenty minutes. Just two voices and the vast dark.", self: "What's the last thing you'd want to say to them out here?", predict: "What do you think THEY would say to you in those final minutes?" },
  { name: "The Body Swap", desc: "You wake up in each other's bodies. You have one day before it might become permanent.", self: "What's the first thing you'd do with their body that they'd absolutely hate?", predict: "What mischief do you think THEY got up to in YOUR body?" },
  { name: "Monarchs of a Tiny Kingdom", desc: "You jointly rule a nation of 14 citizens, 3 goats, and one very dramatic swan.", self: "What's the first royal law you'd pass for the good of the realm?", predict: "What law do you think THEY decreed first?" },
  { name: "Ghosts in the Same House", desc: "You both haunt one creaky old mansion for eternity. The living keep moving in.", self: "How do you spend your endless nights — and how do you scare the newcomers?", predict: "How do you think THEY chose to haunt the place?" }
];

const SCENE_EMOJI = ["🏝️","🍷","🌍","💎","⏳","🐱","🚀","🔄","👑","👻"];

/* Human avatars: illustrated people from DiceBear, seeded per player so each
   person gets a distinct face. Just an image URL — no backend. Falls back to a
   🧑 glyph if the image can't load (offline). */
const AVATAR_STYLE = "adventurer";
const avatarUrl = (seed) => `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed || "soul")}&backgroundColor=transparent`;
const avatarImg = (seed) => `<img class="av-img" src="${avatarUrl(seed)}" alt="" draggable="false" onerror="this.replaceWith(document.createTextNode('🧑'))" />`;
const newSeed = () => Math.random().toString(36).slice(2, 10);

/* ---------- Global state (in memory) ---------- */
const state = {
  me: { name: "", avatar: "" },   // avatar = a seed string
  partner: null,                  // { name, avatar }
  code: "",
  role: "",                       // 'host' | 'guest'
  scene: 0,
  answers: [],                    // [{self, predict}] for me
  submitted: false,
  result: null,
  pollTimer: null
};

/* ---------- DOM helpers ---------- */
const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const partnerLabel = () => esc(state.partner && state.partner.name ? state.partner.name : 'your partner');

/* ---------- Networking ---------- */
async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
  } catch (e) { throw new Error('offline'); }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (data && data.error) throw new Error(data.error);
    throw new Error('offline');
  }
  return data || {};
}
function netMessage(e) {
  return e.message === 'offline'
    ? 'Rooms need the server running. Use `netlify dev` (localhost:8888) — not the static :5173 — or deploy to Netlify.'
    : e.message;
}

/* ---------- Polling ---------- */
function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }
function startPoll(fn, interval = 2500) { stopPoll(); fn(); state.pollTimer = setInterval(fn, interval); }
function partnerFrom(view) {
  const p = state.role === 'host' ? view.guest : view.host;
  if (p) state.partner = { name: p.name, avatar: p.avatar };
  return p;
}

/* ---------- 3D tilt + spotlight ---------- */
function attachTilt(el, max = 7) {
  const reset = () => { el.style.setProperty('--mx', '50%'); el.style.setProperty('--my', '50%'); el.style.transform = ''; };
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    el.style.setProperty('--mx', (px * 100) + '%'); el.style.setProperty('--my', (py * 100) + '%');
    el.style.transform = `rotateY(${(px - 0.5) * max}deg) rotateX(${-(py - 0.5) * max}deg)`;
  });
  el.addEventListener('pointerleave', reset);
  el.addEventListener('pointercancel', reset);
}

/* ---------- Screen router ---------- */
let activeScreen = null;
function showScreen(id) {
  const incoming = document.getElementById(id);
  if (!incoming || incoming === activeScreen) return;
  if (activeScreen) {
    const out = activeScreen;
    out.classList.add('exit-left'); out.classList.remove('active');
    setTimeout(() => out.classList.remove('exit-left'), 650);
  }
  requestAnimationFrame(() => { incoming.classList.add('active'); incoming.scrollTop = 0; });
  activeScreen = incoming;
}
function mount(id, html) {
  let s = document.getElementById(id);
  if (s) s.remove();
  s = document.createElement('section');
  s.className = 'screen'; s.id = id; s.innerHTML = html;
  app.appendChild(s);
  return s;
}

/* ---------- Tap feedback ---------- */
function tapFx(btn) {
  btn.classList.remove('tapped'); void btn.offsetWidth; btn.classList.add('tapped');
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
  setTimeout(() => btn.classList.remove('tapped'), 540);
}
document.addEventListener('click', (e) => { const b = e.target.closest('.btn'); if (b && !b.disabled) tapFx(b); });

/* ---------- Toast ---------- */
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

/* ============================================================
   SCREEN: name + create/join
   ============================================================ */
function buildNameScreen() {
  const s = mount('screen-name', `
    <div class="center-stack compact">
      <div class="reveal-up d1" style="text-align:center;">
        <div class="brand" style="font-size:.7rem;margin-bottom:10px;">Two phones · Ten universes · One bond</div>
        <span class="title-orbit"><h1 class="title">Soulstice</h1><span class="spark">✦</span></span>
      </div>

      <div class="how reveal-up d2">
        <b>One</b> of you taps <b>Create a Room</b> and shares the code.
        The <b>other</b> taps <b>Join</b> and types it in. Then you each answer on your own phone.
      </div>

      <div class="name-card reveal-up d3" data-tilt>
        <div class="avatar" data-roll title="Tap for a new face">${avatarImg(state.me.avatar)}</div>
        <div class="name-field">
          <label>Your Name</label>
          <input id="meName" type="text" maxlength="22" placeholder="Enter your name" autocomplete="off" />
        </div>
        <button class="reroll" data-roll title="New face" aria-label="New avatar">⟳</button>
      </div>

      <div class="reveal-up d4">
        <button class="btn btn-glow" id="createBtn" disabled>Create a Room ✦</button>
        <div class="btn-sub">You'll get a code to share with your partner</div>
      </div>

      <div class="or-sep reveal-up d5">— already got a code? —</div>
      <div class="join-row reveal-up d5">
        <input id="codeInput" class="code-input" maxlength="5" placeholder="ENTER CODE" autocomplete="off" />
        <button class="btn btn-ghost" id="joinBtn">Join</button>
      </div>
    </div>
  `);

  s.querySelectorAll('[data-tilt]').forEach(el => attachTilt(el, 6));

  const nameInput = $('#meName', s), createBtn = $('#createBtn', s), joinBtn = $('#joinBtn', s), codeInput = $('#codeInput', s);

  const sync = () => { state.me.name = nameInput.value.trim(); createBtn.disabled = state.me.name.length === 0; };
  nameInput.addEventListener('input', sync);
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  s.querySelectorAll('[data-roll]').forEach(btn => btn.addEventListener('click', () => {
    state.me.avatar = newSeed();
    const av = $('.avatar', s); av.innerHTML = avatarImg(state.me.avatar);
    av.classList.remove('pop'); void av.offsetWidth; av.classList.add('pop');
  }));

  createBtn.addEventListener('click', async () => {
    if (createBtn.disabled) return;
    createBtn.disabled = true;
    startMusicIfArmed();
    try {
      const r = await api('create', { name: state.me.name, avatar: state.me.avatar });
      state.code = r.roomCode; state.role = 'host'; state.partner = null;
      buildLobby();
      showScreen('screen-lobby');
    } catch (e) { toast(netMessage(e)); createBtn.disabled = false; }
  });

  joinBtn.addEventListener('click', async () => {
    state.me.name = nameInput.value.trim();
    const code = codeInput.value.trim();
    if (!state.me.name) { toast('Enter your name first ✦'); nameInput.focus(); return; }
    if (code.length < 4) { toast('Enter the room code your partner shared'); codeInput.focus(); return; }
    joinBtn.disabled = true;
    startMusicIfArmed();
    try {
      const r = await api('join', { code, name: state.me.name, avatar: state.me.avatar });
      state.code = r.roomCode; state.role = 'guest';
      partnerFrom(r.view);
      buildLobby();
      showScreen('screen-lobby');
    } catch (e) { toast(netMessage(e)); joinBtn.disabled = false; }
  });
}

/* ============================================================
   SCREEN: lobby (room code + avatars + partner status)
   ============================================================ */
function buildLobby() {
  const isHost = state.role === 'host';
  const me = state.me;
  const s = mount('screen-lobby', `
    <div class="center-stack compact">
      <div class="eyebrow reveal-up d1">Your Room</div>

      <div class="bond reveal-up d1" style="margin:2px 0 2px;">
        <div class="person"><div class="big-av">${avatarImg(me.avatar)}</div><div class="pn">${esc(me.name)}</div></div>
        <div class="link-line"></div>
        <div class="person"><div class="big-av" id="partnerAv" style="opacity:.4;">✦</div><div class="pn" id="partnerName" style="color:var(--ink-faint);">…</div></div>
      </div>

      <div class="room-code-box reveal-up d2">
        <div class="room-code">${esc(state.code)}</div>
        <button class="copy-code" id="copyCode">Copy code</button>
      </div>

      <div class="lobby-status reveal-up d3" id="lobbyStatus"><span class="status-dot"></span> <span class="lobby-text">…</span></div>

      <p class="tagline reveal-up d4" style="font-size:1rem;">${isHost
        ? 'Send this code to your partner. They tap <b>Join</b> and type it in — then you each answer on your own phone.'
        : 'You’re in! You can each answer on your own phone, whenever you like.'}</p>

      <div class="reveal-up d5"><button class="btn btn-glow" id="beginBtn">Begin My Answers ✦</button></div>
    </div>
  `);

  $('#copyCode', s).addEventListener('click', () => {
    const btn = $('#copyCode', s);
    copyText(state.code, () => { btn.textContent = 'Copied ✦'; btn.classList.add('copied'); toast('Room code copied ✦'); setTimeout(() => { btn.textContent = 'Copy code'; btn.classList.remove('copied'); }, 1800); });
  });

  $('#beginBtn', s).addEventListener('click', () => {
    stopPoll();
    state.scene = 0;
    buildQuizScreen();
    showScreen('screen-quiz');
    renderScene();
  });

  const setStatus = () => {
    const el = $('#lobbyStatus', s); if (!el) return;
    const txt = $('.lobby-text', el);
    const pav = $('#partnerAv', s), pnm = $('#partnerName', s);
    if (state.partner && state.partner.name) {
      el.className = 'lobby-status joined reveal-up d3';
      txt.textContent = `${state.partner.name} has joined ✦`;
      if (pav) { pav.innerHTML = avatarImg(state.partner.avatar); pav.style.opacity = '1'; }
      if (pnm) { pnm.textContent = state.partner.name; pnm.style.color = 'var(--ink)'; }
    } else if (isHost) {
      el.className = 'lobby-status live reveal-up d3';
      txt.textContent = 'Waiting for your partner to join…';
      if (pnm) pnm.textContent = 'Waiting…';
    } else {
      el.className = 'lobby-status joined reveal-up d3';
      txt.textContent = 'Connected ✦';
    }
  };
  setStatus();

  startPoll(async () => {
    try {
      const r = await api('status', { code: state.code });
      partnerFrom(r.view);
      setStatus();
    } catch (e) { /* keep polling quietly */ }
  });
}

/* ============================================================
   SCREEN: quiz (this player only)
   ============================================================ */
function buildQuizScreen() {
  const nodes = Array.from({ length: SCENARIOS.length }).map(() => '<span class="node"></span>').join('');
  const s = mount('screen-quiz', `
    <div class="quiz-top">
      <div class="quiz-bar-row">
        <div class="mini-av">${avatarImg(state.me.avatar)}</div>
        <div class="progress-wrap">
          <div class="progress-label"><span>${esc(state.me.name)}</span><span><span id="qcount">Universe 1 of 10</span> · <span class="pct" id="qpct">0%</span></span></div>
          <div class="progress-track"><div class="progress-fill" id="qfill"></div></div>
          <div class="constellation" id="constellation">${nodes}</div>
        </div>
      </div>
    </div>
    <div class="scene-stage"><div class="scene-card" id="sceneCard"></div></div>
  `);
  attachTilt($('#sceneCard', s), 6);
}

function updateProgress(s, idx) {
  const pct = Math.round((idx / SCENARIOS.length) * 100);
  $('#qcount', s).textContent = `Universe ${idx + 1} of ${SCENARIOS.length}`;
  $('#qpct', s).textContent = pct + '%';
  $('#qfill', s).style.width = pct + '%';
  s.querySelectorAll('.constellation .node').forEach((n, i) => {
    n.classList.toggle('done', i < idx);
    n.classList.toggle('current', i === idx);
  });
}

function renderScene() {
  const s = document.getElementById('screen-quiz');
  const card = $('#sceneCard', s);
  const sc = SCENARIOS[state.scene];

  updateProgress(s, state.scene);
  const saved = state.answers[state.scene] || { self: "", predict: "" };
  const isLast = state.scene === SCENARIOS.length - 1;

  card.style.transform = '';
  card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
  card.innerHTML = `
    <span class="scene-emoji">${SCENE_EMOJI[state.scene]}</span>
    <div class="scene-name">${esc(sc.name)}</div>
    <div class="scene-desc">"${esc(sc.desc)}"</div>

    <div class="q-block">
      <span class="q-tag">Your truth</span>
      <div class="q-text">${esc(sc.self)}</div>
      <textarea id="ansSelf" placeholder="Speak from the heart...">${esc(saved.self)}</textarea>
    </div>

    <div class="q-block">
      <span class="q-tag predict">Predict ${partnerLabel()}</span>
      <div class="q-text">${esc(sc.predict)}</div>
      <textarea id="ansPredict" placeholder="What would they say...?">${esc(saved.predict)}</textarea>
    </div>

    <div class="scene-nav">
      ${state.scene > 0 ? '<button class="btn btn-ghost" id="prevBtn">←</button>' : ''}
      <button class="btn" id="nextBtn">${isLast ? 'Seal My Answers ✦' : 'Next Universe →'}</button>
    </div>
  `;

  const save = () => { state.answers[state.scene] = { self: $('#ansSelf', card).value.trim(), predict: $('#ansPredict', card).value.trim() }; };

  const prev = $('#prevBtn', card);
  if (prev) prev.addEventListener('click', () => { save(); state.scene--; renderScene(); });

  $('#nextBtn', card).addEventListener('click', async () => {
    save();
    updateProgress(s, state.scene + 1);
    if (!isLast) { state.scene++; setTimeout(renderScene, 130); return; }
    buildWaitScreen();
    showScreen('screen-wait');
    submitAndWait();
  });
}

/* ============================================================
   SCREEN: waiting for partner / computing
   ============================================================ */
function buildWaitScreen() {
  mount('screen-wait', `
    <div class="orbit reveal-up d1">
      <div class="ring r3"><span class="dot"></span></div>
      <div class="ring r2"><span class="dot"></span></div>
      <div class="ring r1"><span class="dot"></span></div>
      <div class="core"></div>
    </div>
    <div class="calc-text reveal-up d2" id="waitText">Your answers are sealed ✦</div>
    <div class="calc-sub reveal-up d3" id="waitSub">Sending across the multiverse…</div>
  `);
}

function setWait(main, sub) {
  const m = document.getElementById('waitText'), su = document.getElementById('waitSub');
  if (m && main != null) { m.style.opacity = 0; setTimeout(() => { if (m) { m.textContent = main; m.style.opacity = 1; } }, 250); }
  if (su && sub != null) su.textContent = sub;
}

async function submitAndWait() {
  state.submitted = false;
  for (let attempt = 0; attempt < 3 && !state.submitted; attempt++) {
    try {
      const r = await api('submit', { code: state.code, role: state.role, answers: state.answers });
      state.submitted = true;
      partnerFrom(r.view);
      if (r.view.ready) { finishWithResult(r.view.result); return; }
    } catch (e) {
      if (attempt === 2) setWait('The connection wavered…', 'Retrying shortly');
      await new Promise(res => setTimeout(res, 1200));
    }
  }
  startPoll(async () => {
    try {
      const r = await api('status', { code: state.code });
      const partner = partnerFrom(r.view);
      if (r.view.ready && r.view.result) { finishWithResult(r.view.result); return; }
      if (r.view.computing) setWait('The Multiverse is calculating…', 'Folding ten realities into one');
      else if (!partner) setWait('Waiting for your partner to join…', `Share your code: ${state.code}`);
      else if (!r.view[state.role === 'host' ? 'guest' : 'host'].submitted) setWait(`Waiting for ${partnerLabel()} to finish…`, 'Their journey is still unfolding');
      else setWait('Aligning your souls…', 'Almost there');
    } catch (e) { /* keep polling quietly */ }
  }, 2500);
}

function finishWithResult(result) {
  stopPoll();
  state.result = normalizeResult(result);
  buildRevealScreen();
  showScreen('screen-reveal');
  runRevealSequence();
}

function normalizeResult(r) {
  let score = Number(r && r.score);
  if (!isFinite(score)) score = 5;
  score = Math.max(0, Math.min(10, score));
  let synced = Array.isArray(r && r.syncedUniverses) ? r.syncedUniverses.slice(0, 2) : [];
  while (synced.length < 2) synced.push(SCENARIOS[synced.length].name);
  return {
    score: Math.round(score * 10) / 10,
    verdict: String((r && r.verdict) || "").trim() || "Two travelers, ten worlds, one quiet gravity pulling them together.",
    syncedUniverses: synced,
    lostUniverse: String((r && r.lostUniverse) || SCENARIOS[5].name).trim(),
    closingLine: String((r && r.closingLine) || "").trim() || "Across every universe, you keep finding your way back to each other."
  };
}

/* ============================================================
   SCREEN: reveal (cinematic)
   ============================================================ */
function buildRevealScreen() {
  const me = state.me;
  const partner = state.partner || { name: 'Your partner', avatar: 'partner' };
  const s = mount('screen-reveal', `
    <div class="eyebrow reveal-up d1" style="margin-bottom:14px;">The Multiverse has spoken</div>

    <div class="bond reveal-up d1">
      <div class="person"><div class="big-av">${avatarImg(me.avatar)}</div><div class="pn">${esc(me.name)}</div></div>
      <div class="link-line"></div>
      <div class="person"><div class="big-av">${avatarImg(partner.avatar)}</div><div class="pn">${esc(partner.name)}</div></div>
    </div>

    <div class="score-zone reveal-up d2">
      <div class="score-ring" id="scoreRing">
        <div class="score-inner">
          <div><span class="score-num" id="scoreNum">0</span><span class="score-den">/10</span></div>
          <div class="score-cap">Compatibility</div>
        </div>
      </div>
    </div>

    <div class="verdict-card reveal-up d3" data-tilt><div class="verdict-text" id="verdictText"></div></div>
    <div class="uni-section" id="uniSection"></div>
    <div class="closing-line" id="closingLine">"${esc(state.result.closingLine)}"</div>

    <div class="reveal-actions" id="revealActions">
      <button class="btn" id="shareBtn">Share Our Reading ✦</button>
      <button class="btn btn-ghost" id="playAgainBtn">Play Again</button>
    </div>
  `);
  s.querySelectorAll('[data-tilt]').forEach(el => attachTilt(el, 5));
  $('#shareBtn', s).addEventListener('click', shareResult);
  $('#playAgainBtn', s).addEventListener('click', resetAll);
}

function runRevealSequence() {
  const r = state.result, s = document.getElementById('screen-reveal');
  setTimeout(() => { animateScore(r.score); particleExplosion(); if (navigator.vibrate) { try { navigator.vibrate([20, 40, 30]); } catch (e) {} } }, 700);
  setTimeout(() => typewriter($('#verdictText', s), r.verdict), 2300);
  const verdictMs = 2300 + r.verdict.length * 22 + 600;
  setTimeout(() => buildUniverseRows(r), verdictMs);
  setTimeout(() => { $('#closingLine', s).classList.add('show'); particleExplosion(0.5); }, verdictMs + 1500);
  setTimeout(() => $('#revealActions', s).classList.add('show'), verdictMs + 2500);
}

function animateScore(target) {
  const el = document.getElementById('scoreNum'), ring = document.getElementById('scoreRing');
  if (!el) return;
  const dur = 2200, start = performance.now(), decimals = (target % 1 !== 0);
  function frame(now) {
    const t = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - t, 3), val = target * eased;
    el.textContent = decimals ? val.toFixed(1) : Math.round(val);
    if (ring) ring.style.setProperty('--p', (val * 10).toFixed(1));
    if (t < 1) requestAnimationFrame(frame);
    else { el.textContent = decimals ? target.toFixed(1) : Math.round(target); if (ring) ring.style.setProperty('--p', (target * 10).toFixed(1)); }
  }
  requestAnimationFrame(frame);
}

function typewriter(el, text) {
  if (!el) return;
  const cursor = '<span class="cursor">&nbsp;</span>';
  el.innerHTML = cursor;
  let i = 0;
  (function step() { i++; el.innerHTML = esc(text.slice(0, i)) + cursor; if (i < text.length) setTimeout(step, 22); else setTimeout(() => { el.innerHTML = esc(text); }, 600); })();
}

function buildUniverseRows(r) {
  const wrap = document.getElementById('uniSection');
  if (!wrap) return;
  const rows = [];
  r.syncedUniverses.forEach(name => rows.push(`<div class="uni-row synced"><span class="ico">✨</span><div class="uni-meta"><div class="ul">In perfect sync</div><div class="un">${esc(name)}</div></div></div>`));
  rows.push(`<div class="uni-row lost"><span class="ico">💔</span><div class="uni-meta"><div class="ul">Where you lost each other</div><div class="un">${esc(r.lostUniverse)}</div></div></div>`);
  wrap.innerHTML = rows.join('');
  wrap.querySelectorAll('.uni-row').forEach((row, i) => setTimeout(() => row.classList.add('show'), i * 480));
}

/* ---------- Share ---------- */
function shareResult() {
  const r = state.result, me = state.me, partner = state.partner || { name: 'Partner' };
  const text = `✦ Soulstice ✦\n${me.name} & ${partner.name}\nCompatibility: ${r.score}/10\n\n"${r.closingLine}"\n\n— read across ten universes`;
  const done = () => toast('Copied to clipboard ✦');
  if (navigator.share) navigator.share({ title: 'Soulstice', text }).catch(() => copyText(text, done));
  else copyText(text, done);
}
function copyText(text, cb) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(cb).catch(() => legacyCopy(text, cb));
  else legacyCopy(text, cb);
}
function legacyCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); cb(); } catch (e) { toast('Could not copy'); }
  document.body.removeChild(ta);
}

/* ---------- Play again / reset ---------- */
function resetAll() {
  stopPoll();
  const keep = state.me.avatar;
  state.me = { name: "", avatar: keep };
  state.partner = null; state.code = ""; state.role = "";
  state.scene = 0; state.answers = []; state.submitted = false; state.result = null;
  buildNameScreen();
  showScreen('screen-name');
}

/* ============================================================
   Starfield · parallax · shooting stars · floating particles
   ============================================================ */
const starCanvas = document.getElementById('starfield');
const sctx = starCanvas.getContext('2d');
let stars = [], floaters = [], shooters = [], DPR = Math.min(window.devicePixelRatio || 1, 2);
let pointer = { x: 0, y: 0, tx: 0, ty: 0 };

function sizeCanvas(cv) { cv.width = window.innerWidth * DPR; cv.height = window.innerHeight * DPR; cv.style.width = window.innerWidth + 'px'; cv.style.height = window.innerHeight + 'px'; }
function initStars() {
  sizeCanvas(starCanvas);
  const W = starCanvas.width, H = starCanvas.height;
  const count = Math.floor((W * H) / (9000 * DPR));
  stars = [];
  for (let i = 0; i < count; i++) {
    const r = (Math.random() * 1.3 + 0.3) * DPR;
    stars.push({ x: Math.random() * W, y: Math.random() * H, r, base: Math.random() * 0.6 + 0.2, tw: Math.random() * Math.PI * 2, tws: Math.random() * 0.04 + 0.01, gold: Math.random() < 0.18, depth: r / (1.6 * DPR) });
  }
  floaters = [];
  const fcount = Math.floor(count / 7);
  for (let i = 0; i < fcount; i++) floaters.push({ x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 2 + 1) * DPR, vx: (Math.random() - 0.5) * 0.15 * DPR, vy: -(Math.random() * 0.2 + 0.05) * DPR, a: Math.random() * 0.4 + 0.15, gold: Math.random() < 0.4 });
}
function spawnShooter() {
  const W = starCanvas.width, H = starCanvas.height;
  const ang = Math.PI * (0.18 + Math.random() * 0.12), sp = (8 + Math.random() * 6) * DPR;
  shooters.push({ x: Math.random() * W * 0.6, y: Math.random() * H * 0.4, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, len: (90 + Math.random() * 80) * DPR, life: 1 });
}
function drawStars() {
  const W = starCanvas.width, H = starCanvas.height;
  sctx.clearRect(0, 0, W, H);
  pointer.x += (pointer.tx - pointer.x) * 0.05; pointer.y += (pointer.ty - pointer.y) * 0.05;
  const par = 26 * DPR;
  for (const s of stars) {
    s.tw += s.tws;
    const a = s.base + Math.sin(s.tw) * 0.3;
    sctx.beginPath(); sctx.arc(s.x + pointer.x * par * s.depth, s.y + pointer.y * par * s.depth, s.r, 0, Math.PI * 2);
    sctx.fillStyle = s.gold ? `rgba(245,200,96,${a})` : `rgba(220,210,255,${a})`; sctx.fill();
  }
  for (const f of floaters) {
    f.x += f.vx; f.y += f.vy;
    if (f.y < -10) { f.y = H + 10; f.x = Math.random() * W; }
    if (f.x < -10) f.x = W + 10; if (f.x > W + 10) f.x = -10;
    const grad = sctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 3);
    const col = f.gold ? '245,200,96' : '167,139,250';
    grad.addColorStop(0, `rgba(${col},${f.a})`); grad.addColorStop(1, `rgba(${col},0)`);
    sctx.fillStyle = grad; sctx.beginPath(); sctx.arc(f.x, f.y, f.r * 3, 0, Math.PI * 2); sctx.fill();
  }
  if (shooters.length < 2 && Math.random() < 0.004) spawnShooter();
  for (let i = shooters.length - 1; i >= 0; i--) {
    const sh = shooters[i];
    sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.012;
    if (sh.life <= 0 || sh.x > W + 50 || sh.y > H + 50) { shooters.splice(i, 1); continue; }
    const hyp = Math.hypot(sh.vx, sh.vy), tx = sh.x - sh.vx / hyp * sh.len, ty = sh.y - sh.vy / hyp * sh.len;
    const grad = sctx.createLinearGradient(sh.x, sh.y, tx, ty);
    grad.addColorStop(0, `rgba(255,240,200,${sh.life})`); grad.addColorStop(1, 'rgba(255,240,200,0)');
    sctx.strokeStyle = grad; sctx.lineWidth = 2 * DPR; sctx.lineCap = 'round';
    sctx.beginPath(); sctx.moveTo(sh.x, sh.y); sctx.lineTo(tx, ty); sctx.stroke();
  }
  requestAnimationFrame(drawStars);
}

const fxCanvas = document.getElementById('fx');
const fctx = fxCanvas.getContext('2d');
let bursts = [], fxRunning = false;
function particleExplosion(scale = 1) {
  sizeCanvas(fxCanvas);
  const cx = fxCanvas.width / 2, cy = fxCanvas.height * 0.32, N = Math.round(95 * scale);
  for (let i = 0; i < N; i++) {
    const ang = Math.random() * Math.PI * 2, sp = (Math.random() * 6 + 2) * DPR * scale;
    bursts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1 * DPR, r: (Math.random() * 2.5 + 1) * DPR, life: 1, decay: Math.random() * 0.012 + 0.006, gold: Math.random() < 0.6 });
  }
  setTimeout(() => secondaryBurst(cx - 60 * DPR, cy + 30 * DPR, scale), 220);
  setTimeout(() => secondaryBurst(cx + 60 * DPR, cy + 30 * DPR, scale), 380);
  if (!fxRunning) { fxRunning = true; runFx(); }
}
function secondaryBurst(x, y, scale) {
  for (let i = 0; i < Math.round(40 * scale); i++) {
    const ang = Math.random() * Math.PI * 2, sp = (Math.random() * 4 + 1.5) * DPR;
    bursts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.8 * DPR, r: (Math.random() * 2 + 0.8) * DPR, life: 1, decay: Math.random() * 0.014 + 0.008, gold: Math.random() < 0.5 });
  }
}
function runFx() {
  fctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  for (let i = bursts.length - 1; i >= 0; i--) {
    const p = bursts[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.05 * DPR; p.vx *= 0.99; p.life -= p.decay;
    if (p.life <= 0) { bursts.splice(i, 1); continue; }
    const col = p.gold ? '245,200,96' : '167,139,250';
    fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    fctx.fillStyle = `rgba(${col},${p.life})`; fctx.shadowBlur = 12; fctx.shadowColor = `rgba(${col},${p.life})`; fctx.fill();
  }
  fctx.shadowBlur = 0;
  if (bursts.length > 0) requestAnimationFrame(runFx);
  else { fctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height); fxRunning = false; }
}

const cursorGlow = document.getElementById('cursorGlow');
function onPointer(clientX, clientY) {
  pointer.tx = (clientX / window.innerWidth - 0.5) * 2;
  pointer.ty = (clientY / window.innerHeight - 0.5) * 2;
  if (cursorGlow) { cursorGlow.style.opacity = '1'; cursorGlow.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`; }
}
window.addEventListener('pointermove', (e) => onPointer(e.clientX, e.clientY), { passive: true });
window.addEventListener('pointerdown', (e) => onPointer(e.clientX, e.clientY), { passive: true });
window.addEventListener('resize', () => initStars());

/* ============================================================
   Ambient cosmic music (Web Audio — self-contained)
   ============================================================ */
let audioCtx = null, musicNodes = [], musicOn = false, musicArmed = false;
const musicBtn = document.getElementById('musicBtn');
function buildMusic() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const master = audioCtx.createGain(); master.gain.value = 0; master.connect(audioCtx.destination);
  const freqs = [110, 164.81, 220, 277.18];
  const padGain = audioCtx.createGain(); padGain.gain.value = 0.16; padGain.connect(master);
  freqs.forEach((f, idx) => {
    const osc = audioCtx.createOscillator(); osc.type = idx % 2 === 0 ? 'sine' : 'triangle'; osc.frequency.value = f;
    const g = audioCtx.createGain(); g.gain.value = 0.25 / freqs.length;
    const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.05 + idx * 0.013;
    const lfoGain = audioCtx.createGain(); lfoGain.gain.value = 1.5;
    lfo.connect(lfoGain); lfoGain.connect(osc.detune);
    osc.connect(g); g.connect(padGain); osc.start(); lfo.start();
    musicNodes.push(osc, lfo);
  });
  const bufferSize = 2 * audioCtx.sampleRate;
  const noiseBuf = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const out = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) out[i] = (Math.random() * 2 - 1) * 0.5;
  const noise = audioCtx.createBufferSource(); noise.buffer = noiseBuf; noise.loop = true;
  const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.7;
  const nGain = audioCtx.createGain(); nGain.gain.value = 0.012;
  noise.connect(bp); bp.connect(nGain); nGain.connect(master); noise.start();
  musicNodes.push(noise); musicNodes.master = master;
}
function startMusicIfArmed() { if (musicArmed && !musicOn) toggleMusic(true); }
function toggleMusic(force) {
  const want = (typeof force === 'boolean') ? force : !musicOn;
  if (want) {
    if (!audioCtx) buildMusic();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    musicNodes.master.gain.cancelScheduledValues(now);
    musicNodes.master.gain.setValueAtTime(musicNodes.master.gain.value, now);
    musicNodes.master.gain.linearRampToValueAtTime(0.5, now + 2);
    musicOn = true; musicArmed = true; musicBtn.classList.add('on');
  } else {
    if (audioCtx && musicNodes.master) {
      const now = audioCtx.currentTime;
      musicNodes.master.gain.cancelScheduledValues(now);
      musicNodes.master.gain.setValueAtTime(musicNodes.master.gain.value, now);
      musicNodes.master.gain.linearRampToValueAtTime(0, now + 1);
    }
    musicOn = false; musicBtn.classList.remove('on');
  }
}
musicBtn.addEventListener('click', () => { musicArmed = true; toggleMusic(); });

/* ============================================================
   Boot
   ============================================================ */
function init() {
  initStars();
  drawStars();
  state.me.avatar = newSeed();
  buildNameScreen();
  showScreen('screen-name');
}
init();
