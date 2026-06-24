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
function roomStore() {
  try {
    return getStore(STORE);
  } catch (e) {
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

/* Normalize a submitted answers array to exactly SCENARIOS.length items. */
function normAnswers(arr) {
  const out = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const a = (Array.isArray(arr) && arr[i]) || {};
    out.push({ self: clamp(a.self), predict: clamp(a.predict) });
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

      // If this was the last submission, compute the reading now.
      await maybeCompute(store, code);

      const fresh = await store.get(code, { type: "json" });
      return json(200, { ok: true, view: publicView(fresh || room) });
    }

    if (action === "status") {
      const code = String(body.code || "").toUpperCase().slice(0, CODE_LEN);
      let room = await store.get(code, { type: "json" });
      if (!room) return json(404, { error: "Room not found" });

      // Fallback compute (covers the rare case where neither submit triggered it).
      if (room.host && room.host.submitted && room.guest && room.guest.submitted && !room.result && !room.computing) {
        await maybeCompute(store, code);
        room = await store.get(code, { type: "json" }) || room;
      }
      return json(200, { view: publicView(room) });
    }

    return json(400, { error: "Unknown action" });
  } catch (e) {
    return json(500, { error: "Server error", detail: String(e).slice(0, 200) });
  }
};

/* Compute the reading once both players have submitted. */
async function maybeCompute(store, code) {
  let room = await store.get(code, { type: "json" });
  if (!room) return;
  if (room.result || room.computing) return;
  if (!(room.host && room.host.submitted && room.guest && room.guest.submitted)) return;

  // claim
  room.computing = true;
  await store.setJSON(code, room);

  let result;
  try { result = await claudeReading(room); }
  catch (e) { console.error("[soulstice] claude failed:", e && (e.stack || e.message)); result = localReading(room); }

  const fresh = await store.get(code, { type: "json" }) || room;
  fresh.result = result;
  fresh.computing = false;
  fresh.computedAt = Date.now();
  await store.setJSON(code, fresh);
}

function buildPrompt(room) {
  const A = room.host, B = room.guest;
  const lines = [];
  SCENARIOS.forEach((sc, i) => {
    const a = (A.answers && A.answers[i]) || {};
    const b = (B.answers && B.answers[i]) || {};
    lines.push(`UNIVERSE ${i + 1}: "${sc.name}" — ${sc.desc}`);
    lines.push(`  Question (self): ${sc.self}`);
    lines.push(`  Question (predict partner): ${sc.predict}`);
    lines.push(`  ${A.name} answered about themselves: "${a.self || "(left blank)"}"`);
    lines.push(`  ${A.name} predicted ${B.name} would say: "${a.predict || "(left blank)"}"`);
    lines.push(`  ${B.name} answered about themselves: "${b.self || "(left blank)"}"`);
    lines.push(`  ${B.name} predicted ${A.name} would say: "${b.predict || "(left blank)"}"`);
    lines.push("");
  });
  return `You are the Oracle of Soulstice — a poetic, emotionally intelligent reader of human bonds across the multiverse.

Two souls, ${A.name} and ${B.name}, have travelled through ten alternate universes. In each, they answered a question about themselves AND predicted what their partner would say. Compatibility lives in how well their self-answers resonate with each other AND how accurately each predicted the other.

Here is everything they revealed:

${lines.join("\n")}

Your task — compare them universe by universe and deliver a verdict:
1. A compatibility score out of 10 (may be a decimal like 7.5). Base it on emotional resonance, shared values, humor alignment, and predictive accuracy across all ten universes.
2. A dramatic, emotional, poetic verdict (3-5 sentences) about their connection — warm, cinematic, specific to their actual answers.
3. The names of EXACTLY TWO universes where they were most perfectly in sync.
4. The name of EXACTLY ONE universe where they completely lost each other.
5. One beautiful closing line about their bond (a single sentence).

Use the EXACT universe names as written above (e.g. "The Lost Island"). Address them by name where it lands emotionally. Be specific to what they actually wrote.`;
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

/* Server-side fallback reading if Claude is unavailable. */
function localReading(room) {
  const A = room.host, B = room.guest;
  const tok = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2));
  const sim = (x, y) => { const a = tok(x), b = tok(y); if (!a.size || !b.size) return 0; let inter = 0; a.forEach((w) => { if (b.has(w)) inter++; }); return inter / Math.max(a.size, b.size); };
  const scored = SCENARIOS.map((sc, i) => {
    const a = (A.answers && A.answers[i]) || {}, b = (B.answers && B.answers[i]) || {};
    const resonance = sim(a.self, b.self);
    const predict = (sim(a.predict, b.self) + sim(b.predict, a.self)) / 2;
    const blankPenalty = [a.self, a.predict, b.self, b.predict].filter((x) => !x).length * 0.05;
    return { name: sc.name, score: Math.max(0, resonance * 0.6 + predict * 0.4 - blankPenalty) };
  });
  const sorted = [...scored].sort((x, y) => y.score - x.score);
  const avg = scored.reduce((s, x) => s + x.score, 0) / scored.length;
  const final = Math.max(1, Math.min(10, Math.round((4.5 + avg * 7) * 10) / 10));
  return {
    score: final,
    verdict: `${A.name} and ${B.name}, the multiverse watched you wander through ten impossible worlds — and in every one, something of you reached toward the other. Where your words echoed, the stars leaned closer; where they diverged, the cosmos simply held its breath and waited. You are not two people who think alike, but two people whose differences orbit a shared centre of gravity. That, more than any perfect match, is what the universe calls a bond.`,
    syncedUniverses: [sorted[0].name, sorted[1].name],
    lostUniverse: sorted[sorted.length - 1].name,
    closingLine: `Across every universe, ${A.name} and ${B.name} keep falling toward the same quiet light.`
  };
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
