/* ============================================================
   Soulstice — cross-device room function (Netlify Function)

   One endpoint, action-based. Stores each game in Netlify Blobs
   keyed by a short room code, so two phones can play separately:

     create  → host makes a room, gets a code
     join    → guest joins with the code
     submit  → a player sends their 10 answers
     status  → either phone polls; when BOTH have submitted, the
               reading is computed server-side (Claude) and returned

   The Anthropic key is read from process.env.ANTHROPIC_API_KEY
   (Netlify dashboard) and never leaves the server. Raw answers
   stay server-side too — status only returns names, submitted
   flags, and the final reading.
   ============================================================ */

import { getStore } from "@netlify/blobs";

const MODEL = "claude-sonnet-4-6";
const STORE = "soulstice-rooms";
const MAX_ANSWER_LEN = 800;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const CODE_LEN = 5;

/* Scenario text lives here so the prompt is built authoritatively
   server-side. Must stay in sync with app.js SCENARIOS order. */
const SCENARIOS = [
  { name: "The Signal", desc: "You're both stranded on different planets. You sent an important transmission. They received it. It's been 3 hours. No reply.", self: "What are you doing right now?", predict: "What are THEY doing right now?", options: ["😤 Drafted four follow-ups and deleted them all", "😌 Completely unbothered — they'll reply when they reply", "📡 Already tried calling. Twice.", "🕵️ Checking their last active signal to see if they're online"] },
  { name: "The Wrong Turn", desc: "You're both in a spaceship. Navigation says go right. Your gut says left. You went left. Now you're completely lost in deep space.", self: "What happens next?", predict: "How did THEY react?", options: ["😶 Complete silence. Both staring at the controls.", "😂 Already laughing about it", "🗣️ \"I literally told you.\"", "🔄 Pretending to recalculate like it was the plan all along"] },
  { name: "The Contraband", desc: "You smuggled something unnecessary onto the ship. They found it in the cargo bay.", self: "Your move?", predict: "What's THEIR move?", options: ["🙈 \"I've had this since before the mission, what are you talking about\"", "💸 Immediately justify it with a 5-point argument", "😇 Come clean immediately — I cannot lie to save my life", "🛒 \"Okay but also look what THEY smuggled last week\""] },
  { name: "The Unfinished Argument", desc: "You both went into cryo-sleep mid-argument. You just woke up. 10 years later. They're looking at you.", self: "What do you do?", predict: "What do THEY do?", options: ["😤 Pick up exactly where we left off", "😂 Laugh. We really did that.", "😶 Pretend it never happened", "💬 \"So... do you want to talk about it?\""] },
  { name: "The Repeat", desc: "You've explained the mission plan three times already. They just commed you asking the same question again.", self: "What do you do?", predict: "What do THEY do?", options: ["😤 Answer — but they're absolutely hearing about this later", "😂 Laugh, because at this point it's just funny", "😶 Answer calmly. Deep breaths. It's fine.", "📡 Send them the recording of the last three times"] },
  { name: "The Mood", desc: "Something is clearly wrong with them. The whole ship can feel it. You asked. They said fine. It is not fine.", self: "What do you do?", predict: "What do THEY do?", options: ["🫂 Ask again. I'm not leaving it at 'fine'.", "😶 Respect it. They'll talk when they're ready.", "😤 Fine. If they're fine, then I'm fine.", "💬 Don't ask again, but stay close just in case"] },
  { name: "The Eavesdrop", desc: "You weren't meant to hear what they said about you to someone else on the crew. But you did. They have no idea.", self: "What do you do?", predict: "What do THEY do?", options: ["😶 Pretend I heard nothing. Carry on.", "💬 Bring it up directly. Right now.", "🤐 Hold it in. Let it quietly eat me alive.", "😏 Start acting slightly different and wait for them to notice"] },
  { name: "Actually, Never Mind", desc: "You're in different galaxies. They sent: \"we need to talk.\" You've been spiralling for 20 minutes. Next message: \"actually never mind.\"", self: "What do you do?", predict: "What do THEY do?", options: ["😤 \"No. We're talking. Right now.\"", "😶 Pretend I'm fine. Internally on fire.", "😂 Laugh it off — but bring it up again later", "🚀 Go silent and wait for them to come to me"] },
  { name: "The Public Correction", desc: "You're both delegates at an intergalactic council. You said something. They corrected you in front of every alien species in the room. The chamber went silent.", self: "What happens next?", predict: "How do THEY react?", options: ["😤 I correct their correction. Immediately.", "😶 Smile and die a little inside", "😂 Laugh it off — but we are discussing this later", "🗣️ Call it out right there. In front of everyone."] },
  { name: "The Hologram", desc: "You're telling them something important via hologram. You can see they're distracted. You're still talking.", self: "What do you do?", predict: "What do THEY do?", options: ["😤 Stop transmitting completely and wait", "😶 Finish the story to nobody", "🗣️ \"Are you even listening to me?\"", "📡 Go offline. Two can play."] }
];

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    verdict: { type: "string" },
    syncedUniverses: { type: "array", items: { type: "string" } },
    lostUniverse: { type: "string" },
    closingLine: { type: "string" }
  },
  required: ["score", "verdict", "syncedUniverses", "lostUniverse", "closingLine"],
  additionalProperties: false
};

/* Use Netlify Blobs in production. In local `netlify dev` without a linked
   site, Blobs isn't configured — fall back to an in-memory store so local
   testing works. (The dev function process persists between requests, so a
   room created in one tab is visible to another during the session.) */
let __memStore = null;
let BLOBS_OK = false;
function roomStore() {
  try {
    const s = getStore(STORE);
    BLOBS_OK = true;
    return s;
  } catch (e) {
    BLOBS_OK = false;
    if (!__memStore) {
      const m = new Map();
      __memStore = {
        async get(key, opts) {
          if (!m.has(key)) return null;
          const v = m.get(key);
          return (opts && opts.type === "json") ? JSON.parse(JSON.stringify(v)) : v;
        },
        async setJSON(key, val) { m.set(key, JSON.parse(JSON.stringify(val))); }
      };
    }
    return __memStore;
  }
}

const clamp = (s) => String(s == null ? "" : s).slice(0, MAX_ANSWER_LEN);
const cleanName = (s) => String(s == null ? "" : s).trim().slice(0, 24);
const cleanAvatar = (s) => String(s == null ? "" : s).slice(0, 40) || "soul";

function makeCode() {
  let c = "";
  for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}

/* Normalize a submitted answers array to exactly SCENARIOS.length items.
   Answers are option indices (0-3) or null. */
function normAnswers(arr) {
  const out = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const a = (Array.isArray(arr) && arr[i]) || {};
    const n = SCENARIOS[i].options.length;
    const idx = (v) => { const x = Number(v); return Number.isInteger(x) && x >= 0 && x < n ? x : null; };
    out.push({ self: idx(a.self), predict: idx(a.predict) });
  }
  return out;
}

/* Public view of a room — never leaks raw answers. */
function publicView(room) {
  return {
    code: room.code,
    host: room.host ? { name: room.host.name, avatar: room.host.avatar, submitted: !!room.host.submitted } : null,
    guest: room.guest ? { name: room.guest.name, avatar: room.guest.avatar, submitted: !!room.guest.submitted } : null,
    bothJoined: !!(room.host && room.guest),
    bothSubmitted: !!(room.host && room.host.submitted && room.guest && room.guest.submitted),
    ready: !!room.result,
    computing: !!room.computing,
    result: room.result || null
  };
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Invalid JSON body" }); }

  const action = body.action;
  const store = roomStore();
  const h = event.headers || {};
  const origin = process.env.URL ||
    (((h['x-forwarded-proto'] || h['X-Forwarded-Proto'] || 'https')) + '://' + (h.host || h.Host || 'localhost:8888'));

  try {
    if (action === "create") {
      const name = cleanName(body.name);
      const avatar = cleanAvatar(body.avatar);
      if (!name) return json(400, { error: "A name is required" });

      let code = "";
      for (let attempt = 0; attempt < 6; attempt++) {
        const c = makeCode();
        const existing = await store.get(c, { type: "json" });
        if (!existing) { code = c; break; }
      }
      if (!code) return json(503, { error: "Could not allocate a room code, try again" });

      const room = {
        code,
        createdAt: Date.now(),
        host: { name, avatar, submitted: false, answers: null },
        guest: null,
        result: null,
        computing: false
      };
      await store.setJSON(code, room);
      return json(200, { roomCode: code, role: "host", view: publicView(room) });
    }

    if (action === "join") {
      const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
      const name = cleanName(body.name);
      const avatar = cleanAvatar(body.avatar);
      if (!name) return json(400, { error: "A name is required" });
      const room = await store.get(code, { type: "json" });
      if (!room) return json(404, { error: "No room found with that code" });
      if (room.guest) return json(409, { error: "That room is already full" });
      room.guest = { name, avatar, submitted: false, answers: null };
      await store.setJSON(code, room);
      return json(200, { roomCode: code, role: "guest", view: publicView(room) });
    }

    if (action === "submit") {
      const code = String(body.code || "").toUpperCase().slice(0, CODE_LEN);
      const role = body.role === "guest" ? "guest" : "host";
      const room = await store.get(code, { type: "json" });
      if (!room) return json(404, { error: "Room not found" });
      if (!room[role]) return json(400, { error: "You are not part of this room" });

      room[role].answers = normAnswers(body.answers);
      room[role].submitted = true;
      await store.setJSON(code, room);

      // If this was the last submission, kick off the reading.
      await ensureCompute(code, origin);

      const fresh = await store.get(code, { type: "json" });
      return json(200, { ok: true, view: publicView(fresh || room) });
    }

    if (action === "status") {
      const code = String(body.code || "").toUpperCase().slice(0, CODE_LEN);
      let room = await store.get(code, { type: "json" });
      if (!room) return json(404, { error: "Room not found" });

      // Make sure a compute is in flight (covers a missed/failed trigger).
      if (room.host && room.host.submitted && room.guest && room.guest.submitted && !room.result) {
        await ensureCompute(code, origin);
        room = await store.get(code, { type: "json" }) || room;
      }
      return json(200, { view: publicView(room) });
    }

    return json(400, { error: "Unknown action" });
  } catch (e) {
    return json(500, { error: "Server error", detail: String(e).slice(0, 200) });
  }
};

/* Trigger the reading once both players have submitted. On production
   (Netlify Blobs available) the slow Claude call runs in a BACKGROUND
   function so it isn't killed by the 10s sync-function timeout. Locally
   (in-memory store, no shared background process) it runs inline. */
async function ensureCompute(code, origin) {
  const store = roomStore();
  const room = await store.get(code, { type: "json" });
  if (!room) return;
  if (room.result) return;
  if (!(room.host && room.host.submitted && room.guest && room.guest.submitted)) return;
  const inFlight = room.computing && room.computeStartedAt && (Date.now() - room.computeStartedAt < 15000);
  if (inFlight) return;

  room.computing = true;
  room.computeStartedAt = Date.now();
  await store.setJSON(code, room);

  if (BLOBS_OK) {
    try {
      await fetch(`${origin}/.netlify/functions/compute-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(4000)
      });
    } catch (e) {
      // Hand-off failed — last resort, run it inline.
      try { await runComputeForRoom(code); } catch (e2) {}
    }
  } else {
    await runComputeForRoom(code);
  }
}

/* The heavy lifting: call Claude (or fall back) and store the result.
   Exported so the background function can run it. */
export async function runComputeForRoom(code) {
  const store = roomStore();
  const room = await store.get(code, { type: "json" });
  if (!room || room.result) return;
  let result;
  try { result = await claudeReading(room); }
  catch (e) { result = localReading(room); }
  result.details = buildDetails(room);
  const latest = await store.get(code, { type: "json" }) || room;
  latest.result = result;
  latest.computing = false;
  latest.computedAt = Date.now();
  await store.setJSON(code, latest);
}

function buildPrompt(room) {
  const A = room.host, B = room.guest;
  const opt = (sc, i) => (i == null || !sc.options[i]) ? "(no answer)" : sc.options[i];
  const lines = [];
  SCENARIOS.forEach((sc, i) => {
    const a = (A.answers && A.answers[i]) || {};
    const b = (B.answers && B.answers[i]) || {};
    const aligned = a.self != null && a.self === b.self;
    const aRight = a.predict != null && a.predict === b.self;
    const bRight = b.predict != null && b.predict === a.self;
    lines.push(`QUESTION ${i + 1} — "${sc.name}": ${sc.desc}`);
    lines.push(`  Prompt: ${sc.self}`);
    lines.push(`  Options: ${sc.options.map((o, k) => `(${k + 1}) ${o}`).join("   ")}`);
    lines.push(`  ${A.name} chose: "${opt(sc, a.self)}"`);
    lines.push(`  ${B.name} chose: "${opt(sc, b.self)}"`);
    lines.push(`  → Same answer? ${aligned ? "YES" : "no"}`);
    lines.push(`  ${A.name} guessed ${B.name} would pick "${opt(sc, a.predict)}" — ${aRight ? "CORRECT" : "missed"}`);
    lines.push(`  ${B.name} guessed ${A.name} would pick "${opt(sc, b.predict)}" — ${bRight ? "CORRECT" : "missed"}`);
    lines.push("");
  });
  return `You are the Oracle of Soulstice — a poetic, emotionally intelligent reader of human bonds across the multiverse.

${A.name} and ${B.name} just took a ${SCENARIOS.length}-question couple test. For each question, both chose from the SAME four answers: once honestly for themselves, and once guessing what their partner picked. Compatibility lives in two things — how well each GUESSED the other (how truly they know each other), and how often they happened to choose the SAME answer (shared tastes and values).

Here is everything they revealed:

${lines.join("\n")}

Your task — weigh both how well they guessed each other and how aligned their own answers were across all ${SCENARIOS.length} questions, then deliver a verdict:
1. A compatibility score out of 10 (may be a decimal like 7.5).
2. A warm, poetic verdict of around 100 words (about 4-5 sentences) — specific to the actual choices they made (reference a couple of their answers). Keep it flowing and emotional, not a dry list.
3. The EXACTLY TWO question titles where they were most in sync (matched answers and/or guessed each other right).
4. The EXACTLY ONE question title where they were most out of sync.
5. One beautiful closing line about their bond (a single sentence).

Use the EXACT question titles as written above (e.g. "The Perfect Date"). Address them by name where it lands emotionally.`;
}

async function claudeReading(room) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no-key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
      messages: [{ role: "user", content: buildPrompt(room) }]
    })
  });
  if (!res.ok) throw new Error("api-" + res.status);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("no-text");
  let parsed;
  try { parsed = JSON.parse(block.text); }
  catch (e) { const m = block.text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
  if (!parsed) throw new Error("parse");
  return normalizeResult(parsed);
}

/* Per-question breakdown so each player can see both answers afterwards. */
function buildDetails(room) {
  const A = room.host, B = room.guest;
  return SCENARIOS.map((sc, i) => {
    const a = (A.answers && A.answers[i]) || {}, b = (B.answers && B.answers[i]) || {};
    const t = (idx) => (idx == null || !sc.options[idx]) ? "—" : sc.options[idx];
    return {
      name: sc.name,
      host: { self: t(a.self), predict: t(a.predict) },
      guest: { self: t(b.self), predict: t(b.predict) },
      same: a.self != null && a.self === b.self,
      hostRight: a.predict != null && a.predict === b.self,
      guestRight: b.predict != null && b.predict === a.self
    };
  });
}

function normalizeResult(r) {
  let score = Number(r && r.score);
  if (!isFinite(score)) score = 5;
  score = Math.max(0, Math.min(10, score));
  let synced = Array.isArray(r && r.syncedUniverses) ? r.syncedUniverses.slice(0, 2) : [];
  while (synced.length < 2) synced.push(SCENARIOS[synced.length].name);
  return {
    score: Math.round(score * 10) / 10,
    verdict: String((r && r.verdict) || "").trim() || "Two travelers, many worlds, one quiet gravity pulling them together.",
    syncedUniverses: synced,
    lostUniverse: String((r && r.lostUniverse) || SCENARIOS[SCENARIOS.length - 1].name).trim(),
    closingLine: String((r && r.closingLine) || "").trim() || "Across every universe, you keep finding your way back to each other."
  };
}

/* Server-side fallback reading if Claude is unavailable. Index-based:
   score from how often they matched + how well they guessed each other. */
function localReading(room) {
  const A = room.host, B = room.guest;
  const scored = SCENARIOS.map((sc, i) => {
    const a = (A.answers && A.answers[i]) || {}, b = (B.answers && B.answers[i]) || {};
    let s = 0;
    if (a.self != null && a.self === b.self) s += 2;            // shared answer
    if (a.predict != null && a.predict === b.self) s += 1;      // A guessed B
    if (b.predict != null && b.predict === a.self) s += 1;      // B guessed A
    return { name: sc.name, score: s };                          // 0..4 per universe
  });
  const sorted = [...scored].sort((x, y) => y.score - x.score);
  const total = scored.reduce((s, x) => s + x.score, 0);
  const final = Math.max(1, Math.min(10, Math.round((1 + (total / (scored.length * 4)) * 9) * 10) / 10));
  return {
    score: final,
    verdict: `${A.name} and ${B.name}, across every impossible world your hearts kept reaching for the same things — and where they didn't, you were still reaching for each other. You are not two people who simply think alike, but two people whose differences orbit a shared centre of gravity. That, more than any perfect match, is what the universe calls a bond.`,
    syncedUniverses: [sorted[0].name, sorted[1].name],
    lostUniverse: sorted[sorted.length - 1].name,
    closingLine: `Across every universe, ${A.name} and ${B.name} keep falling toward the same quiet light.`
  };
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
