// Versand-Funktion für Timer-Mitteilungen (Web Push).
// GET  ?key=1  -> öffentlicher Schlüssel für die App (wird beim ersten Aufruf erzeugt)
// POST         -> fällige Timer verschicken (wird von pg_cron alle 10 Sek. angestoßen, nur wenn etwas fällig ist)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function keys() {
  let { data, error } = await db.rpc("push_keys");
  if (error) throw error;
  if (!data.pub || !data.key) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = new Uint8Array([4, ...unb64u(j.x!), ...unb64u(j.y!)]);
    ({ data, error } = await db.rpc("push_keys", { new_pub: b64u(pub), new_priv: j.d }));
    if (error) throw error;
  }
  return data as { pub: string; key: string };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const k = await keys();
    if (req.method === "GET") return new Response(JSON.stringify({ pub: k.pub }), { headers: { ...cors, "Content-Type": "application/json" } });
    webpush.setVapidDetails("https://lianeh-pixel.github.io/rezepte/", k.pub, k.key);
    const { data, error } = await db.rpc("push_due");
    if (error) throw error;
    let sent = 0;
    for (const it of data.items || []) {
      try {
        await webpush.sendNotification(it.sub, JSON.stringify({ title: it.title, body: it.body, tag: "timer-" + it.id }), { TTL: 600, urgency: "high" });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await db.rpc("push_gone", { ep: it.endpoint });
        console.error("Push fehlgeschlagen", code, String(e));
      }
    }
    return new Response(JSON.stringify({ sent }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
