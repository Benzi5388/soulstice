/* ============================================================
   Soulstice — background compute (Netlify Background Function)

   Netlify treats any function whose filename ends in "-background"
   as a background function: it returns 202 immediately and may run
   for up to 15 minutes — so the (slow) Claude call isn't killed by
   the 10-second limit on normal synchronous functions.

   room.js triggers this (in production) with { code }; we just run
   the reading and write the result back into the room's Blob.
   ============================================================ */

import { runComputeForRoom } from "./room.js";

export const handler = async (event) => {
  let code = "";
  try { code = String(JSON.parse(event.body || "{}").code || "").slice(0, 16); } catch (e) {}
  if (code) {
    try { await runComputeForRoom(code); }
    catch (e) { console.error("[soulstice] background compute failed:", e && (e.stack || e.message)); }
  }
  return { statusCode: 200, body: "ok" };
};
