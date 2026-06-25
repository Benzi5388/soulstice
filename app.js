/* ============================================================
   SOULSTICE  —  front-end (warm & romantic)
   Flow: name → choose (create / join) → lobby → quiz → wait → reveal
   Cross-device via /api/room (Netlify Function + Blobs). No key in browser.
   ============================================================ */

/* ---------- 5 couple-test questions (must match room.js order) ---------- */
const SCENARIOS = [
  { name: "The Signal", desc: "You're both stranded on different planets. You sent an important transmission. They received it. It's been 3 hours. No reply.", self: "What are you doing right now?", predict: "What are THEY doing right now?", options: ["😤 Drafted four follow-ups and deleted them all", "😌 Completely unbothered — they'll reply when they reply", "📡 Already tried calling. Twice.", "🕵️ Checking their last active signal to see if they're online"] },
  { name: "The Wrong Turn", desc: "You're both in a spaceship. Navigation says go right. Your gut says left. You went left. Now you're completely lost in deep space.", self: "What happens next?", predict: "How did THEY react?", options: ["😶 Complete silence. Both staring at the controls.", "😂 Already laughing about it", "🗣️ \"I literally told you.\"", "🔄 Pretending to recalculate like it was the plan all along"] },
  /* TESTING ONLY — 8 universes temporarily disabled. Uncomment this block (and the matching one in netlify/functions/room.js) to restore all 10.
  { name: "The Contraband", desc: "You smuggled something unnecessary onto the ship. They found it in the cargo bay.", self: "Your move?", predict: "What's THEIR move?", options: ["🙈 \"I've had this since before the mission, what are you talking about\"", "💸 Immediately justify it with a 5-point argument", "😇 Come clean immediately — I cannot lie to save my life", "🛒 \"Okay but also look what THEY smuggled last week\""] },
  { name: "The Unfinished Argument", desc: "You both went into cryo-sleep mid-argument. You just woke up. 10 years later. They're looking at you.", self: "What do you do?", predict: "What do THEY do?", options: ["😤 Pick up exactly where we left off", "😂 Laugh. We really did that.", "😶 Pretend it never happened", "💬 \"So... do you want to talk about it?\""] },
  { name: "The Repeat", desc: "You've explained the mission plan three times already. They just commed you asking the same question again.", self: "What do you do?", predict: "What do THEY do?", options: ["😤 Answer — but they're absolutely hearing about this later", "😂 Laugh, because at this point it's just funny", "😶 Answer calmly. Deep breaths. It's fine.", "📡 Send them the recording of the last three times"] },
  { name: "The Mood", desc: "Something is clearly wrong with them. The whole ship can feel it. You asked. They said fine. It is not fine.", self: "What do you do?", predict: "What do THEY do?", options: ["🫂 Ask again. I'm not leaving it at 'fine'.", "😶 Respect it. They'll talk when they're ready.", "😤 Fine. If they're fine, then I'm fine.", "💬 Don't ask again, but stay close just in case"] },
  { name: "The Eavesdrop", desc: "You weren't meant to hear what they said about you to someone else on the crew. But you did. They have no idea.", self: "What do you do?", predict: "What do THEY do?", options: ["😶 Pretend I heard nothing. Carry on.", "💬 Bring it up directly. Right now.", "🤐 Hold it in. Let it quietly eat me alive.", "😏 Start acting slightly different and wait for them to notice"] },
  { name: "Actually, Never Mind", desc: "You're in different galaxies. They sent: \"we need to talk.\" You've been spiralling for 20 minutes. Next message: \"actually never mind.\"", self: "What do you do?", predict: "What do THEY do?", options: ["😤 \"No. We're talking. Right now.\"", "😶 Pretend I'm fine. Internally on fire.", "😂 Laugh it off — but bring it up again later", "🚀 Go silent and wait for them to come to me"] },
  { name: "The Public Correction", desc: "You're both delegates at an intergalactic council. You said something. They corrected you in front of every alien species in the room. The chamber went silent.", self: "What happens next?", predict: "How do THEY react?", options: ["😤 I correct their correction. Immediately.", "😶 Smile and die a little inside", "😂 Laugh it off — but we are discussing this later", "🗣️ Call it out right there. In front of everyone."] },
  { name: "The Hologram", desc: "You're telling them something important via hologram. You can see they're distracted. You're still talking.", self: "What do you do?", predict: "What do THEY do?", options: ["😤 Stop transmitting completely and wait", "😶 Finish the story to nobody", "🗣️ \"Are you even listening to me?\"", "📡 Go offline. Two can play."] }
  */
];

const SCENE_EMOJI = ["📡","🧭","📦","❄️","🔁","🌧️","👂","📩","😳","🛰️"];

/* Human avatars (DiceBear, seeded per player). */
const AVATAR_STYLE = "adventurer";
const avatarUrl = (seed) => `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed || "soul")}&backgroundColor=transparent`;
const avatarImg = (seed) => `<img class="av-img" src="${avatarUrl(seed)}" alt="" draggable="false" onerror="this.replaceWith(document.createTextNode('🧑'))" />`;
const newSeed = () => Math.random().toString(36).slice(2, 10);

/* ---------- State ---------- */
const state = {
  me: { name: "", avatar: "" },
  partner: null,
  code: "",
  role: "",
  scene: 0,
  answers: [],
  submitted: false,
  result: null,
  pollTimer: null
};

/* ---------- Session persistence (survive a refresh) ---------- */
const SS_KEY = 'soulsync_session';
function saveSession() {
  try { localStorage.setItem(SS_KEY, JSON.stringify({ me: state.me, code: state.code, role: state.role, scene: state.scene, answers: state.answers, submitted: state.submitted })); } catch (e) {}
}
function clearSession() { try { localStorage.removeItem(SS_KEY); } catch (e) {} }
function loadSession() { try { return JSON.parse(localStorage.getItem(SS_KEY) || 'null'); } catch (e) { return null; } }

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
  if (!res.ok) { if (data && data.error) throw new Error(data.error); throw new Error('offline'); }
  return data || {};
}
function netMessage(e) {
  return e.message === 'offline'
    ? 'Can’t reach the server. Use `netlify dev` (localhost:8888), or deploy to Netlify.'
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

/* ---------- Tilt ---------- */
function attachTilt(el, max = 5) {
  const reset = () => { el.style.transform = ''; };
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    el.style.transform = `perspective(900px) rotateY(${(px - 0.5) * max}deg) rotateX(${-(py - 0.5) * max}deg)`;
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
    setTimeout(() => out.classList.remove('exit-left'), 600);
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
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
  setTimeout(() => btn.classList.remove('tapped'), 540);
}
document.addEventListener('click', (e) => { const b = e.target.closest('.btn'); if (b && !b.disabled) tapFx(b); });

/* ---------- Toast ---------- */
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200); }

/* ============================================================
   STEP 1 — Name & avatar
   ============================================================ */
function buildNameScreen() {
  const s = mount('screen-name', `
    <div class="center-stack">
      <div class="reveal-up d1" style="text-align:center;">
        <div class="brand" style="margin-bottom:12px;">A test of two hearts</div>
        <span class="title-orbit"><h1 class="title">SoulSync</h1><span class="spark">💕</span></span>
      </div>
      <p class="tagline reveal-up d2">How well do you really<br/>know each other?</p>

      <div class="name-card reveal-up d3">
        <div class="reroll-row">
          <div class="avatar" data-roll title="Tap for a new face">${avatarImg(state.me.avatar)}</div>
        </div>
        <div class="reroll-row"><button class="reroll" data-roll aria-label="New avatar">⟳</button><span class="reroll-hint">tap to change your face</span></div>
        <div class="field">
          <label>Your Name</label>
          <input id="meName" type="text" maxlength="22" placeholder="who are you?" autocomplete="off" />
        </div>
      </div>

      <div class="reveal-up d4"><button class="btn btn-glow" id="continueBtn" disabled>Continue 💞</button></div>
      <div class="footnote reveal-up d5">Played on two phones, together or apart<br/>Developed with 💗 by Benazir</div>
    </div>
  `);

  const nameInput = $('#meName', s), cont = $('#continueBtn', s);
  const sync = () => { state.me.name = nameInput.value.trim(); cont.disabled = state.me.name.length === 0; };
  nameInput.addEventListener('input', sync);
  sync();

  s.querySelectorAll('[data-roll]').forEach(btn => btn.addEventListener('click', () => {
    state.me.avatar = newSeed();
    const av = $('.avatar', s); av.innerHTML = avatarImg(state.me.avatar);
    av.classList.remove('pop'); void av.offsetWidth; av.classList.add('pop');
  }));

  cont.addEventListener('click', () => {
    if (cont.disabled) return;
    startMusicIfArmed();
    saveSession();
    buildChooseScreen();
    showScreen('screen-choose');
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !cont.disabled) cont.click(); });
}

/* ============================================================
   STEP 2 — Choose: create a room OR join with a code
   ============================================================ */
function buildChooseScreen() {
  const s = mount('screen-choose', `
    <div class="center-stack">
      <div class="greeting reveal-up d1">
        <div class="avatar">${avatarImg(state.me.avatar)}</div>
        <div class="hi">Hi, <b>${esc(state.me.name)}</b> 👋</div>
      </div>
      <p class="tagline reveal-up d2" style="font-size:1.1rem;">How would you like to start?</p>

      <button class="choice-card primary reveal-up d3" id="createChoice">
        <div class="ic">✨</div>
        <div><div class="ct">Create a room</div><div class="cs">You'll get a code to share with your partner</div></div>
      </button>

      <button class="choice-card reveal-up d4" id="joinChoice">
        <div class="ic">💌</div>
        <div><div class="ct">I have a code</div><div class="cs">Join the room your partner already created</div></div>
      </button>

      <button class="link-btn reveal-up d5" id="backName" style="margin-top:4px;">← change name</button>
    </div>
  `);

  $('#createChoice', s).addEventListener('click', doCreate);
  $('#joinChoice', s).addEventListener('click', () => { buildJoinScreen(); showScreen('screen-join'); });
  $('#backName', s).addEventListener('click', () => { buildNameScreen(); showScreen('screen-name'); });
}

async function doCreate() {
  const btn = document.getElementById('createChoice');
  if (btn) btn.style.pointerEvents = 'none';
  try {
    const r = await api('create', { name: state.me.name, avatar: state.me.avatar });
    state.code = r.roomCode; state.role = 'host'; state.partner = null;
    saveSession();
    buildLobby(); showScreen('screen-lobby');
  } catch (e) { toast(netMessage(e)); if (btn) btn.style.pointerEvents = ''; }
}

/* ============================================================
   STEP 2b — Join with a code
   ============================================================ */
function buildJoinScreen() {
  const s = mount('screen-join', `
    <div class="center-stack">
      <div class="reveal-up d1" style="text-align:center;">
        <div class="eyebrow" style="margin-bottom:10px;">Join a room</div>
        <h1 class="title" style="font-size:2.6rem;">Enter the code</h1>
      </div>
      <p class="tagline reveal-up d2" style="font-size:1.05rem;">Ask your partner for the 5-letter<br/>code they got after creating the room.</p>

      <input id="codeInput" class="code-input reveal-up d3" maxlength="5" placeholder="• • • • •" autocomplete="off" />

      <div class="reveal-up d4"><button class="btn btn-glow" id="joinBtn" disabled>Join Room 💞</button></div>
      <button class="link-btn reveal-up d5" id="backChoose">← back</button>
    </div>
  `);

  const codeInput = $('#codeInput', s), joinBtn = $('#joinBtn', s);
  setTimeout(() => codeInput.focus(), 200);
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    joinBtn.disabled = codeInput.value.length < 4;
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click(); });

  joinBtn.addEventListener('click', async () => {
    if (joinBtn.disabled) return;
    joinBtn.disabled = true;
    try {
      const r = await api('join', { code: codeInput.value.trim(), name: state.me.name, avatar: state.me.avatar });
      state.code = r.roomCode; state.role = 'guest'; partnerFrom(r.view);
      saveSession();
      buildLobby(); showScreen('screen-lobby');
    } catch (e) { toast(netMessage(e)); joinBtn.disabled = false; }
  });

  $('#backChoose', s).addEventListener('click', () => { buildChooseScreen(); showScreen('screen-choose'); });
}

/* ============================================================
   STEP 3 — Lobby
   ============================================================ */
function buildLobby() {
  const isHost = state.role === 'host';
  const me = state.me;
  const s = mount('screen-lobby', `
    <div class="center-stack compact">
      <div class="eyebrow reveal-up d1">Your Room</div>

      <div class="bond reveal-up d1">
        <div class="person"><div class="big-av">${avatarImg(me.avatar)}</div><div class="pn">${esc(me.name)}</div></div>
        <div class="link-line"></div>
        <div class="person"><div class="big-av" id="partnerAv" style="opacity:.4;">💗</div><div class="pn" id="partnerName" style="color:var(--ink-faint);">…</div></div>
      </div>

      <div class="room-code-box reveal-up d2">
        <div class="rc-label">Share this code</div>
        <div class="room-code">${esc(state.code)}</div>
        <button class="copy-code" id="copyCode">Copy code</button>
      </div>

      <div class="lobby-status reveal-up d3" id="lobbyStatus"><span class="status-dot"></span> <span class="lobby-text">…</span></div>

      <p class="tagline reveal-up d4" style="font-size:1rem;">${isHost
        ? 'Send this code to your partner. You can each answer on your own phone — no need to be together.'
        : 'You’re in! You can each answer on your own phone, whenever you like.'}</p>

      <div class="reveal-up d5"><button class="btn btn-glow" id="beginBtn">Start Answering 💞</button></div>
    </div>
  `);

  $('#copyCode', s).addEventListener('click', () => {
    const btn = $('#copyCode', s);
    copyText(state.code, () => { btn.textContent = 'Copied 💗'; btn.classList.add('copied'); toast('Code copied 💗'); setTimeout(() => { btn.textContent = 'Copy code'; btn.classList.remove('copied'); }, 1800); });
  });

  $('#beginBtn', s).addEventListener('click', () => { stopPoll(); state.scene = 0; buildQuizScreen(); showScreen('screen-quiz'); renderScene(); });

  const setStatus = () => {
    const el = $('#lobbyStatus', s); if (!el) return;
    const txt = $('.lobby-text', el), pav = $('#partnerAv', s), pnm = $('#partnerName', s);
    if (state.partner && state.partner.name) {
      el.className = 'lobby-status joined reveal-up d3';
      txt.textContent = `${state.partner.name} has joined 💗`;
      if (pav) { pav.innerHTML = avatarImg(state.partner.avatar); pav.style.opacity = '1'; }
      if (pnm) { pnm.textContent = state.partner.name; pnm.style.color = 'var(--wine)'; }
    } else if (isHost) {
      el.className = 'lobby-status live reveal-up d3';
      txt.textContent = 'Waiting for your partner to join…';
      if (pnm) pnm.textContent = 'Waiting…';
    } else {
      el.className = 'lobby-status joined reveal-up d3';
      txt.textContent = 'Connected 💗';
    }
  };
  setStatus();
  startPoll(async () => { try { const r = await api('status', { code: state.code }); partnerFrom(r.view); setStatus(); } catch (e) {} });
}

/* ============================================================
   STEP 4 — Quiz
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
  attachTilt($('#sceneCard', s), 4);
}

function updateProgress(s, idx) {
  const pct = Math.round((idx / SCENARIOS.length) * 100);
  $('#qcount', s).textContent = `Universe ${idx + 1} of ${SCENARIOS.length}`;
  $('#qpct', s).textContent = pct + '%';
  $('#qfill', s).style.width = pct + '%';
  s.querySelectorAll('.constellation .node').forEach((n, i) => { n.classList.toggle('done', i < idx); n.classList.toggle('current', i === idx); });
}

function renderScene() {
  const s = document.getElementById('screen-quiz');
  const card = $('#sceneCard', s);
  const sc = SCENARIOS[state.scene];

  updateProgress(s, state.scene);
  const saved = state.answers[state.scene] || {};
  const cur = { self: (typeof saved.self === 'number' ? saved.self : null), predict: (typeof saved.predict === 'number' ? saved.predict : null) };
  const isLast = state.scene === SCENARIOS.length - 1;

  const optList = (g) => sc.options.map((o, i) => `<button class="opt${cur[g] === i ? ' sel' : ''}" data-group="${g}" data-i="${i}">${esc(o)}</button>`).join('');

  card.style.transform = '';
  card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
  card.innerHTML = `
    <span class="scene-emoji">${SCENE_EMOJI[state.scene]}</span>
    <div class="scene-name">${esc(sc.name)}</div>
    <div class="scene-desc">"${esc(sc.desc)}"</div>

    <div class="q-block">
      <span class="q-tag">Your answer</span>
      <div class="q-text">${esc(sc.self)}</div>
      <div class="opts">${optList('self')}</div>
    </div>

    <div class="q-block">
      <span class="q-tag predict">Guess ${partnerLabel()}</span>
      <div class="q-text">${esc(sc.predict)}</div>
      <div class="opts">${optList('predict')}</div>
    </div>

    <div class="scene-nav">
      ${state.scene > 0 ? '<button class="btn btn-soft" id="prevBtn">←</button>' : ''}
      <button class="btn" id="nextBtn" disabled>${isLast ? 'See Our Result 💞' : 'Next →'}</button>
    </div>
  `;

  const nextBtn = $('#nextBtn', card);
  const refresh = () => { nextBtn.disabled = (cur.self === null || cur.predict === null); };
  refresh();

  card.querySelectorAll('.opt').forEach(btn => btn.addEventListener('click', () => {
    const g = btn.dataset.group, i = +btn.dataset.i;
    cur[g] = i;
    card.querySelectorAll(`.opt[data-group="${g}"]`).forEach(b => b.classList.toggle('sel', +b.dataset.i === i));
    state.answers[state.scene] = { self: cur.self, predict: cur.predict };
    saveSession();
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
    refresh();
  }));

  const prev = $('#prevBtn', card);
  if (prev) prev.addEventListener('click', () => { state.scene--; renderScene(); });

  nextBtn.addEventListener('click', () => {
    if (nextBtn.disabled) return;
    state.answers[state.scene] = { self: cur.self, predict: cur.predict };
    saveSession();
    updateProgress(s, state.scene + 1);
    if (!isLast) { state.scene++; saveSession(); setTimeout(renderScene, 130); return; }
    buildWaitScreen(); showScreen('screen-wait'); submitAndWait();
  });
}

/* ============================================================
   STEP 5 — Waiting
   ============================================================ */
function buildWaitScreen() {
  mount('screen-wait', `
    <div class="heart-loader reveal-up d1">
      <div class="ring"></div><div class="ring r2"></div>
      <div class="h">💗</div>
    </div>
    <div class="wait-text reveal-up d2" id="waitText">Your answers are sealed 💌</div>
    <div class="wait-sub reveal-up d3" id="waitSub">Sending across to your partner…</div>
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
      state.submitted = true; partnerFrom(r.view); saveSession();
      if (r.view.ready) { finishWithResult(r.view.result); return; }
    } catch (e) {
      if (attempt === 2) setWait('The connection wavered…', 'Trying again');
      await new Promise(res => setTimeout(res, 1200));
    }
  }
  startPoll(async () => {
    try {
      const r = await api('status', { code: state.code });
      const partner = partnerFrom(r.view);
      if (r.view.ready && r.view.result) { finishWithResult(r.view.result); return; }
      if (r.view.computing) setWait('Reading your hearts…', 'Almost there');
      else if (!partner) setWait('Waiting for your partner to join…', `Your code: ${state.code}`);
      else if (!r.view[state.role === 'host' ? 'guest' : 'host'].submitted) setWait(`Waiting for ${partnerLabel()} to finish…`, 'They’re still answering');
      else setWait('Bringing you together…', 'Almost there');
    } catch (e) {}
  }, 2500);
}

function finishWithResult(result) {
  stopPoll();
  state.result = normalizeResult(result);
  buildRevealScreen(); showScreen('screen-reveal'); runRevealSequence();
}

function normalizeResult(r) {
  let score = Number(r && r.score);
  if (!isFinite(score)) score = 5;
  score = Math.max(0, Math.min(10, score));
  let synced = Array.isArray(r && r.syncedUniverses) ? r.syncedUniverses.slice(0, 2) : [];
  while (synced.length < 2) synced.push(SCENARIOS[synced.length].name);
  return {
    score: Math.round(score * 10) / 10,
    verdict: String((r && r.verdict) || "").trim() || "Two hearts, learning each other a little more with every answer.",
    syncedUniverses: synced,
    lostUniverse: String((r && r.lostUniverse) || SCENARIOS[SCENARIOS.length - 1].name).trim(),
    closingLine: String((r && r.closingLine) || "").trim() || "You keep finding your way back to each other.",
    details: Array.isArray(r && r.details) ? r.details : []
  };
}

/* ============================================================
   STEP 6 — Reveal
   ============================================================ */
function buildRevealScreen() {
  const me = state.me;
  const partner = state.partner || { name: 'Your partner', avatar: 'partner' };
  const s = mount('screen-reveal', `
    <div class="eyebrow reveal-up d1" style="margin-bottom:14px;">Your Result</div>

    <div class="bond reveal-up d1">
      <div class="person"><div class="big-av">${avatarImg(me.avatar)}</div><div class="pn">${esc(me.name)}</div></div>
      <div class="link-line"></div>
      <div class="person"><div class="big-av">${avatarImg(partner.avatar)}</div><div class="pn">${esc(partner.name)}</div></div>
    </div>

    <div class="score-zone reveal-up d2">
      <div class="score-ring" id="scoreRing">
        <div class="score-inner">
          <div><span class="score-num" id="scoreNum">0</span><span class="score-den">/10</span></div>
          <div class="score-cap">How well you know each other</div>
        </div>
      </div>
    </div>

    <div class="verdict-card reveal-up d3"><div class="verdict-text" id="verdictText"></div></div>
    <div class="uni-section" id="uniSection"></div>
    <div class="closing-line" id="closingLine">"${esc(state.result.closingLine)}"</div>

    <div id="detailSection"></div>

    <div class="reveal-actions" id="revealActions">
      <button class="btn" id="shareBtn">Share Our Result 💞</button>
      <button class="btn btn-soft" id="playAgainBtn">Play Again</button>
    </div>
    <div class="footnote" style="margin-top:18px;">Developed with 💗 by Benazir</div>
  `);
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
  setTimeout(() => buildDetailRows(r), verdictMs + 1900);
  setTimeout(() => $('#revealActions', s).classList.add('show'), verdictMs + 2900);
}

/* Side-by-side: what you answered vs what your partner answered. */
function buildDetailRows(r) {
  const wrap = document.getElementById('detailSection');
  if (!wrap || !r.details || !r.details.length) return;
  const meKey = state.role === 'host' ? 'host' : 'guest';
  const otherKey = meKey === 'host' ? 'guest' : 'host';
  const pname = esc(state.partner && state.partner.name ? state.partner.name : 'Them');
  let html = '<div class="detail-heading">Side by side 💞</div>';
  r.details.forEach((d, i) => {
    const mine = d[meKey] || {}, theirs = d[otherKey] || {};
    const myGuessRight = (meKey === 'host') ? d.hostRight : d.guestRight;
    html += `
      <div class="detail">
        <div class="d-head"><span class="d-emoji">${SCENE_EMOJI[i] || '✨'}</span><span class="d-name">${esc(d.name)}</span>${d.same ? '<span class="d-match">matched 💞</span>' : ''}</div>
        <div class="d-row"><span class="who">You</span><span class="ans">${esc(mine.self)}</span></div>
        <div class="d-row"><span class="who">${pname}</span><span class="ans">${esc(theirs.self)}</span></div>
        <div class="d-guess">You guessed they'd pick "${esc(mine.predict)}" — ${myGuessRight ? '<b class="ok">spot on ✓</b>' : '<b class="no">not quite ✗</b>'}</div>
      </div>`;
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll('.detail').forEach((el, i) => {
    el.style.opacity = 0; el.style.transform = 'translateY(10px)';
    setTimeout(() => { el.style.transition = 'opacity .5s, transform .5s'; el.style.opacity = 1; el.style.transform = 'none'; }, 200 + i * 90);
  });
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
  el.innerHTML = cursor; let i = 0;
  (function step() { i++; el.innerHTML = esc(text.slice(0, i)) + cursor; if (i < text.length) setTimeout(step, 22); else setTimeout(() => { el.innerHTML = esc(text); }, 600); })();
}

function buildUniverseRows(r) {
  const wrap = document.getElementById('uniSection');
  if (!wrap) return;
  const rows = [];
  r.syncedUniverses.forEach(name => rows.push(`<div class="uni-row synced"><span class="ico">💞</span><div class="uni-meta"><div class="ul">Totally in sync</div><div class="un">${esc(name)}</div></div></div>`));
  rows.push(`<div class="uni-row lost"><span class="ico">🤔</span><div class="uni-meta"><div class="ul">Still learning here</div><div class="un">${esc(r.lostUniverse)}</div></div></div>`);
  wrap.innerHTML = rows.join('');
  wrap.querySelectorAll('.uni-row').forEach((row, i) => setTimeout(() => row.classList.add('show'), i * 480));
}

/* ---------- Share ---------- */
function shareResult() {
  const r = state.result, me = state.me, partner = state.partner || { name: 'Partner' };
  const text = `💞 SoulSync 💞\n${me.name} & ${partner.name}\nWe know each other ${r.score}/10\n\n"${r.closingLine}"`;
  const done = () => toast('Copied 💗');
  if (navigator.share) navigator.share({ title: 'SoulSync', text }).catch(() => copyText(text, done));
  else copyText(text, done);
}
function copyText(text, cb) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(cb).catch(() => legacyCopy(text, cb));
  else legacyCopy(text, cb);
}
function legacyCopy(text, cb) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); cb(); } catch (e) { toast('Could not copy'); }
  document.body.removeChild(ta);
}

/* ---------- Reset ---------- */
function resetAll() {
  stopPoll();
  clearSession();
  const keep = state.me.avatar;
  state.me = { name: "", avatar: keep };
  state.partner = null; state.code = ""; state.role = ""; state.scene = 0; state.answers = []; state.submitted = false; state.result = null;
  buildNameScreen(); showScreen('screen-name');
}

/* ============================================================
   Floating petals background + reveal confetti
   ============================================================ */
const petalCanvas = document.getElementById('starfield');
const pctx = petalCanvas.getContext('2d');
let dots = [], blobs = [], DPR = Math.min(window.devicePixelRatio || 1, 2);
let pointer = { x: 0, y: 0, tx: 0, ty: 0 };
const ROSE = '226,109,138', GOLD = '224,169,109', PEACH = '244,169,189';

function sizeCanvas(cv) { cv.width = window.innerWidth * DPR; cv.height = window.innerHeight * DPR; cv.style.width = window.innerWidth + 'px'; cv.style.height = window.innerHeight + 'px'; }
function initPetals() {
  sizeCanvas(petalCanvas);
  const W = petalCanvas.width, H = petalCanvas.height;
  const count = Math.floor((W * H) / (14000 * DPR));
  dots = [];
  for (let i = 0; i < count; i++) {
    const r = (Math.random() * 1.6 + 0.5) * DPR;
    dots.push({ x: Math.random() * W, y: Math.random() * H, r, vy: -(Math.random() * 0.18 + 0.04) * DPR, vx: (Math.random() - 0.5) * 0.08 * DPR, tw: Math.random() * Math.PI * 2, tws: Math.random() * 0.03 + 0.008, a: Math.random() * 0.35 + 0.1, col: Math.random() < 0.5 ? ROSE : (Math.random() < 0.5 ? GOLD : PEACH), depth: r / (2.1 * DPR) });
  }
  blobs = [];
  const bcount = Math.floor(count / 8);
  for (let i = 0; i < bcount; i++) blobs.push({ x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 5 + 3) * DPR, vy: -(Math.random() * 0.16 + 0.04) * DPR, vx: (Math.random() - 0.5) * 0.06 * DPR, a: Math.random() * 0.12 + 0.05, col: Math.random() < 0.5 ? PEACH : GOLD });
}
function drawPetals() {
  const W = petalCanvas.width, H = petalCanvas.height;
  pctx.clearRect(0, 0, W, H);
  pointer.x += (pointer.tx - pointer.x) * 0.05; pointer.y += (pointer.ty - pointer.y) * 0.05;
  const par = 22 * DPR;

  for (const b of blobs) {
    b.x += b.vx; b.y += b.vy;
    if (b.y < -20) { b.y = H + 20; b.x = Math.random() * W; }
    const grad = pctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * 4);
    grad.addColorStop(0, `rgba(${b.col},${b.a})`); grad.addColorStop(1, `rgba(${b.col},0)`);
    pctx.fillStyle = grad; pctx.beginPath(); pctx.arc(b.x, b.y, b.r * 4, 0, Math.PI * 2); pctx.fill();
  }
  for (const d of dots) {
    d.x += d.vx; d.y += d.vy; d.tw += d.tws;
    if (d.y < -10) { d.y = H + 10; d.x = Math.random() * W; }
    if (d.x < -10) d.x = W + 10; if (d.x > W + 10) d.x = -10;
    const a = d.a + Math.sin(d.tw) * 0.12;
    pctx.beginPath();
    pctx.arc(d.x + pointer.x * par * d.depth, d.y + pointer.y * par * d.depth, d.r, 0, Math.PI * 2);
    pctx.fillStyle = `rgba(${d.col},${Math.max(0, a)})`; pctx.fill();
  }
  requestAnimationFrame(drawPetals);
}

const fxCanvas = document.getElementById('fx');
const fctx = fxCanvas.getContext('2d');
let bursts = [], fxRunning = false;
function particleExplosion(scale = 1) {
  sizeCanvas(fxCanvas);
  const cx = fxCanvas.width / 2, cy = fxCanvas.height * 0.34, N = Math.round(90 * scale);
  for (let i = 0; i < N; i++) {
    const ang = Math.random() * Math.PI * 2, sp = (Math.random() * 6 + 2) * DPR * scale;
    bursts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1 * DPR, r: (Math.random() * 2.5 + 1) * DPR, life: 1, decay: Math.random() * 0.012 + 0.006, col: Math.random() < 0.55 ? ROSE : GOLD });
  }
  setTimeout(() => secondaryBurst(cx - 60 * DPR, cy + 24 * DPR, scale), 220);
  setTimeout(() => secondaryBurst(cx + 60 * DPR, cy + 24 * DPR, scale), 380);
  if (!fxRunning) { fxRunning = true; runFx(); }
}
function secondaryBurst(x, y, scale) {
  for (let i = 0; i < Math.round(38 * scale); i++) {
    const ang = Math.random() * Math.PI * 2, sp = (Math.random() * 4 + 1.5) * DPR;
    bursts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.8 * DPR, r: (Math.random() * 2 + 0.8) * DPR, life: 1, decay: Math.random() * 0.014 + 0.008, col: Math.random() < 0.5 ? ROSE : PEACH });
  }
}
function runFx() {
  fctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  for (let i = bursts.length - 1; i >= 0; i--) {
    const p = bursts[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.05 * DPR; p.vx *= 0.99; p.life -= p.decay;
    if (p.life <= 0) { bursts.splice(i, 1); continue; }
    fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    fctx.fillStyle = `rgba(${p.col},${p.life})`; fctx.shadowBlur = 10; fctx.shadowColor = `rgba(${p.col},${p.life})`; fctx.fill();
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
window.addEventListener('resize', () => initPetals());

/* ============================================================
   Ambient music (soft warm pad)
   ============================================================ */
let audioCtx = null, musicNodes = [], musicOn = false, musicArmed = false;
const musicBtn = document.getElementById('musicBtn');
function buildMusic() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const master = audioCtx.createGain(); master.gain.value = 0; master.connect(audioCtx.destination);
  const freqs = [130.81, 196.0, 261.63, 329.63]; // C3 G3 C4 E4 — warm, major
  const padGain = audioCtx.createGain(); padGain.gain.value = 0.17; padGain.connect(master);
  freqs.forEach((f, idx) => {
    const osc = audioCtx.createOscillator(); osc.type = idx % 2 === 0 ? 'sine' : 'triangle'; osc.frequency.value = f;
    const g = audioCtx.createGain(); g.gain.value = 0.25 / freqs.length;
    const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.05 + idx * 0.012;
    const lfoGain = audioCtx.createGain(); lfoGain.gain.value = 1.4;
    lfo.connect(lfoGain); lfoGain.connect(osc.detune);
    osc.connect(g); g.connect(padGain); osc.start(); lfo.start();
    musicNodes.push(osc, lfo);
  });
  musicNodes.master = master;
}
function startMusicIfArmed() { if (musicArmed && !musicOn) toggleMusic(true); }
function toggleMusic(force) {
  const want = (typeof force === 'boolean') ? force : !musicOn;
  if (want) {
    if (!audioCtx) buildMusic();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    musicNodes.master.gain.cancelScheduledValues(now); musicNodes.master.gain.setValueAtTime(musicNodes.master.gain.value, now);
    musicNodes.master.gain.linearRampToValueAtTime(0.45, now + 2);
    musicOn = true; musicArmed = true; musicBtn.classList.add('on');
  } else {
    if (audioCtx && musicNodes.master) {
      const now = audioCtx.currentTime;
      musicNodes.master.gain.cancelScheduledValues(now); musicNodes.master.gain.setValueAtTime(musicNodes.master.gain.value, now);
      musicNodes.master.gain.linearRampToValueAtTime(0, now + 1);
    }
    musicOn = false; musicBtn.classList.remove('on');
  }
}
musicBtn.addEventListener('click', () => { musicArmed = true; toggleMusic(); });

/* ============================================================
   Boot
   ============================================================ */
/* Try to restore a saved session after a refresh. Returns true if it resumed. */
async function tryRestore(saved) {
  try {
    const r = await api('status', { code: saved.code });   // throws if the room is gone
    state.me = saved.me; state.code = saved.code; state.role = saved.role;
    state.answers = Array.isArray(saved.answers) ? saved.answers : [];
    state.scene = saved.scene || 0; state.submitted = !!saved.submitted;
    partnerFrom(r.view);

    if (r.view.ready && r.view.result) { finishWithResult(r.view.result); return true; }
    if (state.submitted) { buildWaitScreen(); showScreen('screen-wait'); submitAndWait(); return true; }
    if (state.answers.filter(Boolean).length > 0) { buildQuizScreen(); showScreen('screen-quiz'); renderScene(); return true; }
    buildLobby(); showScreen('screen-lobby'); return true;
  } catch (e) {
    clearSession();
    return false;
  }
}

async function init() {
  initPetals(); drawPetals();
  const saved = loadSession();
  state.me.avatar = (saved && saved.me && saved.me.avatar) ? saved.me.avatar : newSeed();
  if (saved && saved.code && saved.role && saved.me && saved.me.name) {
    if (await tryRestore(saved)) return;
  }
  buildNameScreen(); showScreen('screen-name');
}
init();
