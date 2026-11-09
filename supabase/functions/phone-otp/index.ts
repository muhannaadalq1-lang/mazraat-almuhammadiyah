// مزرعة المحمدية — رمز التحقق للجوال عبر Authentica
// Supabase Edge Function: phone-otp   (Verify JWT: OFF — the visitor's session is checked here)
// Needs one secret: AUTHENTICA_API_KEY
//
// POST { action: "send",   phone: "5XXXXXXXX", channel: "whatsapp" | "sms" }
// POST { action: "verify", phone: "5XXXXXXXX", code: "1234" }
//
// The API key never reaches the browser. Sends are rate-limited per phone and per visitor.

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const API = "https://api.authentica.sa/api/v2";

type Doc = Record<string, any>;
async function getDoc(collection: string, id: string): Promise<Doc | null> {
  const { data } = await db.from("docs").select("data").eq("collection", collection).eq("id", id).maybeSingle();
  return data ? (data.data as Doc) : null;
}
async function setDoc(collection: string, id: string, data: Doc) {
  await db.from("docs").upsert({ collection, id, data });
}

async function authentica(path: string, body: Doc) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "X-Authorization": Deno.env.get("AUTHENTICA_API_KEY") || "",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  let data: Doc = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

// Authentica answers verify with HTTP 200 and a status flag; accept only a clear "yes".
function isVerified(r: { ok: boolean; data: Doc }) {
  if (!r.ok) return false;
  const d = r.data || {};
  const flags = [d.status, d.success, d.verified, d.data?.status, d.data?.verified];
  if (flags.some((f) => f === false || f === "false" || f === "failed")) return false;
  return flags.some((f) => f === true || f === "true" || f === "success" || f === "verified");
}

const MIN_GAP = 60_000;          // one send per phone per minute
const PER_HOUR = 5;              // per phone and per visitor

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!Deno.env.get("AUTHENTICA_API_KEY")) return json({ ok: false, error: "not_configured" }, 500);

  // Who is asking (the anonymous visitor session the site creates).
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  const uid = u?.user?.id;
  if (!uid) return json({ ok: false, error: "no_session" }, 401);

  let body: Doc = {};
  try { body = await req.json(); } catch { /* empty */ }
  let d = String(body.phone || "").replace(/\D/g, "");
  if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  if (!/^5\d{8}$/.test(d)) return json({ ok: false, error: "bad_phone" }, 400);
  const phone = "+966" + d;

  if (body.action === "send") {
    const now = Date.now();
    const log = (await getDoc("otpLog", d)) || {};
    const ulog = (await getDoc("otpLog", "u-" + uid)) || {};
    const recent = (log.times || []).filter((t: number) => now - t < 3_600_000);
    const urecent = (ulog.times || []).filter((t: number) => now - t < 3_600_000);
    const last = Math.max(0, ...recent);
    if (now - last < MIN_GAP) return json({ ok: false, error: "wait", wait: Math.ceil((MIN_GAP - (now - last)) / 1000) }, 429);
    if (recent.length >= PER_HOUR || urecent.length >= PER_HOUR) return json({ ok: false, error: "too_many" }, 429);

    const method = body.channel === "sms" ? "sms" : "whatsapp";
    const r = await authentica("/send-otp", { method, phone });
    if (!r.ok) return json({ ok: false, error: "send_failed", message: r.data?.message || "" }, 502);
    await setDoc("otpLog", d, { times: [...recent, now] });
    await setDoc("otpLog", "u-" + uid, { times: [...urecent, now] });
    return json({ ok: true, channel: method });
  }

  if (body.action === "verify") {
    const code = String(body.code || "").replace(/\D/g, "");
    if (code.length < 4 || code.length > 8) return json({ ok: false, error: "bad_code" }, 400);
    const r = await authentica("/verify-otp", { phone, otp: code });
    if (!isVerified(r)) return json({ ok: false, error: "wrong_code", message: r.data?.message || "" });
    await setDoc("verified", uid, { phone: "0" + d, at: Date.now() });
    return json({ ok: true, phone: "0" + d });
  }

  return json({ ok: false, error: "action" }, 400);
});
