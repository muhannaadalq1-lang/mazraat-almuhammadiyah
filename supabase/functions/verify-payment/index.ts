// مزرعة المحمدية — التحقق من دفعات Moyasar وتحديث الحجز
// Supabase Edge Function: verify-payment
// Needs one secret: MOYASAR_SECRET_KEY (sk_test_... or sk_live_...)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// The browser sends only a Moyasar payment id. Everything else (paid or not,
// the amount, which booking it belongs to) is read from Moyasar with the secret
// key, so a visitor cannot fake a payment or its amount.

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

type Doc = Record<string, any>;
async function getDoc(collection: string, id: string): Promise<Doc | null> {
  const { data } = await db.from("docs").select("data").eq("collection", collection).eq("id", id).maybeSingle();
  return data ? (data.data as Doc) : null;
}
async function setDoc(collection: string, id: string, data: Doc) {
  const { error } = await db.from("docs").upsert({ collection, id, data });
  if (error) throw error;
}
async function deleteDoc(collection: string, id: string) {
  await db.from("docs").delete().eq("collection", collection).eq("id", id);
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/* Price the booking from the stored settings, so a changed total in the browser is caught. */
async function expectedTotal(r: Doc): Promise<number | null> {
  const st = await getDoc("settings", "main");
  if (!st) return null;
  const pkg = (st.packages || []).find((p: Doc) => p.id === r.pkgId && p.sec === r.section)
    || (st.packages || []).find((p: Doc) => p.sec === r.section);
  if (!pkg || !Array.isArray(pkg.days)) return null;
  const date = new Date(r.date + "T12:00:00Z");
  const base = Number(pkg.days[date.getUTCDay()]);
  if (!base) return null;
  const season = (st.seasons || []).find((s: Doc) => s.from && s.to && r.date >= s.from && r.date <= s.to);
  let price = season ? Math.round(base * (1 + Number(season.pct || 0) / 100)) : base;
  if (r.overnight) price += Number((st.overnight || {})[r.section]) || 0;
  const extrasCatalog = new Map<string, number>((st.extras || []).map((x: Doc) => [x.name, Number(x.price) || 0]));
  const extras = (r.extras || []).reduce((t: number, x: Doc) => t + (extrasCatalog.get(x.name) ?? 0), 0);
  const sub = price + extras;
  let disc = 0;
  const dow = date.getUTCDay();
  if (Number(st.midweekPct) > 0 && dow <= 3) disc += Math.round(price * Number(st.midweekPct) / 100);
  if (r.coupon) {
    const c = await getDoc("coupons", r.coupon);
    if (c) {
      const left = Math.max(0, sub - disc);
      disc += c.amount ? Math.min(Number(c.amount), left) : Math.round(left * Number(c.percent || 0) / 100);
    }
  }
  // Loyalty discounts depend on visit history; allow up to the configured loyalty percentage.
  const lv = st.loyalty || {};
  const loyaltyRoom = Number(lv.pct) > 0 ? Math.round(sub * Number(lv.pct) / 100) : 0;
  return Math.max(0, sub - disc - loyaltyRoom);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let paymentId = "";
  try {
    const body = await req.json();
    paymentId = String(body.id || body?.data?.id || "");
  } catch { /* fallthrough */ }
  if (!/^[0-9a-f-]{20,64}$/i.test(paymentId)) return json({ ok: false, error: "bad_id" }, 400);

  const secret = Deno.env.get("MOYASAR_SECRET_KEY");
  if (!secret) return json({ ok: false, error: "not_configured" }, 500);

  // 1) Ask Moyasar what really happened.
  const res = await fetch(`https://api.moyasar.com/v1/payments/${paymentId}`, {
    headers: { Authorization: "Basic " + btoa(secret + ":") },
  });
  if (!res.ok) return json({ ok: false, error: "not_found" }, 404);
  const pay = await res.json();
  const meta = pay.metadata || {};
  if (pay.status !== "paid") return json({ ok: false, status: pay.status, message: pay.source?.message || "" });
  if (pay.currency !== "SAR") return json({ ok: false, error: "currency" }, 400);

  const uid = String(meta.uid || ""), reqId = String(meta.reqId || ""), kind = String(meta.kind || "");
  if (!uid || !reqId) return json({ ok: false, error: "no_booking" }, 400);

  // 2) Find the booking.
  const doc = await getDoc("requests", uid);
  const items: Doc[] = doc?.items || [];
  const idx = items.findIndex((x) => x.id === reqId);
  if (idx < 0) return json({ ok: false, error: "booking_missing" }, 404);
  const r = { ...items[idx] };

  // 3) Already recorded? (the page and a webhook may both report the same payment)
  r.payments = Array.isArray(r.payments) ? r.payments : [];
  if (r.payments.some((p: Doc) => p.id === paymentId)) {
    return json({ ok: true, already: true, status: r.status, paidAmount: r.paidAmount || 0, total: r.total || 0 });
  }

  const amount = Math.round(Number(pay.amount) / 100);
  const expected = await expectedTotal(r);
  if (expected !== null && Number(r.total) < expected) r.priceMismatch = { shown: r.total, expected };

  r.payments.push({ id: paymentId, amount, kind, at: Date.now(), method: pay.source?.company || pay.source?.type || "" });
  r.paidAmount = Math.round((Number(r.paidAmount) || 0) + amount);
  r.paidOnline = true;

  // 4) First payment confirms the booking and locks the day.
  const notes: string[] = [];
  if (r.status !== "confirmed") {
    const cal = (await getDoc("calendar", r.date)) || {};
    const secs = r.section === "both" ? ["s1", "s2"] : [r.section];
    const clash = secs.some((s) => cal[s] && cal[s] !== r.id);
    if (clash) {
      r.status = "pending";
      r.paidConflict = true; // paid, but the day was taken first: the owner refunds or moves the booking
      notes.push("conflict");
    } else {
      secs.forEach((s) => (cal[s] = r.id));
      await setDoc("calendar", r.date, cal);
      r.status = "confirmed";
      r.confirmedAt = Date.now();
      r.paid = true;
    }
    const holds = await getDoc("holds", uid);
    if (holds) {
      const left = (holds.items || []).filter((h: Doc) => h.reqId !== r.id);
      if (left.length) await setDoc("holds", uid, { ...holds, items: left }); else await deleteDoc("holds", uid);
    }
    if (r.couponGift && r.coupon && !r.paidConflict) {
      const c = await getDoc("coupons", r.coupon);
      if (c) await setDoc("coupons", r.coupon, { ...c, active: false, usedBy: r.name, usedAt: Date.now() });
    }
  }

  items[idx] = r;
  await setDoc("requests", uid, { ...(doc || {}), uid, items });

  // 5) Income in the finance book (one row per payment).
  const label = kind === "full" ? "دفع كامل" : kind === "rest" ? "دفعة متبقية" : "عربون";
  await setDoc("finance", "pay-" + paymentId, {
    id: "pay-" + paymentId, kind: "in", cat: "حجز", amount, date: dayKey(new Date()), reqId: r.id,
    note: `${label} إلكتروني · ${r.name} · ${r.section} ${r.date}`, createdAt: Date.now(),
  });

  return json({ ok: true, status: r.status, paidAmount: r.paidAmount, total: r.total || 0, notes });
});
