(() => {
"use strict";
const app = document.getElementById("app");
// iPad/PC: ab 760 px Zutaten und Zubereitung nebeneinander
const mqTwo = window.matchMedia("(min-width: 760px)");
[mqTwo].forEach(m => m.addEventListener && m.addEventListener("change", () => { if (state.route && state.route.view !== "edit") render(); }));
const CFG = window.RB_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const CACHE_KEY = "rb-cache-v1";
const URL_KEY = "rb-photo-urls-v1";

const state = {
  user: null, authReady: false, authMode: "login", authMsg: "", authErr: "", authBusy: false,
  recipes: [], foods: [], loaded: false, loadError: "", online: navigator.onLine,
  query: "", cat: "", favOnly: false, homeView: (() => { try { return localStorage.getItem("rb-home") || "cards"; } catch (e) { return "cards"; } })(), carCat: "",
  route: { view: "list" },
  servings: {}, checked: {},
  confirmDelete: false, saving: false, formError: "",
  draftPhoto: null,
  cook: null, wakeLock: null,
  photoUrls: {}, foodForm: null
};
const UNITS = ["kg","g","mg","l","ml","cl","dl","EL","TL","Msp.","Msp","Prise","Prisen","Stück","Stk.","Becher","Dose","Dosen","Packung","Packungen","Pck.","Bund","Zehe","Zehen","Tasse","Tassen","Scheibe","Scheiben","Handvoll","Blatt","Blätter","Glas","Würfel","Zweig","Zweige","Schuss","Spritzer","cm"];
const unitRe = new RegExp("^(" + UNITS.map(u => u.replace(".", "\\.")).sort((a, b) => b.length - a.length).join("|") + ")(?=\\s|$)", "i");
const FRAC = { "½": .5, "¼": .25, "¾": .75, "⅓": 1/3, "⅔": 2/3, "⅛": .125 };

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
// Verweise auf andere Rezepte: im Text als [[Titel]], bei Zutaten als ref (Rezept-ID)
const RLINK = /\[\[([^\]]+)\]\]/g;
const TTOK = /\{\s*Timer:?\s*([^}]*)\}/gi;
const plainLinks = t => String(t || "").replace(RLINK, "$1").replace(TTOK, "").replace(/[ \t]{2,}/g, " ").trim();
const recipeByTitle = t => { const k = String(t).trim().toLowerCase(); return state.recipes.find(x => (x.title || "").trim().toLowerCase() === k); };
function openRecipe(id) { if (state.cook) closeCook(); go("rezept-" + id); }
function linkedText(t) {
  t = String(t || ""); const out = []; let last = 0;
  t.replace(/\[\[([^\]]+)\]\]|\{\s*Timer:?\s*([^}]*)\}/gi, (m, name, dur, at) => {
    out.push(t.slice(last, at)); last = at + m.length;
    if (name != null) { const rr = recipeByTitle(name);
      out.push(rr ? h("a", { class: "rlink", href: "#rezept-" + rr.id, onclick: e => { e.preventDefault(); openRecipe(rr.id); } }, name) : name); }
  });
  out.push(t.slice(last)); return out;
}
function toast(msg, ms) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
}
const GUEST_FAV = "rb-gast-fav";
const isGuest = () => !state.user;
function guestFavs() { return new Set(lsGet(GUEST_FAV, [])); }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function parseQty(s) {
  s = s.trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\s*([½¼¾⅓⅔⅛])$/); if (m) return +m[1] + FRAC[m[2]];
  if (FRAC[s] != null) return FRAC[s];
  m = s.match(/^(\d+)\/(\d+)$/); if (m) return m[1] / m[2];
  const n = parseFloat(s.replace(",", ".")); return isNaN(n) ? null : n;
}
function parseIngredient(line) {
  line = line.trim(); if (!line) return null;
  if (/^#|:$/.test(line)) return { section: line.replace(/^#\s*/, "").replace(/:$/, "") };
  const m = line.match(/^(\d+\s+\d+\/\d+|\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+\/\d+|\d+(?:[.,]\d+)?)\s*(.*)$/);
  let qty = null, rest = line;
  if (m) { qty = parseQty(m[1]); rest = m[2]; }
  let unit = "";
  const u = rest.match(unitRe);
  if (u) { unit = UNITS.find(x => x.toLowerCase() === u[1].toLowerCase()) || u[1]; rest = rest.slice(u[0].length).trim(); }
  return { qty, unit, name: rest };
}
function fmtQty(q) {
  if (q == null) return "";
  const whole = Math.floor(q + 1e-9), frac = q - whole;
  const fr = [[.25,"¼"],[1/3,"⅓"],[.5,"½"],[2/3,"⅔"],[.75,"¾"]].find(([v]) => Math.abs(frac - v) < 0.02);
  if (q < 10 && fr) return (whole ? whole + " " : "") + fr[1];
  if (Math.abs(frac) < 0.02 || Math.abs(frac - 1) < 0.02) return String(Math.round(q));
  const r = q >= 100 ? Math.round(q) : q >= 10 ? Math.round(q * 2) / 2 : Math.round(q * 10) / 10;
  return String(r).replace(".", ",");
}
// Kategorien sortieren: "Ohne Kategorie" und "Draft" immer ganz unten
function catRank(c) { const n = String(c || "").trim().toLowerCase(); return n === "draft" ? 2 : n === "ohne kategorie" ? 1 : 0; }
// Reihenfolge nach Verzehr: Frühstück, Vorspeise, Hauptgang mit Saucen und Grundrezepten, Nachtisch, Kaffee
const CAT_ORDER = [/^brot|brötchen|frühstück|^teig|grund|basis/, /suppe|eintopf|vorspeise|salat/, /snack|finger/, /auflauf|aufläufe|pasta|nudel/, /ragout|ragu|ragù|fleisch|fisch/, /tofu|vegan|vegetar/, /gemüse/, /haupt/, /beilage/, /sauce|soße|dip/, /dessert|nachtisch/, /kuchen|gebäck|torte/, /kekse|plätzchen|cookies/];
// Feste Kategorien (Lias Liste, in Verzehr-Reihenfolge)
const CATS = ["Brot & Teig", "Suppen & Eintöpfe", "Snacks & Fingerfood", "Pasta & Aufläufe", "Ragout & Ragù", "Beilagen", "Saucen", "Dessert", "Kuchen & Gebäck", "Kekse", "Draft"];
function catPos(c) { const j = CATS.indexOf(String(c || "").trim()); if (j >= 0) return j; const k = String(c || "").toLowerCase(); const i = CAT_ORDER.findIndex(re => re.test(k)); return CATS.length + (i < 0 ? CAT_ORDER.length : i); }
function catCmp(a, b) { return catRank(a) - catRank(b) || catPos(a) - catPos(b) || String(a).localeCompare(String(b), "de"); }
function consolidate(list) {
  const out = [], by = new Map();
  list.filter(i => !i.section && (i.name || i.qty != null)).forEach(i => {
    const k = norm(String(i.name || "").trim()) + "|" + norm(String(i.unit || "").trim());
    const o = by.get(k);
    if (!o) { const c = { ...i }; by.set(k, c); out.push(c); return; }
    if (i.qty != null) o.qty = (o.qty != null ? o.qty : 0) + i.qty;
  });
  return out;
}
// Gerichte aus Basics: verlinkte Rezepte als Zutat. Faktor des Basics aus Menge + Einheit
function basicFactor(i, rr) {
  const u = norm(String(i.unit || "").trim()), q = i.qty != null ? i.qty : 1;
  if (!u || /^rezept/.test(u)) return q;
  const su = SERV_UNITS.find(x => norm(x[0]) === u || norm(x[1]) === u);
  if (rr.servings && (su || u === "portion" || u === "portionen") ) return q / rr.servings;
  return 1;
}
function basicsOf(r) {
  const seen = new Set();
  return consolidate(r.ingredients || []).map(i => ({ i, rr: i.ref && i.ref !== r.id ? findRecipe(i.ref) : null })).filter(x => x.rr && !seen.has(x.rr.id) && seen.add(x.rr.id));
}
function ingToLine(i) { return i.section ? i.section + ":" : [fmtQty(i.qty), i.unit, i.name].filter(Boolean).join(" "); }
// Zutaten, die in einem Zubereitungsschritt vorkommen (automatisch per Name erkannt)
function normWord(w) { return w.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss").replace(/(en|n|e|s)$/, ""); }
const STOP = new Set(["und", "mit", "den", "dem", "der", "die", "das", "ein", "eine", "einer", "einem", "einen", "auf", "aus", "bei", "bis", "für", "von", "zum", "zur", "ihn", "sie", "alle", "alles", "etwas", "nach", "noch", "dann", "darin", "dazu", "oder", "nicht", "gut", "kurz", "lang", "min", "std", "grad", "minuten", "stunde", "stunden", "geben", "lassen"]);
function wordsOf(t) { return (t.match(/[A-Za-zÄÖÜäöüß]+/g) || []).filter(w => w.length >= 3 && !STOP.has(w.toLowerCase())).map(normWord).filter(w => w.length >= 3); }
function stepIngredients(r, text, links) {
  let sec = "", items = [];
  (r.ingredients || []).forEach(i => { if (i.section) sec = i.section; else items.push({ i, sec }); });
  const secs = [...new Set(items.map(x => x.sec).filter(Boolean))];
  const lk = (links || []).map(x => x.toLowerCase());
  const linked = secs.filter(s => lk.includes(s.toLowerCase()));
  if (linked.length) {
    // verknüpfte Zutatenlisten: immer die ganze Liste zeigen
    return items.filter(x => linked.includes(x.sec)).map(x => x.i);
  }
  // ohne verknüpfte Zutatenliste keine Zutaten am Schritt
  return [];
}
function stepIngLine(r, text, f, cls, links) {
  const list = stepIngredients(r, text, links); if (!list.length) return null;
  return h("p", { class: cls }, list.map((i, k) => [k ? h("span", { class: "sep" }, " · ") : "", h("span", { class: "si" }, h("b", null, [fmtQty(i.qty != null ? i.qty * f : null), i.unit].filter(Boolean).join(" ")), (i.qty != null || i.unit ? " " : "") + i.name)]));
}
// Zubereitung: Abschnitte werden als Eintrag "# Name" in steps gespeichert
const isStepSec = s => typeof s === "string" && /^#\s/.test(s);
// Kopf eines Zubereitungs-Abschnitts: "# Überschrift | Zutatenliste1, Zutatenliste2" (ohne "|" = Überschrift ist zugleich die Verknüpfung)
function parseStepHead(s) {
  const body = s.replace(/^#\s*/, "");
  if (!body.includes("|")) { const t = body.trim(); return { title: t, links: t ? [t] : [], explicit: false }; }
  const [t, l] = body.split("|");
  return { title: t.trim(), links: l.split(",").map(x => x.trim()).filter(Boolean), explicit: true };
}
function stepList(r) { let head = { title: "", links: [] }; const out = []; (r.steps || []).forEach(s => { if (isStepSec(s)) head = parseStepHead(s); else out.push({ text: s, sec: head.title, links: head.links }); }); return out; }
function stepGroups(r) { const g = []; let cur = { title: "", links: [], items: [] }; (r.steps || []).forEach(s => { if (isStepSec(s)) { if (cur.items.length || cur.title || cur.links.length) g.push(cur); cur = Object.assign(parseStepHead(s), { items: [] }); } else cur.items.push(s); }); if (cur.items.length || cur.title || !g.length) g.push(cur); return g; }
// Art der Portion: Einzahl/Mehrzahl
const SERV_UNITS = [["Portion", "Portionen"], ["Stück", "Stück"], ["Blech", "Bleche"], ["Form", "Formen"], ["Glas", "Gläser"], ["Person", "Personen"]];
function servLabel(r, n) {
  const u = (r.servings_unit || "Portion").trim(), e = SERV_UNITS.find(x => x[0].toLowerCase() === u.toLowerCase() || x[1].toLowerCase() === u.toLowerCase());
  return n + " " + (e ? (n === 1 ? e[0] : e[1]) : u);
}
function perLabel(r) { const u = (r.servings_unit || "Portion").trim(), e = SERV_UNITS.find(x => x[0].toLowerCase() === u.toLowerCase() || x[1].toLowerCase() === u.toLowerCase()); return "pro " + (e ? e[0] : u); }
function scaled(r) { const base = r.servings || 0, now = state.servings[r.id] || base; return base ? now / base : 1; }
function fmtMin(m) { if (!m) return ""; return m >= 60 ? Math.floor(m / 60) + " Std." + (m % 60 ? " " + (m % 60) + " Min." : "") : m + " Min."; }
function norm(s) { return (s || "").toLocaleLowerCase("de").normalize("NFD").replace(/[̀-ͯ]/g, ""); }
// Standardbild je Kategorie
const CAT_IMG = [[/kekse|plätzchen|cookies/, "kekse"], [/kuchen|gebäck|gebaeck/, "kuchen"], [/brot|brötchen|buns/, "brot"], [/dessert|nachtisch|süß/, "dessert"], [/haupt|auflauf|aufläufe|ragout|ragu|ragù|fleisch|fisch|tofu|gemüse|snack|finger/, "hauptgericht"], [/suppe|eintopf/, "suppen"], [/sauce|soße|dip/, "saucen"], [/beilage|salat/, "beilagen"], [/grund|basis|teig/, "grundrezepte"]];
function catImage(c) { const k = String(c || "").toLowerCase(); const m = CAT_IMG.find(([re]) => re.test(k)); return m ? "icons/kat-" + m[1] + ".svg" : "icons/standard.svg"; }
function photoSrc(r) { return r.photo_path ? (state.photoUrls[r.photo_path] || {}).url || "" : ""; }
function heroGallery(r) {
  const urls = photoPaths(r).map(urlFor).filter(Boolean);
  if (urls.length < 2) return h("img", { src: urls[0] || photoSrc(r), alt: "" });
  const track = h("div", { class: "gal" }, urls.map(u => h("img", { src: u, alt: "" })));
  const dots = h("div", { class: "gal-dots", "aria-hidden": "true" }, urls.map((_, k) => h("i", { class: k === 0 ? "on" : null })));
  track.addEventListener("scroll", () => { const k = Math.round(track.scrollLeft / track.clientWidth); [...dots.children].forEach((d, j) => d.classList.toggle("on", j === k)); }, { passive: true });
  return [track, dots];
}
function openPhotos(r) {
  const close = () => { ov.remove(); document.removeEventListener("keydown", esc); };
  const esc = e => { if (e.key === "Escape") close(); };
  const ov = h("div", { class: "pv", role: "dialog", "aria-modal": "true", "aria-label": "Fotos" },
    h("div", { class: "pv-stage" }, heroGallery(r)),
    h("button", { class: "round pv-x", "aria-label": "Schließen", onclick: close }, "×"));
  document.body.append(ov); document.addEventListener("keydown", esc);
}
function photoPaths(r) { return [r.photo_path, ...(r.photos || [])].filter(Boolean); }
function urlFor(path) { return (state.photoUrls[path] || {}).url || ""; }
function categories() { const s = new Set(); state.recipes.forEach(r => r.category && s.add(r.category)); return [...s].sort((a, b) => a.localeCompare(b, "de")); }
function allTags() { const s = new Set(); state.recipes.forEach(r => (r.tags || []).forEach(t => s.add(t))); return [...s].sort((a, b) => a.localeCompare(b, "de")); }
function filtered() {
  const q = norm(state.query).split(/\s+/).filter(Boolean);
  return state.recipes.filter(r => {
    if (state.favOnly && !r.favorite) return false;
    if (state.cat && r.category !== state.cat && !(r.tags || []).includes(state.cat)) return false;
    if (!q.length) return true;
    const hay = norm([r.title, r.category, (r.tags || []).join(" "), (r.ingredients || []).map(i => i.name || i.section).join(" "), r.notes].join(" "));
    return q.every(w => hay.includes(w));
  });
}
function findRecipe(id) { return state.recipes.find(r => r.id === id); }
function errText(e) { return (e && (e.message || e.code)) || "unbekannter Fehler"; }

// ---------- data ----------
async function loadAll() {
  const [rec, foods] = await Promise.all([
    sb.from("recipes").select("*").order("updated_at", { ascending: false }),
    sb.from("foods").select("*").order("name")
  ]);
  if (rec.error) {
    state.loadError = state.online ? "Die Rezepte konnten nicht geladen werden (" + errText(rec.error) + ")." : "Du bist offline. Du siehst den zuletzt geladenen Stand.";
    render(); return;
  }
  state.recipes = rec.data; state.loaded = true; state.loadError = "";
  if (isGuest()) { const fav = guestFavs(); state.recipes.forEach(r => r.favorite = fav.has(r.id)); }
  if (!foods.error) state.foods = foods.data;
  saveCache();
  await refreshPhotoUrls();
  rerenderKeepingForm();
}
function saveCache() { lsSet(CACHE_KEY, { user: state.user ? state.user.id : "gast", recipes: state.recipes, foods: state.foods }); }
function rerenderKeepingForm() {
  if (state.route.view === "edit") return;
  if (state.route.view === "list" && document.activeElement && document.activeElement.id === "q") { renderGridOnly(); return; }
  render();
}
async function refreshPhotoUrls() {
  const now = Date.now(), need = state.recipes.flatMap(photoPaths).filter(p => p && !(state.photoUrls[p] && state.photoUrls[p].exp > now + 3600e3));
  if (!need.length) return;
  const { data, error } = await sb.storage.from("photos").createSignedUrls([...new Set(need)], 7 * 24 * 3600);
  if (error || !data) return;
  data.forEach(d => { if (d.signedUrl) state.photoUrls[d.path] = { url: d.signedUrl, exp: now + 7 * 24 * 3600e3 }; });
  lsSet(URL_KEY, state.photoUrls);
}

// ---------- Fotos aus PDF-Exporten übernehmen ----------
const titleKey = t => norm(String(t || "")).replace(/\.(pdf|jpe?g|png)$/i, "").replace(/\s*(\(\d+\)|\d+)\s*$/, "").replace(/[^a-z0-9äöüß]/g, "");
function pdfTitle(bytes) {
  const txt = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4000000)));
  const m = txt.match(/\/Title\s*\(((?:\\.|[^\\)])*)\)/);
  if (!m) return "";
  let t = m[1].replace(/\\([()\\])/g, "$1");
  if (t.charCodeAt(0) === 0xfe && t.charCodeAt(1) === 0xff) { let o = ""; for (let i = 2; i + 1 < t.length; i += 2) o += String.fromCharCode((t.charCodeAt(i) << 8) | t.charCodeAt(i + 1)); t = o; }
  return t;
}
function biggestJpeg(bytes) {
  let best = null;
  const end = new TextEncoder().encode("endstream");
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue;
    let j = i + 3;
    outer: for (; j < bytes.length - end.length; j++) { for (let k = 0; k < end.length; k++) if (bytes[j + k] !== end[k]) continue outer; break; }
    let e = j; while (e > i && !(bytes[e - 2] === 0xff && bytes[e - 1] === 0xd9)) e--;
    if (e > i && (!best || e - i > best.length)) best = bytes.subarray(i, e);
    i = j;
  }
  return best ? new Blob([best], { type: "image/jpeg" }) : null;
}
async function shrinkJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const sc = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
}
function pickImportPhotos() {
  const inp = h("input", { type: "file", multiple: true, accept: "application/pdf,.pdf,image/jpeg,.jpg,.jpeg", style: "display:none" });
  inp.addEventListener("change", () => { const fs = [...inp.files]; inp.remove(); if (fs.length) importPhotos(fs); });
  document.body.append(inp); inp.click();
}
async function importPhotos(files) {
  const byKey = new Map(state.recipes.map(r => [titleKey(r.title), r]));
  let done = 0, skipped = 0; const missing = [];
  toast("Fotos werden übernommen …");
  for (const f of files) {
    try {
      let blob = null, key = titleKey(f.name), r = byKey.get(key);
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!r) { const t = pdfTitle(bytes); r = byKey.get(titleKey(t)); }
        if (r) blob = biggestJpeg(bytes);
      } else if (r) blob = f;
      if (!r) { missing.push(f.name.replace(/\.[^.]+$/, "")); continue; }
      if (!blob) { skipped++; continue; }
      if (r.photo_path) { skipped++; continue; }
      const small = await shrinkJpeg(blob);
      const path = state.user.id + "/" + uuid() + ".jpg";
      const up = await sb.storage.from("photos").upload(path, small, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const res = await sb.from("recipes").update({ photo_path: path }).eq("id", r.id);
      if (res.error) throw res.error;
      r.photo_path = path; done++;
    } catch (e) { missing.push(f.name + " (Fehler)"); }
  }
  await loadAll();
  toast(done + (done === 1 ? " Foto" : " Fotos") + " übernommen" + (skipped ? ", " + skipped + " ohne Foto oder schon vorhanden" : "") + (missing.length ? ". Nicht zugeordnet: " + missing.slice(0, 4).join(", ") + (missing.length > 4 ? " …" : "") : ""), 8000);
}

// ---------- auth ----------
async function initAuth() {
  state.photoUrls = lsGet(URL_KEY, {});
  const { data } = await sb.auth.getSession();
  setUser(data.session ? data.session.user : null);
  sb.auth.onAuthStateChange((_ev, session) => {
    const before = state.user && state.user.id;
    setUser(session ? session.user : null);
    if ((state.user && state.user.id) !== before) { state.photoUrls = {}; loadAll(); if (state.user && state.route.view === "login") go(""); else render(); }
  });
  state.authReady = true;
  render();
  loadAll();
}
function setUser(u) {
  state.user = u;
  const c = lsGet(CACHE_KEY, null);
  if (c && c.user === (u ? u.id : "gast")) { if (!state.loaded) { state.recipes = c.recipes || []; state.foods = c.foods || []; state.loaded = true; } }
  else { state.recipes = []; state.foods = []; state.loaded = false; }
}
function renderLogin() {
  const signup = state.authMode === "signup";
  const email = h("input", { id: "l-email", type: "email", autocomplete: "email", required: true });
  const pw = h("input", { id: "l-pw", type: "password", autocomplete: signup ? "new-password" : "current-password", required: true, minlength: "8" });
  const form = h("form", { novalidate: true },
    h("label", { class: "field" }, h("span", null, "E-Mail"), email),
    h("label", { class: "field" }, h("span", null, "Passwort"), pw, signup ? h("small", null, "Mindestens 8 Zeichen.") : null),
    state.authErr ? h("p", { class: "err", role: "alert" }, state.authErr) : null,
    state.authMsg ? h("p", { class: "ok" }, state.authMsg) : null,
    h("button", { type: "submit", class: "btn primary", disabled: state.authBusy }, state.authBusy ? "Einen Moment …" : signup ? "Konto anlegen" : "Anmelden"),
    !signup ? h("button", { type: "button", class: "switch", onclick: () => resetPw(email.value) }, "Passwort vergessen") : null);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    state.authErr = ""; state.authMsg = "";
    if (!email.value || pw.value.length < (signup ? 8 : 1)) { state.authErr = signup ? "Bitte E-Mail und ein Passwort mit mindestens 8 Zeichen eingeben." : "Bitte E-Mail und Passwort eingeben."; render(); return; }
    state.authBusy = true; render();
    const redirect = location.origin + location.pathname;
    const res = signup
      ? await sb.auth.signUp({ email: email.value.trim(), password: pw.value, options: { emailRedirectTo: redirect } })
      : await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
    state.authBusy = false;
    if (res.error) {
      const m = res.error.message || "";
      state.authErr = /invalid login/i.test(m) ? "E-Mail oder Passwort stimmt nicht." : /not confirmed/i.test(m) ? "Bitte bestätige zuerst deine E-Mail über den Link, den du bekommen hast." : /already registered/i.test(m) ? "Für diese E-Mail gibt es schon ein Konto. Melde dich an." : "Das hat nicht geklappt: " + m;
    } else if (signup && !res.data.session) {
      state.authMsg = "Fast geschafft: Wir haben dir eine E-Mail geschickt. Klick auf den Link darin und melde dich danach hier an.";
      state.authMode = "login";
    }
    render();
  });
  app.append(h("div", { class: "login" },
    h("h1", null, "Rezeptbuch"),
    h("p", null, "Zum Bearbeiten anmelden. Lesen geht auch ohne Anmeldung."),
    form,
    h("button", { type: "button", class: "switch", onclick: () => go("") }, "Zurück zu den Rezepten")));
}
async function resetPw(email) {
  if (!email) { state.authErr = "Gib zuerst deine E-Mail ein."; render(); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname + "#neues-passwort" });
  state.authErr = error ? "Das hat nicht geklappt: " + error.message : "";
  state.authMsg = error ? "" : "Wir haben dir einen Link zum Zurücksetzen geschickt.";
  render();
}
function renderNewPassword() {
  const pw = h("input", { id: "np", type: "password", autocomplete: "new-password", minlength: "8" });
  const form = h("form", { novalidate: true },
    h("label", { class: "field" }, h("span", null, "Neues Passwort"), pw, h("small", null, "Mindestens 8 Zeichen.")),
    state.authErr ? h("p", { class: "err" }, state.authErr) : null,
    h("button", { type: "submit", class: "btn primary" }, "Passwort speichern"));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (pw.value.length < 8) { state.authErr = "Mindestens 8 Zeichen, bitte."; render(); return; }
    const { error } = await sb.auth.updateUser({ password: pw.value });
    if (error) { state.authErr = "Das hat nicht geklappt: " + error.message; render(); return; }
    state.authErr = ""; toast("Passwort geändert"); go("");
  });
  app.append(h("div", { class: "login" }, h("h1", null, "Neues Passwort"), form));
}

// ---------- routing ----------
function readHash() {
  const hsh = location.hash.slice(1);
  if (hsh === "neu") return { view: "edit", id: null };
  if (hsh === "neues-passwort") return { view: "newpw" };
  if (hsh === "anmelden") return { view: "login" };
  let m = hsh.match(/^rezept-([A-Za-z0-9-]+)$/); if (m) return { view: "detail", id: m[1] };
  m = hsh.match(/^bearbeiten-([A-Za-z0-9-]+)$/); if (m) return { view: "edit", id: m[1] };
  return { view: "list" };
}
function go(hash) { if (location.hash.slice(1) === hash) onRoute(); else location.hash = hash; }
function onRoute() {
  const prev = state.route;
  state.route = readHash();
  state.confirmDelete = false; state.formError = ""; state.foodForm = null;
  if (state.route.view === "detail" && prev.id !== state.route.id) state.tab = "ing";
  if (state.route.view === "edit" && (prev.view !== "edit" || prev.id !== state.route.id)) clearDraftPhoto();
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", onRoute);

// ---------- render ----------
function render() {
  if (state.route.view !== "edit") { const ae = document.activeElement; if (ae && ae.id === "q") state._keepSearchFocus = ae.selectionStart; }
  app.replaceChildren();
  app.classList.remove("full", "home");
  if (!state.authReady) { app.append(h("div", { class: "empty" }, h("h2", null, "Wird geladen …"))); return; }
  if (state.route.view === "newpw" && state.user) return renderNewPassword();
  if (state.route.view === "login") { if (state.user) { go(""); return; } return renderLogin(); }
  const r = state.route;
  if (r.view === "edit" && isGuest()) { go(""); return; }
  if (r.view === "detail" && isGuest()) { const x = findRecipe(r.id); if (x && catRank(x.category) === 2) { go(""); return; } }
  if (r.view === "detail") return renderDetail(r.id);
  if (r.view === "edit") return renderForm(r.id);
  renderList();
}
const searchIcon = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("width", "18"); s.setAttribute("height", "18"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.2"); s.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4" stroke-linecap="round"/>'; return s; };

function renderList() {
  app.classList.add("home");
  const menuOpen = !!state.menuOpen;
  app.append(h("div", { class: "h-head" },
    h("h1", null, "Rezeptbuch"),
    h("div", { class: "h-tools" },
      !state.online ? h("span", { class: "offline" }, "offline") : null,
      state.recipes.length ? h("button", { class: "h-fav h-view", "aria-label": state.homeView === "cards" ? "Als Inhaltsverzeichnis zeigen" : "Als Karten zeigen", onclick: () => { state.homeView = state.homeView === "cards" ? "list" : "cards"; try { localStorage.setItem("rb-home", state.homeView); } catch (e) {} state.menuOpen = false; render(); } }, icon(state.homeView === "cards" ? "list" : "cards")) : null,
      h("button", { class: "h-fav" + (state.favOnly ? " on" : ""), "aria-label": state.favOnly ? "Alle Rezepte zeigen" : "Nur Favoriten zeigen", "aria-pressed": state.favOnly ? "true" : "false", onclick: () => { state.favOnly = !state.favOnly; state.menuOpen = false; render(); } }, icon("heart", state.favOnly)),
      h("button", { class: "h-menu-btn", "aria-label": "Menü", "aria-expanded": menuOpen ? "true" : "false", onclick: () => { state.menuOpen = !menuOpen; render(); } },
        h("img", { class: "logo-l", src: "icons/icon-light.svg?i=4", alt: "", width: "36", height: "36" }), h("img", { class: "logo-d", src: "icons/icon-dark.svg?i=4", alt: "", width: "36", height: "36" })),
      menuOpen ? h("div", { class: "h-menu", role: "menu" },
        h("button", { role: "menuitem", onclick: () => { state.menuOpen = false; render(); shareApp(); } }, "Rezeptbuch teilen"),
        state.recipes.length ? h("button", { role: "menuitem", onclick: () => { state.menuOpen = false; render(); exportPdf(sortedForPdf(), "Rezeptbuch.pdf", true); } }, "Rezepte herunterladen") : null,
        isGuest() ? h("button", { role: "menuitem", onclick: () => { state.menuOpen = false; go("anmelden"); } }, "Anmelden")
          : h("button", { role: "menuitem", onclick: () => { state.menuOpen = false; logout(); } }, "Abmelden")) : null)));
  if (state.loadError) app.append(h("div", { class: "notice" }, state.loadError));
  if (!state.loaded) { app.append(h("div", { class: "empty" }, h("h2", null, "Rezepte werden geladen …"))); return; }
  if (!state.recipes.length) {
    app.append(h("div", { class: "empty" },
      h("h2", null, "Noch keine Rezepte"),
      h("p", null, "Leg dein erstes Rezept an. Es erscheint dann auf all deinen Geräten."),
      isGuest() ? null : h("button", { class: "btn primary", onclick: () => go("neu") }, "+ Erstes Rezept anlegen")));
    return;
  }
  const input = h("input", { id: "q", type: "search", placeholder: "Suchen", value: state.query, autocomplete: "off", "aria-label": "Rezepte durchsuchen" });
  input.addEventListener("input", () => { state.query = input.value; renderGridOnly(); });
  app.append(h("div", { class: "search" }, searchIcon(), input));
  if (state.favOnly) app.append(h("div", { class: "h-filter" }, "Nur Favoriten", h("button", { onclick: () => { state.favOnly = false; render(); } }, "Alle zeigen")));
  app.append(h("div", { id: "gridhost" }));
  renderGridOnly();
  if (!isGuest()) app.append(h("button", { class: "fab", "aria-label": "Neues Rezept", onclick: () => go("neu"), disabled: !state.online }, "+"));
  if (state._keepSearchFocus != null) { input.focus(); try { input.setSelectionRange(state._keepSearchFocus, state._keepSearchFocus); } catch (e) {} state._keepSearchFocus = null; }
}
function renderGridOnly() {
  const host = document.getElementById("gridhost"); if (!host) return;
  const list = filtered();
  if (!list.length) { host.replaceChildren(h("div", { class: "empty" }, h("h2", null, "Nichts gefunden"), h("p", null, state.favOnly ? "Unter deinen Favoriten passt nichts. Tipp oben auf „Alle zeigen“." : "Versuch einen anderen Suchbegriff."))); return; }
  const groups = new Map();
  list.forEach(r => { const c = r.category || "Ohne Kategorie"; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(r); });
  const names = [...groups.keys()].sort(catCmp);
  app.classList.toggle("carmode", state.homeView === "cards" && !state.query.trim());
  if (state.homeView === "cards" && !state.query.trim()) return renderCarousel(host, names, groups);
  host.replaceChildren(h("div", { class: "toc" }, names.map(c => {
    const rs = groups.get(c).sort((a, b) => a.title.localeCompare(b.title, "de"));
    const draft = catRank(c) === 2;
    return h("section", draft ? { class: "draft" } : null,
      h("h2", { class: "chap" }, draft ? h("b", null, icon("pen"), c) : c, h("span", null, rs.length + (rs.length === 1 ? " Rezept" : " Rezepte"))),
      h("ul", null, rs.map(r => {
        const time = (r.prep_min || 0) + (r.cook_min || 0);
        if (draft && isGuest()) return h("li", null, h("span", { class: "ln off" },
          h("span", { class: "t" }, r.title || "Ohne Titel"),
          h("span", { class: "dots", "aria-hidden": "true" }),
          h("span", { class: "tm" }, "folgt bald")));
        return h("li", null, h("a", { href: "#rezept-" + r.id, class: "ln" },
          h("span", { class: "t" }, r.title || "Ohne Titel"),
          h("span", { class: "dots", "aria-hidden": "true" }),
          h("span", { class: "tm" }, time ? fmtMin(time) : "")));
      })));
  })));
}
const MOTIFS = {
  kuchen: '<path d="M40 110h120"/><path d="M50 110V78c0-6 4-10 10-10h80c6 0 10 4 10 10v32"/><path d="M50 88c12 6 22 6 33 0s22-6 34 0 22 6 33 0"/><path d="M100 68V50"/><path d="M100 50c-5-5-3-11 0-16 3 5 5 11 0 16z"/>',
  kekse: '<circle cx="85" cy="85" r="34"/><circle cx="140" cy="102" r="20"/><circle cx="75" cy="75" r="3"/><circle cx="96" cy="72" r="3"/><circle cx="86" cy="96" r="3"/><circle cx="102" cy="92" r="3"/><circle cx="138" cy="96" r="2.5"/><circle cx="146" cy="108" r="2.5"/>',
  brot: '<path d="M35 112c0-30 25-50 65-50s65 20 65 50z"/><path d="M70 78l12 14M98 72l12 14M126 78l12 14"/>',
  topf: '<path d="M45 76h110v34a22 22 0 0 1-22 22H67a22 22 0 0 1-22-22z"/><path d="M35 76h130M45 88H32M155 88h13"/><path d="M80 62c-6-8 6-12 0-20M100 62c-6-8 6-12 0-20M120 62c-6-8 6-12 0-20"/>',
  nuggets: '<path d="M50 100c-6-14 6-26 20-24 10-12 30-6 30 8 8 14-6 28-22 24-12 6-26 4-28-8z"/><path d="M110 104c-4-12 6-22 18-20 8-10 26-4 24 8 6 12-6 22-20 20-10 6-22 2-22-8z"/><path d="M40 122h120"/>',
  pudding: '<path d="M70 70h60l-8 38H78z"/><path d="M100 108v18M84 126h32"/><path d="M74 70c4-12 48-12 52 0"/><path d="M112 58l10-14"/>',
  lasagne: '<path d="M30 70h140v50H30z"/><path d="M30 86c20 8 30-6 47 0s30 8 47 0 30-6 46 0"/><path d="M30 103c20 8 30-6 47 0s30 8 47 0 30-6 46 0"/><path d="M40 70c10-14 30-16 40-6M95 70c10-12 28-14 38-4M140 68c8-8 20-6 24 2"/>',
  schale: '<path d="M40 85h120c0 26-26 40-60 40s-60-14-60-40z"/><path d="M52 85c4-14 18-20 30-14 8-10 26-10 34 0 12-6 28 0 32 14"/>',
  sauce: '<path d="M48 84h96c0 22-20 36-48 36s-48-14-48-36z"/><path d="M144 90c12-2 20 6 14 16"/><path d="M48 84c-8-2-14-8-14-14"/><path d="M76 132h48"/><path d="M100 120v12"/>',
  stift: '<path d="M60 125l6-22 62-62 16 16-62 62z"/><path d="M66 103l16 16M120 49l16 16"/><path d="M40 130h120"/>'
};
const MOTIF_CAT = [[/kekse|plätzchen/, "kekse"], [/kuchen|gebäck|torte/, "kuchen"], [/brot|teig/, "brot"], [/dessert|nachtisch/, "pudding"], [/pasta|auflauf|aufläufe|nudel/, "lasagne"], [/snack|finger/, "nuggets"], [/sauce|soße|dip/, "sauce"], [/beilage|salat/, "schale"], [/draft|entw/, "stift"]];
function motif(c) {
  const k = String(c || "").toLowerCase(), m = MOTIF_CAT.find(([re]) => re.test(k));
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "20 30 160 105"); s.setAttribute("class", "sl-mot"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = MOTIFS[m ? m[1] : "topf"]; return s;
}
function romanNum(n) { const t = [[50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]; let r = ""; for (const [v, x] of t) while (n >= v) { r += x; n -= v; } return r; }
function renderCarousel(host, names, groups) {
  const wide = window.matchMedia("(min-width: 900px)").matches;
  let idx = Math.max(0, names.indexOf(state.carCat));
  const slides = names.map((c, i) => {
    const rs = groups.get(c).sort((a, b) => a.title.localeCompare(b.title, "de"));
    const draft = catRank(c) === 2;
    const ul = h("ul", { class: "sl-lst" }, rs.map(r => {
      const time = (r.prep_min || 0) + (r.cook_min || 0);
      if (draft && isGuest()) return h("li", null, h("span", { class: "sl-ln off" }, h("span", { class: "t" }, r.title || "Ohne Titel"), h("span", { class: "tm" }, "folgt bald")));
      return h("li", null, h("a", { href: "#rezept-" + r.id, class: "sl-ln" }, h("span", { class: "t" }, r.title || "Ohne Titel"), h("span", { class: "tm" }, time ? fmtMin(time) : "")));
    }));
    if (wide && rs.length > 1) { ul.style.gridTemplateRows = "repeat(" + Math.ceil(rs.length / 2) + ", var(--row))"; ul.classList.add("two"); }
    const fade = () => ul.classList.toggle("more", ul.scrollHeight - ul.scrollTop - ul.clientHeight > 4);
    ul.addEventListener("scroll", fade, { passive: true });
    requestAnimationFrame(fade);
    return h("section", { class: "slide" + (draft ? " draft" : "") + (i === idx ? " on" : ""), "aria-label": c, onclick: e => { if (!e.currentTarget.classList.contains("on")) { e.preventDefault(); goTo(i); } } },
      h("header", { class: "sl-h" },
        h("div", null,
          h("div", { class: "sl-no" }, draft ? "Entwürfe" : "Kapitel " + romanNum(i + 1)),
          h("h2", null, c),
          h("div", { class: "sl-cnt" }, rs.length + (rs.length === 1 ? " Rezept" : " Rezepte"))),
        motif(c)),
      h("div", { class: "sl-rule" }), ul);
  });
  const car = h("div", { class: "car" }, slides);
  const left = h("button", { class: "car-ar l", "aria-label": "Vorherige Kategorie", onclick: () => goTo(idx - 1) }, icon("chevL"));
  const right = h("button", { class: "car-ar r", "aria-label": "Nächste Kategorie", onclick: () => goTo(idx + 1) }, icon("chevR"));
  const dots = h("div", { class: "car-dots" }, names.map((c, i) => h("button", { "aria-label": c, class: i === idx ? "on" : "", onclick: () => goTo(i) })));
  const wrap = h("div", { class: "car-wrap" }, car, left, right, dots);
  host.replaceChildren(wrap);
  const step = () => { const a = slides[0], b = slides[1]; return b ? b.offsetLeft - a.offsetLeft : car.clientWidth; };
  function mark(i) {
    idx = i; state.carCat = names[i] || "";
    slides.forEach((s, k) => s.classList.toggle("on", k === i));
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
    left.hidden = i <= 0; right.hidden = i >= names.length - 1;
  }
  function goTo(i, snapBack) { if (i < 0 || i >= names.length) { if (snapBack) i = idx; else return; } car.scrollTo({ left: i * step(), behavior: "smooth" }); mark(i); }
  // Wischen selbst steuern (Finger und Maus), damit es überall gleich funktioniert
  let drag = null, moved = false;
  car.addEventListener("pointerdown", e => {
    if (e.button > 0 || e.target.closest("button")) return;
    drag = { x: e.clientX, y: e.clientY, left: car.scrollLeft, id: e.pointerId, t: Date.now(), on: false }; moved = false;
  });
  car.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) { if (Math.abs(dy) > 12) drag = null; return; }
      drag.on = true; moved = true; car.classList.add("dragging");
      try { car.setPointerCapture(e.pointerId); } catch (x) {}
    }
    const edge = (idx === 0 && dx > 0) || (idx === names.length - 1 && dx < 0);
    car.scrollLeft = drag.left - (edge ? dx / 3 : dx);
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; car.classList.remove("dragging");
    if (!d.on) return;
    const dx = e.clientX - d.x, fast = Math.abs(dx) / Math.max(1, Date.now() - d.t) > 0.35;
    const th = step() * 0.25;
    goTo(dx < -th || (fast && dx < -20) ? idx + 1 : dx > th || (fast && dx > 20) ? idx - 1 : idx, true);
  };
  car.addEventListener("pointerup", end); car.addEventListener("pointercancel", end);
  car.addEventListener("click", e => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  car.addEventListener("dragstart", e => e.preventDefault());
  sizeCarousel();
  car.scrollLeft = idx * step();
  mark(idx);
}
function sizeCarousel() {
  const w = document.querySelector(".car-wrap"); if (!w) return;
  const top = w.getBoundingClientRect().top + window.scrollY;
  w.style.height = Math.max(360, window.innerHeight - top) + "px";
}
let carWide = window.matchMedia("(min-width: 900px)").matches;
window.addEventListener("resize", () => { if (!document.querySelector(".car-wrap")) return; const w = window.matchMedia("(min-width: 900px)").matches; if (w !== carWide) { carWide = w; renderGridOnly(); } else sizeCarousel(); });
document.addEventListener("click", e => { if (state.menuOpen && !e.target.closest(".h-tools")) { state.menuOpen = false; render(); } });

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/>',
  snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 2 3-2M9 20l3-2 3 2M4 10.5l3.5-.5L6 6.8M20 13.5l-3.5.5 1.5 3.2M4 13.5l3.5.5L6 17.2M20 10.5l-3.5-.5L18 6.8"/>',
  play2: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3.2"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/>',
  oven: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 8h18"/><rect x="7" y="11" width="10" height="7" rx="1.5"/><path d="M7 5.5h.01M10.5 5.5h.01"/>',
  flame: '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6 0-3.4 2.6-5.6 4-8.5.4 2 1.6 3.2 2.8 3.2 0-2 .6-4.3 2.2-6.2.8 3.1 4 5.8 4 10 0 4.1-2.7 7.5-6.5 7.5z"/>',
  pot: '<path d="M4 10h16M5 10v7a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-7M2.5 10h2M19.5 10h2M9 7c-.9-1.1.9-1.7 0-3M15 7c-.9-1.1.9-1.7 0-3"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  list: '<path d="M9.5 6H20M9.5 12H20M9.5 18H20"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.8"/>',
  cards: '<rect x="6.5" y="4" width="11" height="16" rx="2.5"/><path d="M3 7.5v9M21 7.5v9"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  chevL: '<path d="M15 4.5L7.5 12l7.5 7.5"/>',
  chevR: '<path d="M9 4.5l7.5 7.5L9 19.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
};
function icon(name, filled) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ic" + (filled ? " filled" : "")); s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name]; return s;
}
function renderDetail(id) {
  const r = findRecipe(id);
  if (!r) {
    app.append(h("button", { class: "btn ghost back", onclick: () => go("") }, "← Alle Rezepte"),
      h("div", { class: "empty" }, h("h2", null, state.loaded ? "Rezept nicht gefunden" : "Rezept wird geladen …"), h("p", null, state.loaded ? "Vielleicht wurde es auf einem anderen Gerät gelöscht." : "")));
    return;
  }
  app.classList.add("full");
  const f = scaled(r), now = state.servings[r.id] || r.servings;
  const tab = state.tab || "ing";
  const src = photoSrc(r);
  const total = (r.prep_min || 0) + (r.cook_min || 0);
  const n = (r.ingredients || []).some(i => !i.section) ? computeNutrition(r) : null;

  const nPh = photoPaths(r).length;
  const hero = h("div", { class: "d-hero noimg" },
    h("img", { src: catImage(r.category), alt: "", class: "std" }),
    h("div", { class: "d-bar" },
      h("button", { class: "round", "aria-label": "Zurück", onclick: () => go("") }, icon("back")),
      h("div", null,
        src ? h("button", { class: "round ph-open", "aria-label": nPh > 1 ? nPh + " Fotos ansehen" : "Foto ansehen", onclick: () => openPhotos(r) }, icon("image"), nPh > 1 ? h("span", { class: "ph-n" }, String(nPh)) : null) : null,
        h("button", { class: "round" + (r.favorite ? " fav-on" : ""), "aria-label": r.favorite ? "Favorit entfernen" : "Als Favorit merken", "aria-pressed": r.favorite ? "true" : "false", onclick: () => toggleFav(r) }, icon("heart", r.favorite)),
        h("button", { class: "round", "aria-label": "Als PDF teilen", onclick: () => exportPdf([r], safeName(r.title) + ".pdf") }, icon("share")),
        isGuest() ? null : h("button", { class: "round", "aria-label": "Bearbeiten", onclick: () => go("bearbeiten-" + r.id), disabled: !state.online }, icon("pen")))));

  const meta = h("div", { class: "d-meta" },
    r.servings ? h("span", null, icon("people"), servLabel(r, r.servings)) : null,
    total ? h("span", { title: [r.prep_min ? "Vorbereitung " + fmtMin(r.prep_min) : "", r.cook_min ? "Kochen/Backen " + fmtMin(r.cook_min) : ""].filter(Boolean).join(", ") }, icon("clock"), fmtMin(total)) : null,
    null);

  const nut = n ? h("div", { class: "d-nut", role: "list", "aria-label": r.servings ? "Nährwerte " + perLabel(r) : "Nährwerte gesamt" },
    NUT.filter(([k]) => k !== "sugar" && k !== "salt" && k !== "fiber").map(([k, label, unit]) => h("div", { class: k === "kcal" ? "k" : null, role: "listitem" }, h("b", null, fmtNut(n.per[k], k) + unit), label))) : null;

  const seg = h("div", { class: "seg", role: "tablist" },
    h("button", { role: "tab", "aria-selected": tab === "ing" ? "true" : "false", class: tab === "ing" ? "on" : null, onclick: () => { state.tab = "ing"; render(); } }, "Zutaten"),
    h("button", { role: "tab", "aria-selected": tab === "steps" ? "true" : "false", class: tab === "steps" ? "on" : null, onclick: () => { state.tab = "steps"; render(); } }, "Zubereitung"));

  const two = mqTwo.matches;
  let body;
  if (two || tab === "ing") {
    const serv = r.servings ? h("span", { class: "servings" },
      h("button", { "aria-label": "Weniger Portionen", onclick: () => { state.servings[r.id] = Math.max(1, now - 1); render(); } }, "−"),
      h("span", null, servLabel(r, now)),
      h("button", { "aria-label": "Mehr Portionen", onclick: () => { state.servings[r.id] = now + 1; render(); } }, "+")) : null;
    // eine zusammengerechnete Liste: gleiche Zutat mit gleicher Einheit wird addiert
    const all = consolidate(r.ingredients || []);
    const bas = basicsOf(r), basIds = new Set(bas.map(x => x.rr.id));
    const rest = bas.length ? all.filter(i => !(i.ref && basIds.has(i.ref))) : all;
    const groups = rest.length ? [{ title: bas.length ? "Außerdem" : "", items: rest }] : [];
    state.openBas = state.openBas || {};
    const basBlock = bas.length ? h("div", { class: "d-bas" }, h("div", { class: "sec" }, "Basics"), bas.map(({ i, rr }) => {
      const key = r.id + ":" + rr.id, open = !!state.openBas[key], bf = f * basicFactor(i, rr);
      const q = [fmtQty(i.qty != null ? i.qty * f : null), i.unit].filter(Boolean).join(" ");
      return h("div", { class: "bas" + (open ? " open" : "") },
        h("button", { class: "bas-h", "aria-expanded": open ? "true" : "false", onclick: () => { state.openBas[key] = !open; render(); } },
          icon("link"), h("span", { class: "bas-n" }, i.name || rr.title), h("span", { class: "bas-q" }, q), h("span", { class: "bas-c", "aria-hidden": "true" }, "›")),
        open ? h("div", { class: "bas-sub" },
          h("ul", { class: "d-ing" }, consolidate(rr.ingredients || []).map(x => h("li", null,
            h("span", { class: "qty" }, [fmtQty(x.qty != null ? x.qty * bf : null), x.unit].filter(Boolean).join(" ")), ingName(x)))),
          h("a", { class: "bas-go", href: "#rezept-" + rr.id, onclick: e => { e.preventDefault(); openRecipe(rr.id); } }, "Rezept öffnen ›")) : null);
    })) : null;
    body = h("div", null,
      h("div", { class: "d-row" }, h("span", { class: "sec" }, !bas.length && groups[0] && groups[0].title ? groups[0].title : ""), serv),
      basBlock,
      groups.length || bas.length ? groups.map((g, gi) => [gi > 0 || bas.length ? h("div", { class: "sec d-sec" }, g.title) : null,
        h("ul", { class: "d-ing" }, g.items.map(i => h("li", null,
          h("span", { class: "qty" }, [fmtQty(i.qty != null ? i.qty * f : null), i.unit].filter(Boolean).join(" ")),
          ingName(i))))]) : h("p", { class: "meta" }, "Keine Zutaten eingetragen."),
      nutritionBlock(r));
  }
  if (two || tab !== "ing") {
    const ingBody = body;
    body = stepList(r).length ? h("div", { class: "steps-wrap" }, stepGroups(r).filter(g => g.items.length).map((g, gi) => [
        g.title ? h("div", { class: "sec" + (gi > 0 ? " d-sec" : "") }, g.title) : null,
        h("ol", { class: "steps" }, g.items.map(s => h("li", null, h("div", null, h("p", null, linkedText(s)), stepTimerLine(s), stepIngLine(r, s, f, "step-ings", g.links)))))]))
      : h("p", { class: "meta" }, "Keine Schritte eingetragen.");
    if (two) body = h("div", { class: "d-cols" },
      h("section", { class: "d-col-ing" }, h("h3", { class: "d-colh" }, "Zutaten"), ingBody),
      h("section", { class: "d-col-steps" }, h("h3", { class: "d-colh" }, "Zubereitung"), body));
  }

  app.append(h("div", { class: "d-blur", "aria-hidden": "true", style: "background-image:url('" + String(catImage(r.category)).replace(/'/g, "%27") + "')" }));
  app.append(h("div", { class: "d-foot", "aria-hidden": "true" }));
  app.append(hero, h("div", { class: "d-sheet" },
    h("div", { class: "grab", "aria-hidden": "true" }),
    r.category ? h("div", { class: "sec" }, r.category) : null,
    h("h2", { class: "d-title" }, r.title),
    meta,
    r.notes ? h("p", { class: "notes" }, linkedText(r.notes)) : null,
    nut, two ? null : seg, body,
    r.source ? h("div", { class: "meta d-src" }, "Quelle: ", /^https?:\/\//.test(r.source) ? h("a", { href: r.source, target: "_blank", rel: "noopener" }, r.source.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)) : r.source) : null,
    stepList(r).length ? h("div", { class: "d-dock" }, h("button", { class: "btn primary", onclick: () => openCook(r) }, icon("play"), "Kochmodus starten")) : null));
}

function ingName(i) {
  const rr = i.ref && findRecipe(i.ref);
  return rr ? h("a", { class: "rlink", href: "#rezept-" + rr.id, onclick: e => { e.preventDefault(); openRecipe(rr.id); } }, i.name || rr.title) : h("span", null, i.name);
}
// ---------- nutrition ----------
const NUT = [["kcal", "kcal", ""], ["protein", "Eiweiß", " g"], ["carbs", "Kohlenh.", " g"], ["sugar", "davon Zucker", " g"], ["fat", "Fett", " g"], ["fiber", "Ballastst.", " g"], ["salt", "Salz", " g"]];
let builtinIndex = null;
function foodIndex() {
  if (!builtinIndex) {
    builtinIndex = [];
    (window.NUTRITION_TABLE || []).forEach(row => {
      const [names, kcal, protein, carbs, sugar, fat, fiber, salt, ex] = row;
      const food = { kcal, protein, carbs, sugar, fat, fiber, salt, p: ex.p, d: ex.d, pk: ex.pk, label: names.split("|")[0] };
      names.split("|").forEach(n => builtinIndex.push({ key: norm(n), food }));
    });
  }
  const own = state.foods.map(f => ({ key: norm(f.name), food: { kcal: +f.kcal, protein: +f.protein, carbs: +f.carbs, sugar: +f.sugar, fat: +f.fat, fiber: +f.fiber, salt: +f.salt, p: f.piece_g ? +f.piece_g : undefined, label: f.name, own: true } }));
  return own.concat(builtinIndex);
}
function matchFood(name, idx) {
  const n = " " + norm(name).replace(/[(),.;]/g, " ").replace(/\s+/g, " ") + " ";
  let best = null;
  for (const e of idx) {
    const k = e.key; if (!k) continue;
    const pos = n.indexOf(" " + k);
    if (pos < 0 && (k.length < 4 || !n.includes(k))) continue;
    // Wortanfang bevorzugt; Teilwort (z. B. "weizenmehl" enthält "mehl") zählt auch
    const after = pos >= 0 ? n.charAt(pos + 1 + k.length) : n.charAt(n.indexOf(k) + k.length);
    if (!/[\s]|n|s|e/.test(after)) continue;
    const score = k.length + (pos >= 0 ? 2 : 0) + (e.food.own ? 100 : 0);
    if (!best || score > best.score) best = { score, food: e.food };
  }
  return best && best.food;
}
function gramsFor(i, food) {
  const U = window.UNIT_GRAMS || {};
  if (i.qty == null) return { g: 0, note: "ohne Menge" };
  if (!i.unit) {
    if (food.p) return { g: i.qty * food.p };
    if (food.pk) return { g: i.qty * food.pk };
    return { g: null, note: "Menge unklar" };
  }
  const u = U[i.unit] || U[Object.keys(U).find(k => k.toLowerCase() === i.unit.toLowerCase())];
  if (!u) return { g: null, note: "Einheit unbekannt" };
  if (u.g != null) return { g: i.qty * u.g };
  if (u.ml != null) return { g: i.qty * u.ml * (food.d || 1) };
  if (u.piece) return food.p ? { g: i.qty * food.p } : u.fallback ? { g: i.qty * u.fallback } : { g: null, note: "Stückgewicht fehlt" };
  if (u.pack) return { g: i.qty * (food.pk || u.fallback) };
  return { g: null };
}
function computeNutrition(r, depth) {
  const idx = foodIndex(), total = {}, rows = [];
  NUT.forEach(([k]) => total[k] = 0);
  (r.ingredients || []).filter(i => !i.section).forEach(i => {
    const rr = i.ref && i.ref !== r.id && (depth || 0) < 3 && findRecipe(i.ref);
    if (rr) { // Basic: dessen Nährwerte anteilig mitrechnen
      const sub = computeNutrition(rr, (depth || 0) + 1), bf = basicFactor(i, rr) * (rr.servings || 1);
      NUT.forEach(([k]) => total[k] += (sub.per[k] || 0) * bf);
      rows.push({ i, kcal: (sub.per.kcal || 0) * bf }); sub.missing.forEach(x => rows.push(x)); return; }
    const food = matchFood(i.name, idx);
    if (!food) { rows.push({ i, miss: "nicht in der Tabelle" }); return; }
    const { g, note } = gramsFor(i, food);
    if (g == null) { rows.push({ i, food, miss: note }); return; }
    NUT.forEach(([k]) => total[k] += (food[k] || 0) * g / 100);
    rows.push({ i, food, g, kcal: (food.kcal || 0) * g / 100, note });
  });
  const div = r.servings || 1, per = {};
  NUT.forEach(([k]) => per[k] = total[k] / div);
  return { per, rows, missing: rows.filter(x => x.miss) };
}
function fmtNut(v, k) { if (v == null) return "–"; return k === "kcal" ? String(Math.round(v)) : (v < 10 ? String(Math.round(v * 10) / 10).replace(".", ",") : String(Math.round(v))); }
function nutritionBlock(r) {
  const ings = (r.ingredients || []).filter(i => !i.section);
  if (!ings.length) return null;
  const n = computeNutrition(r);
  const per = n.per;
  const item = (label, k, sub) => h("span", { class: sub ? "nv sub" : "nv" }, label + " ", h("b", null, fmtNut(per[k], k) + " g"));
  const missNames = n.missing.map(x => x.i.name);
  return h("section", { class: "nut" },
    h("p", { class: "nut-head" }, h("b", null, fmtNut(per.kcal, "kcal") + " kcal"), " " + (r.servings ? perLabel(r) : "ganzes Rezept")),
    h("p", { class: "nut-vals" },
      [item("Fett", "fat"), item("Kohlenhydrate", "carbs"), item("davon Zucker", "sugar", true),
      item("Eiweiß", "protein"), item("Ballaststoffe", "fiber"), item("Salz", "salt")].flatMap(x => [x, " "])),
    h("small", null, "Schätzwerte" + (missNames.length ? " · nicht mitgerechnet: " + missNames.join(", ") : "")),
    n.missing.some(x => !x.food) && state.online && !isGuest() ? foodFormFor(n.missing.filter(x => !x.food).map(x => x.i.name)) : null);
}
function foodFormFor(names) {
  const ff = state.foodForm;
  if (!ff) return h("details", null, h("summary", null, "Fehlende Zutat eintragen"),
    h("div", { class: "actions", style: "margin-top:8px" }, names.map(n => h("button", { class: "btn", onclick: () => { state.foodForm = { name: n }; render(); } }, n))));
  const num = (id, label) => h("label", { class: "field" }, h("span", null, label), h("input", { id, type: "number", step: "any", min: "0", inputmode: "decimal" }));
  const form = h("form", { class: "food-form", novalidate: true },
    h("label", { class: "field full" }, h("span", null, "Name der Zutat"), h("input", { id: "ff-name", value: ff.name }), h("small", null, "Werte pro 100 g, z. B. von der Verpackung.")),
    num("ff-kcal", "kcal"), num("ff-protein", "Eiweiß g"), num("ff-carbs", "Kohlenh. g"), num("ff-sugar", "Zucker g"), num("ff-fat", "Fett g"), num("ff-fiber", "Ballastst. g"), num("ff-salt", "Salz g"),
    num("ff-piece", "1 Stück wiegt g"),
    h("div", { class: "actions full" }, h("button", { type: "submit", class: "btn primary" }, "Zutat speichern"), h("button", { type: "button", class: "btn", onclick: () => { state.foodForm = null; render(); } }, "Abbrechen")));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const v = id => { const x = parseFloat(form.querySelector("#" + id).value.replace(",", ".")); return isNaN(x) ? 0 : x; };
    const name = form.querySelector("#ff-name").value.trim();
    if (!name) return;
    const row = { name, kcal: v("ff-kcal"), protein: v("ff-protein"), carbs: v("ff-carbs"), sugar: v("ff-sugar"), fat: v("ff-fat"), fiber: v("ff-fiber"), salt: v("ff-salt"), piece_g: v("ff-piece") || null };
    const { error } = await sb.from("foods").upsert(row, { onConflict: "user_id,name" });
    if (error) { toast("Speichern hat nicht geklappt: " + error.message); return; }
    state.foodForm = null; toast("Zutat gespeichert"); loadAll();
  });
  return form;
}

// ---------- form ----------
function clearDraftPhoto() { (state.draftPhotos || []).forEach(d => d.previewUrl && URL.revokeObjectURL(d.previewUrl)); state.draftPhotos = null; state.photoSel = 0; }
function readIngs() {
  const out = [];
  document.querySelectorAll("#ing-boxes .ing-box").forEach(b => {
    const t = b.querySelector(".ing-box-name").value.trim().replace(/:+$/, "");
    const items = [...b.querySelectorAll(".ing-row")].map(r => {
      const q = r.querySelector(".ing-q").value.trim(), n = r.querySelector(".ing-n").value.trim().replace(/:+$/, "");
      if (!q && !n) return null;
      const p = parseIngredient((q ? q + " " : "") + n);
      const o = p && p.section ? { qty: null, unit: "", name: n } : p;
      if (o && r.dataset.ref) o.ref = r.dataset.ref;
      return o;
    }).filter(Boolean);
    if (t && (items.length || b.parentNode.children.length > 1)) out.push({ section: t });
    out.push(...items);
  });
  return out;
}
function ingEditor(list) {
  const groups = []; let cur = { title: "", items: [] };
  list.forEach(i => { if (i.section) { if (cur.items.length || cur.title) groups.push(cur); cur = { title: i.section, items: [] }; } else cur.items.push(i); });
  if (cur.items.length || cur.title || !groups.length) groups.push(cur);
  const boxes = h("div", { class: "ing-boxes", id: "ing-boxes" });
  const mark = () => boxes.classList.toggle("multi", boxes.children.length > 1);
  // Zeile: Menge | Zutat | verschieben | löschen
  const row = (i, list, after, focus) => {
    const q = h("input", { type: "text", class: "ing-q", placeholder: "Menge", "aria-label": "Menge", value: i ? [fmtQty(i.qty), i.unit].filter(Boolean).join(" ") : "", autocomplete: "off" });
    const n = h("input", { type: "text", class: "ing-n", placeholder: "Zutat", "aria-label": "Zutat", value: i ? i.name || "" : "", autocomplete: "off" });
    const grip = h("span", { class: "ing-grip", "aria-hidden": "true", title: "Ziehen zum Verschieben" }, "≡");
    const del = h("button", { type: "button", class: "ing-x", "aria-label": "Zutat entfernen", onclick: e => { e.preventDefault(); const nx = el.nextElementSibling || el.previousElementSibling; el.remove(); if (nx) nx.querySelector(".ing-n").focus(); } }, "×");
    const lk = h("button", { type: "button", class: "ing-lk", "aria-label": "Rezept verlinken", title: "Rezept verlinken" }, icon("link"));
    const el = h("div", { class: "ing-row" }, q, n, lk, grip, del);
    const setRef = id => { if (id) el.dataset.ref = id; else delete el.dataset.ref; el.classList.toggle("linked", !!id); };
    setRef(i && i.ref && findRecipe(i.ref) ? i.ref : null);
    lk.addEventListener("click", e => { e.preventDefault(); openRecipeDialog(el.dataset.ref, rr => { setRef(rr ? rr.id : null); if (rr && !n.value.trim()) n.value = rr.title; }); });
    // Enter: neue Zeile darunter
    n.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); row(null, list, el, true); } });
    q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); n.focus(); } });
    // Mehrere Zeilen einfügen: auf Zeilen verteilen
    const onPaste = e => {
      const t = (e.clipboardData || window.clipboardData).getData("text");
      if (!t || !t.includes("\n")) return;
      e.preventDefault();
      let at = el; const ls = t.split("\n").map(l => l.trim()).filter(Boolean);
      ls.forEach((l, k) => {
        const p = parseIngredient(l) || {};
        const item = p.section ? { name: p.section } : p;
        if (k === 0 && !q.value && !n.value) { q.value = [fmtQty(item.qty), item.unit].filter(Boolean).join(" "); n.value = item.name || ""; }
        else at = row(item, list, at);
      });
    };
    n.addEventListener("paste", onPaste); q.addEventListener("paste", onPaste);
    // Verschieben per Ziehen (Finger oder Maus)
    grip.addEventListener("pointerdown", e => {
      e.preventDefault(); el.classList.add("drag");
      const move = ev => {
        const rows = [...boxes.querySelectorAll(".ing-row")].filter(r => r !== el);
        const hit = rows.find(r => { const b = r.getBoundingClientRect(); return ev.clientY >= b.top && ev.clientY <= b.bottom; });
        if (hit) { const b = hit.getBoundingClientRect(); if (ev.clientY < b.top + b.height / 2) hit.before(el); else hit.after(el); }
        // in leere Liste eines Abschnitts ziehen
        boxes.querySelectorAll(".ing-rows").forEach(lb => { if (!lb.children.length || (lb.children.length === 1 && lb.firstChild === el)) { const r = lb.getBoundingClientRect(); if (ev.clientY >= r.top - 20 && ev.clientY <= r.bottom + 20) lb.append(el); } });
      };
      const up = () => { el.classList.remove("drag"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    });
    if (after) after.after(el); else list.append(el);
    if (focus) n.focus();
    return el;
  };
  const box = (g, focus) => {
    const name = h("input", { type: "text", class: "ing-box-name", placeholder: "Name der Liste, z. B. Teig", "aria-label": "Name der Zutatenliste", value: g.title || "" });
    const list = h("div", { class: "ing-rows" });
    const del = h("button", { type: "button", class: "ing-box-del", "aria-label": "Abschnitt entfernen", onclick: e => {
      e.preventDefault();
      const filled = [...list.querySelectorAll("input")].some(i => i.value.trim());
      if (filled && del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Wirklich entfernen?"; return; }
      el.remove(); mark();
    } }, "Entfernen");
    const el = h("div", { class: "ing-box" }, h("div", { class: "ing-box-head" }, name, del), list,
      h("button", { type: "button", class: "ing-add", onclick: e => { e.preventDefault(); row(null, list, null, true); } }, "+ Zutat hinzufügen"));
    (g.items.length ? g.items : [null]).forEach(i => row(i, list));
    boxes.append(el); mark();
    if (focus) name.focus();
    return el;
  };
  groups.forEach(g => box(g));
  ingEditor.addBox = n => { const el = box({ title: n, items: [] }); };
  return h("div", { class: "ing-edit" }, boxes,
    h("button", { type: "button", class: "btn", onclick: e => { e.preventDefault(); box({ title: "", items: [] }, true); } }, "+ Neue Zutatenliste"));
}
function splitSteps(t) { let a = t.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean); if (a.length === 1 && a[0].includes("\n")) a = a[0].split("\n").map(s => s.trim()).filter(Boolean); return a; }
function readSteps() {
  const out = [];
  document.querySelectorAll("#step-boxes .ing-box").forEach(b => {
    const t = b.querySelector(".ing-box-name").value.trim().replace(/^#+\s*/, "").replace(/:+$/, "").replace(/\|/g, "/");
    const links = JSON.parse(b.dataset.links || "[]");
    const items = splitSteps(b.querySelector("textarea").value).map(s => s.replace(/^#+\s+/, ""));
    if (!items.length) return;
    const tm = b.dataset.timer ? JSON.parse(b.dataset.timer) : null;
    if (tm) { const i = Math.min(tm.idx, items.length - 1); items[i] = items[i] + " " + tm.tok; }
    if (t || links.length || out.length) out.push("# " + t + " | " + links.join(", "));
    out.push(...items);
  });
  return out;
}
function ingSectionNames() {
  return [...document.querySelectorAll("#ing-boxes .ing-box-name")].map(i => i.value.trim().replace(/:+$/, "")).filter(Boolean);
}
// Fenster: Zutatenlisten für einen Schritt auswählen oder neue anlegen
function openLinkDialog(current, done) {
  let sel = current.slice();
  const close = () => { ov.remove(); document.removeEventListener("keydown", esc); };
  const esc = e => { if (e.key === "Escape") close(); };
  const list = h("div", { class: "dlg-list" });
  const draw = () => {
    const names = ingSectionNames();
    sel.filter(n => !names.some(x => x.toLowerCase() === n.toLowerCase())).forEach(n => names.push(n));
    list.replaceChildren(...(names.length ? names.map(n => {
      const on = sel.some(x => x.toLowerCase() === n.toLowerCase());
      return h("button", { type: "button", class: "dlg-opt" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", onclick: e => {
        e.preventDefault(); sel = on ? sel.filter(x => x.toLowerCase() !== n.toLowerCase()) : sel.concat(n); draw();
      } }, h("span", { class: "dlg-check", "aria-hidden": "true" }, on ? "✓" : ""), n);
    }) : [h("p", { class: "dlg-empty" }, "Noch keine benannte Zutatenliste. Leg unten eine an.")]));
  };
  const newName = h("input", { type: "text", placeholder: "z. B. Streusel", "aria-label": "Name der neuen Zutatenliste" });
  const create = e => {
    e && e.preventDefault();
    const n = newName.value.trim().replace(/[:|,]/g, ""); if (!n) { newName.focus(); return; }
    if (!ingSectionNames().some(x => x.toLowerCase() === n.toLowerCase()) && ingEditor.addBox) ingEditor.addBox(n);
    if (!sel.some(x => x.toLowerCase() === n.toLowerCase())) sel.push(n);
    newName.value = ""; draw();
  };
  newName.addEventListener("keydown", e => { if (e.key === "Enter") create(e); });
  const box = h("div", { class: "dlg", role: "dialog", "aria-modal": "true", "aria-label": "Zutatenliste verknüpfen" },
    h("h3", null, "Zutatenliste verknüpfen"),
    list,
    h("div", { class: "dlg-new" }, h("span", null, "Neue Zutatenliste anlegen"),
      h("div", { class: "link-new-row" }, newName, h("button", { type: "button", class: "btn", onclick: create }, "Anlegen"))),
    h("div", { class: "dlg-btns" },
      h("button", { type: "button", class: "btn", onclick: e => { e.preventDefault(); close(); } }, "Abbrechen"),
      h("button", { type: "button", class: "btn primary", onclick: e => { e.preventDefault(); close(); done(sel); } }, "Fertig")));
  const ov = h("div", { class: "dlg-ov", onclick: e => { if (e.target === ov) close(); } }, box);
  draw();
  document.body.append(ov);
  document.addEventListener("keydown", esc);
}
// Fenster: anderes Rezept auswählen
function openRecipeDialog(currentId, done, insertMode) {
  const close = () => { ov.remove(); document.removeEventListener("keydown", esc); };
  const esc = e => { if (e.key === "Escape") close(); };
  const self = state.route && state.route.id;
  const q = h("input", { type: "search", placeholder: "Rezept suchen", "aria-label": "Rezept suchen", autocomplete: "off" });
  const list = h("div", { class: "dlg-list dlg-scroll" });
  const draw = () => {
    const k = norm(q.value);
    const rs = state.recipes.filter(x => x.id !== self && (!k || norm(x.title || "").includes(k))).sort((a, b) => (a.title || "").localeCompare(b.title || "", "de"));
    list.replaceChildren(...(rs.length ? rs.map(x => h("button", { type: "button", class: "dlg-opt" + (x.id === currentId ? " on" : ""), onclick: e => { e.preventDefault(); close(); done(x); } },
      h("span", { class: "dlg-check", "aria-hidden": "true" }, x.id === currentId ? "✓" : ""), h("span", null, x.title, h("small", null, x.category || "")))) : [h("p", { class: "dlg-empty" }, "Kein Rezept gefunden.")]));
  };
  q.addEventListener("input", draw);
  const box = h("div", { class: "dlg", role: "dialog", "aria-modal": "true", "aria-label": "Rezept verlinken" },
    h("h3", null, "Rezept verlinken"),
    h("p", { class: "dlg-hint" }, insertMode ? "Der Name wird als Link in den Text eingefügt." : "Die Zutat führt dann zu diesem Rezept."),
    h("div", { class: "search" }, searchIcon(), q), list,
    h("div", { class: "dlg-btns" },
      currentId ? h("button", { type: "button", class: "btn danger", onclick: e => { e.preventDefault(); close(); done(null); } }, "Verlinkung entfernen") : null,
      h("button", { type: "button", class: "btn", onclick: e => { e.preventDefault(); close(); } }, "Abbrechen")));
  const ov = h("div", { class: "dlg-ov", onclick: e => { if (e.target === ov) close(); } }, box);
  draw(); document.body.append(ov); document.addEventListener("keydown", esc);
  setTimeout(() => q.focus(), 50);
}
// Text an der zuletzt benutzten Cursor-Stelle einfügen (sonst am Ende des Schritts)
function insertTok(ta, tok) {
  const has = ta.dataset.sel != null, a = has ? +ta.dataset.sel : ta.value.length, b = has ? +ta.dataset.selEnd : a;
  const pre = ta.value.slice(0, a), sp = pre && !/\s$/.test(pre) ? " " : "";
  ta.value = pre + sp + tok + ta.value.slice(b); const p = a + sp.length + tok.length;
  ta.focus(); ta.setSelectionRange(p, p); ta.dataset.sel = p; ta.dataset.selEnd = p;
}
// Fenster: Timer mit Gerät, Temperatur und Zeit
function devIcon(d) { const k = String(d || "").toLowerCase(); return /brat|herd|pfanne/.test(k) ? "flame" : /koch|topf/.test(k) ? "pot" : /ruh|geh/.test(k) ? "hourglass" : /kühl|kuhl|kalt|frier/.test(k) ? "snow" : "oven"; }
// kleine Zeile unter dem Schritt in der Rezeptansicht: Gerät · Temperatur · Zeit
function stepTimerLine(text, cls) {
  const ts = stepTimers(text); if (!ts.length) return null;
  return ts.map(t => h("p", { class: cls || "step-tmr" },
    t.dev ? h("span", null, icon(devIcon(t.dev)), t.dev) : null,
    t.temp ? h("span", null, icon("thermo"), t.temp) : null,
    h("span", null, icon("timer"), fmtDur(t.sec))));
}
const DEVICES = ["Backen", "Kochen", "Braten", "Ruhen", "Kühlen"];
function openTimerDialog(done) {
  const close = () => { ov.remove(); document.removeEventListener("keydown", esc); };
  const esc = e => { if (e.key === "Escape") close(); };
  let dev = "";
  const devRow = h("div", { class: "tmr-kinds", role: "group", "aria-label": "Art" });
  const drawDev = () => devRow.replaceChildren(...DEVICES.map(d => h("button", { type: "button", class: "tmr-kind" + (dev === d ? " on" : ""), "aria-pressed": dev === d ? "true" : "false", onclick: e => { e.preventDefault(); dev = dev === d ? "" : d; drawDev(); } }, icon(devIcon(d)), h("span", null, d))));
  const num = (label, max) => h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "3", placeholder: "0", "aria-label": label, oninput: e => { e.target.value = e.target.value.replace(/\D/g, ""); } });
  const hh = num("Stunden"), mm = num("Minuten"), temp = num("Temperatur in Grad");
  const ok = e => { e && e.preventDefault(); const sec = ((+hh.value || 0) * 60 + (+mm.value || 0)) * 60; if (!sec) { mm.focus(); return; }
    close(); done({ sec, dev, temp: temp.value ? temp.value + " °C" : "" }); };
  [hh, mm, temp].forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") ok(e); }));
  const box = h("div", { class: "dlg tmr-dlg", role: "dialog", "aria-modal": "true", "aria-label": "Timer" },
    h("div", { class: "tmr-head" }, h("span", { class: "tmr-head-ic" }, icon("timer")), h("h3", null, "Timer")),
    devRow,
    h("div", { class: "tmr-time" },
      h("label", null, hh, h("small", null, "Std.")), h("span", { class: "tmr-colon" }, ":"), h("label", null, mm, h("small", null, "Min."))),
    h("label", { class: "tmr-temp" }, icon("thermo"), h("span", null, "Temperatur"), temp, h("b", null, "°C")),
    h("div", { class: "dlg-btns tmr-btns" },
      h("button", { type: "button", class: "btn", onclick: e => { e.preventDefault(); close(); } }, "Abbrechen"),
      h("button", { type: "button", class: "btn primary", onclick: ok }, "Einfügen")));
  const ov = h("div", { class: "dlg-ov", onclick: e => { if (e.target === ov) close(); } }, box);
  drawDev(); document.body.append(ov); document.addEventListener("keydown", esc); setTimeout(() => mm.focus(), 50);
}
function stepEditor(v) {
  const boxes = h("div", { class: "ing-boxes", id: "step-boxes" });
  const mark = () => boxes.classList.toggle("multi", boxes.children.length > 1);
  const box = (g, focus) => {
    const name = h("input", { type: "text", class: "ing-box-name", placeholder: "Überschrift, z. B. Belegen", "aria-label": "Überschrift des Schritts", value: g.title || "" });
    let links = (g.links || []).slice();
    // Timer-Eintrag {Timer …} nicht im Text zeigen, sondern getrennt merken (mit Absatz-Nummer)
    let timer = null;
    const items = g.items.map((it, i) => it.replace(/[ \t]*\{\s*Timer:?[^}]*\}/gi, m => { if (!timer) timer = { tok: m.trim(), idx: i }; return ""; }).trim());
    const linkRow = h("div", { class: "link-row" });
    const drawLinks = () => {
      el.dataset.links = JSON.stringify(links);
      el.dataset.timer = timer ? JSON.stringify(timer) : "";
      const hasT = !!timer;
      linkRow.replaceChildren(...[
        h("button", { type: "button", class: "ing-add", onclick: e => { e.preventDefault(); openLinkDialog(links, nl => { links = nl; drawLinks(); }); } }, "Zutatenliste verknüpfen"),
        links.length ? h("span", { class: "link-info" }, links.join(", ")) : null,
        hasT ? h("span", { class: "link-info tmr-info-ed" }, icon("timer"), timerLabel(timer.tok)) : null,
        hasT
          ? h("button", { type: "button", class: "ing-add rl-add", onclick: e => { e.preventDefault(); timer = null; drawLinks(); } }, icon("timer"), "Timer entfernen")
          : h("button", { type: "button", class: "ing-add rl-add", onclick: e => { e.preventDefault(); openTimerDialog(t => { const tok = "{Timer " + [fmtDur(t.sec), t.dev, t.temp].join(" | ").replace(/( \| )+$/, "") + "}";
            const at = ta.dataset.sel != null ? +ta.dataset.sel : ta.value.length;
            timer = { tok, idx: Math.max(0, splitSteps(ta.value.slice(0, at)).length - 1) }; drawLinks(); }); } }, icon("timer"), "Timer"),
        h("button", { type: "button", class: "ing-add rl-add", onclick: e => { e.preventDefault(); openRecipeDialog(null, rr => { if (!rr) return;
          insertTok(ta, "[[" + rr.title + "]]"); }, true); } }, icon("link"), "Rezept verlinken")].filter(Boolean));
    };
    const ta = h("textarea", { rows: String(Math.max(5, g.items.length * 2 + 1)), placeholder: "Ofen auf 180 °C vorheizen.\n\nMehl und Eier verrühren.", "aria-label": "Schritte" }, items.join("\n\n"));
    const keepSel = () => { ta.dataset.sel = ta.selectionStart; ta.dataset.selEnd = ta.selectionEnd; };
    ["keyup", "mouseup", "input", "blur"].forEach(ev => ta.addEventListener(ev, keepSel));
    const del = h("button", { type: "button", class: "ing-box-del", onclick: e => {
      e.preventDefault();
      if (ta.value.trim() && del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Wirklich entfernen?"; return; }
      el.remove(); mark();
    } }, "Entfernen");
    const grip = h("span", { class: "ing-grip", "aria-hidden": "true", title: "Ziehen zum Verschieben" }, "≡");
    const el = h("div", { class: "ing-box" }, h("div", { class: "ing-box-head" }, name, del, grip), ta, linkRow);
    drawLinks();
    grip.addEventListener("pointerdown", e => {
      e.preventDefault(); el.classList.add("drag");
      const move = ev => {
        const others = [...boxes.children].filter(b => b !== el);
        const target = others.find(b => { const r = b.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (target) boxes.insertBefore(el, target); else boxes.append(el);
      };
      const up = () => { el.classList.remove("drag"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    });
    boxes.append(el); mark();
    if (focus) name.focus();
  };
  stepGroups(v).forEach(g => box(g));
  return h("div", { class: "ing-edit" }, boxes,
    h("button", { type: "button", class: "btn", onclick: e => { e.preventDefault(); box({ title: "", links: [], items: [] }, true); } }, "+ Schritt"));
}
function renderForm(id) {
  const r = id ? findRecipe(id) : null;
  if (id && !r) { app.append(h("button", { class: "btn ghost back", onclick: () => go("") }, "← Alle Rezepte"), h("div", { class: "empty" }, h("h2", null, state.loaded ? "Rezept nicht gefunden" : "Wird geladen …"))); return; }
  const v = r || {};
  const fld = (label, control, hint) => control.classList && control.classList.contains("ing-edit") ? h("div", { class: "f-sec" }, h("h3", null, label), control, hint ? h("small", null, hint) : null) : h("label", { class: "field" }, h("span", null, label), control, hint ? h("small", null, hint) : null);
  // Portionen ändern: auf Wunsch alle Mengen dauerhaft umrechnen
  const servIn = h("input", { id: "f-serv", type: "number", min: "1", inputmode: "numeric", placeholder: "–", value: v.servings == null ? "" : v.servings });
  const servAsk = h("div", { class: "serv-ask", hidden: "" });
  const curU = (v.servings_unit || "Portion").trim();
  const unitSel = h("select", { id: "f-sunit", class: "f-sunit", "aria-label": "Art der Portion" },
    SERV_UNITS.map(([one, many]) => h("option", { value: one, selected: one.toLowerCase() === curU.toLowerCase() || many.toLowerCase() === curU.toLowerCase() ? true : null }, many)),
    SERV_UNITS.some(x => x[0].toLowerCase() === curU.toLowerCase() || x[1].toLowerCase() === curU.toLowerCase()) ? null : h("option", { value: curU, selected: true }, curU));
  let servBase = v.servings || 0;
  let relabel = false;
  unitSel.addEventListener("change", () => { relabel = true; });
  servIn.addEventListener("change", () => {
    const n = parseInt(servIn.value, 10);
    if (!servBase || !n || n === servBase || !document.querySelector("#ing-boxes .ing-q")) { if (!servBase && n) servBase = n; servAsk.hidden = true; return; }
    if (relabel) { relabel = false; servBase = n; return; } // Art geändert (z. B. 25 Stück -> 1 Blech): nichts umrechnen
    const f = n / servBase;
    document.querySelectorAll("#ing-boxes .ing-q").forEach(q => {
      if (!q.value.trim()) return;
      const p = parseIngredient(q.value.trim() + " x");
      if (!p || p.qty == null) return;
      q.value = [fmtQty(p.qty * f), p.unit].filter(Boolean).join(" ");
    });
    servBase = n; servAsk.hidden = true; toast("Mengen auf " + n + " " + unitSel.selectedOptions[0].textContent + " umgerechnet");
  });
  const mrow = (label, control, unit, extra) => h(extra ? "div" : "label", { class: "mrow" }, h("span", null, label), control, unit ? h("em", null, unit) : null, extra || null);
  const inp = (fid, val, extra) => h("input", Object.assign({ id: fid, value: val == null ? "" : val }, extra || {}));
  const dl = null;
  const curCat = String(v.category || "").trim();
  const catSel = h("select", { id: "f-cat", class: "f-sunit f-catsel", "aria-label": "Kategorie" },
    h("option", { value: "", selected: !curCat ? true : null, disabled: true }, "Bitte wählen"),
    CATS.map(c => h("option", { value: c, selected: c === curCat ? true : null }, c)),
    curCat && !CATS.includes(curCat) ? h("option", { value: curCat, selected: true }, curCat) : null);
  const photoBox = h("div", { class: "photo-pick" });
  const fileIn = h("input", { type: "file", id: "f-photo", accept: "image/*", multiple: true, hidden: true });
  if (!state.draftPhotos) { state.draftPhotos = photoPaths(v).map(path => ({ path })); state.photoSel = 0; }
  const P = () => state.draftPhotos;
  const srcOf = d => d.previewUrl || urlFor(d.path);
  let replaceAt = -1; // >= 0: ausgewähltes Foto ersetzen
  const newItem = (blob, orig) => ({ blob, orig, previewUrl: URL.createObjectURL(blob) });
  fileIn.addEventListener("change", async () => {
    const files = [...(fileIn.files || [])]; fileIn.value = ""; if (!files.length) return;
    try {
      if (files.length === 1) {
        const blob = await editPhoto(files[0]); if (!blob) return;
        const it = newItem(blob, files[0]);
        if (replaceAt >= 0 && P()[replaceAt]) { const old = P()[replaceAt]; old.previewUrl && URL.revokeObjectURL(old.previewUrl); P()[replaceAt] = it; state.photoSel = replaceAt; }
        else { P().push(it); state.photoSel = P().length - 1; }
      } else {
        for (const f of files) P().push(newItem(await prepPhoto(f), f));
        state.photoSel = P().length - 1;
      }
    } catch (e) { toast("Das Bild konnte nicht gelesen werden."); }
    drawPhoto();
  });
  const pick = idx => { replaceAt = idx; fileIn.multiple = idx < 0; fileIn.click(); };
  const editCurrent = async () => {
    const i = state.photoSel, d = P()[i]; if (!d) return;
    try {
      const srcBlob = d.orig || await (await fetch(srcOf(d))).blob();
      const blob = await editPhoto(srcBlob); if (!blob) return;
      d.previewUrl && URL.revokeObjectURL(d.previewUrl);
      P()[i] = newItem(blob, srcBlob); drawPhoto();
    } catch (e) { toast("Das Foto konnte nicht geladen werden."); }
  };
  const camBtn = h("button", { type: "button", class: "round f-cam", "aria-label": "Fotos hinzufügen", onclick: () => pick(-1) });
  function drawPhoto() {
    const list = P(); if (state.photoSel >= list.length) state.photoSel = Math.max(0, list.length - 1);
    const i = state.photoSel;
    camBtn.replaceChildren(...[icon("camera"), list.length ? h("span", { class: "ph-n" }, String(list.length)) : null].filter(Boolean));
    photoBox.hidden = !list.length;
    photoBox.replaceChildren(...[
      list.length ? h("div", { class: "ph-strip" },
        list.map((x, k) => h("button", { type: "button", class: "ph-th" + (k === i ? " on" : ""), "aria-label": "Foto " + (k + 1) + (k === 0 ? " (Titelbild)" : ""), onclick: () => { state.photoSel = k; drawPhoto(); } }, h("img", { src: srcOf(x), alt: "" })))) : null,
      list.length ? h("div", { class: "ph-acts2" },
        i > 0 ? h("button", { type: "button", class: "ph-link", onclick: () => { list.unshift(list.splice(i, 1)[0]); state.photoSel = 0; drawPhoto(); } }, "Als Titelbild") : h("span", { class: "ph-note" }, list.length > 1 ? "Titelbild" : ""),
        h("button", { type: "button", class: "ph-link", onclick: editCurrent }, icon("crop"), "Bearbeiten"),
        h("button", { type: "button", class: "ph-link danger", onclick: () => { const x = list.splice(i, 1)[0]; x.previewUrl && URL.revokeObjectURL(x.previewUrl); drawPhoto(); } }, icon("trash"), "Entfernen")) : null,
      fileIn].filter(Boolean));
  }
  drawPhoto();
  const form = h("form", { class: "form", id: "recipe-form", novalidate: true },
    h("div", { class: "f-top" }, h("button", { type: "button", class: "btn ghost back", onclick: () => r ? go("rezept-" + r.id) : go("") }, "← Abbrechen"), camBtn),
    photoBox,
    h("input", { id: "f-title", class: "f-title", value: v.title || "", required: true, placeholder: "Name des Rezepts", "aria-label": "Titel" }),
    h("div", { class: "meta-list" },
      mrow("Kategorie", null, null, catSel),
      mrow("Menge", servIn, null, unitSel),
      servAsk,
      mrow("Vorbereitung", inp("f-prep", v.prep_min, { type: "number", min: "0", inputmode: "numeric", placeholder: "–" }), "Min."),
      mrow("Kochen/Backen", inp("f-cook", v.cook_min, { type: "number", min: "0", inputmode: "numeric", placeholder: "–" }), "Min."),
      mrow("Suchbegriffe", inp("f-tags", (v.tags || []).join(", "), { placeholder: "z. B. vegan, schnell" }))),
    dl,
    fld("Zutaten", ingEditor(v.ingredients || []),
      "Menge mit Einheit, z. B. 200 g oder 1 TL. Mit ≡ verschieben. Den Listennamen kannst du leer lassen, wenn es nur eine Liste gibt."),
    fld("Zubereitung", stepEditor(v),
      "Überschrift ist optional. Über „Zutatenliste verknüpfen“ wählst du eine Zutatenliste, deren Zutaten dann beim Schritt und im Kochmodus stehen. Mit ≡ verschieben."),
    h("div", { class: "f-sec" }, h("h3", null, "Notizen"), h("textarea", { id: "f-notes", class: "f-notes", rows: "3", placeholder: "Tipps, Varianten, was beim letzten Mal anders war" }, v.notes || "")),
    h("div", { class: "meta-list" }, mrow("Quelle", inp("f-src", v.source, { placeholder: "Webseite, Buch oder Person" }))),
    state.formError ? h("p", { class: "err", role: "alert" }, state.formError) : null,
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "btn primary", disabled: state.saving }, state.saving ? "Wird gespeichert …" : "Speichern"),
      h("button", { type: "button", class: "btn", onclick: () => r ? go("rezept-" + r.id) : go("") }, "Abbrechen"),
      r ? h("button", { type: "button", class: "btn icon-btn", style: "margin-left:auto", title: "Duplizieren", "aria-label": "Rezept duplizieren", disabled: !state.online, onclick: e => duplicateRecipe(r, e.currentTarget) }, icon("copy")) : null,
      r ? h("button", { type: "button", class: "btn danger icon-btn", title: "Löschen", "aria-label": "Rezept löschen", onclick: () => { state.confirmDelete = true; drawConfirm(); } }, icon("trash")) : null),
    h("div", { id: "confirm-host" }));
  function drawConfirm() {
    const host = form.querySelector("#confirm-host");
    host.replaceChildren(state.confirmDelete ? h("div", { class: "confirm" },
      h("span", null, "„" + r.title + "“ wirklich löschen? Das lässt sich nicht rückgängig machen."),
      h("button", { type: "button", class: "btn danger solid", onclick: () => deleteRecipe(r) }, "Ja, löschen"),
      h("button", { type: "button", class: "btn", onclick: () => { state.confirmDelete = false; drawConfirm(); } }, "Abbrechen")) : "");
    if (state.confirmDelete) host.scrollIntoView({ block: "center" });
  }
  form.addEventListener("submit", e => { e.preventDefault(); saveRecipe(r, form); });
  app.append(form);
}
// Foto bearbeiten: Zuschneiden, Drehen, Helligkeit, Kontrast
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function editPhoto(file) {
  const url = URL.createObjectURL(file);
  let img; try { img = await loadImg(url); } finally { URL.revokeObjectURL(url); }
  // Arbeitskopie (max. 2000 px), damit alles flüssig bleibt
  const k0 = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  const base = document.createElement("canvas"); base.width = Math.round(img.naturalWidth * k0); base.height = Math.round(img.naturalHeight * k0);
  base.getContext("2d").drawImage(img, 0, 0, base.width, base.height);
  return new Promise(resolve => {
    let src = base, rot = 0, aspect = "4:3", zoom = 1, ox = 0, oy = 0, bright = 100, contrast = 100;
    const rotate = () => { const c = document.createElement("canvas"); c.width = src.height; c.height = src.width; const x = c.getContext("2d"); x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(src, 0, 0); src = c; ox = oy = 0; zoom = 1; zoomIn.value = "1"; };
    const cv = h("canvas", { class: "pe-canvas" });
    const frame = h("div", { class: "pe-frame" }, h("i"), h("i"), h("i"), h("i"));
    const stage = h("div", { class: "pe-stage" }, cv, frame);
    let W = 0, H = 0, fw = 0, fh = 0, sc = 1;
    const ratio = () => aspect === "4:3" ? 4 / 3 : aspect === "1:1" ? 1 : src.width / src.height;
    const layout = () => {
      const r = stage.getBoundingClientRect(); W = r.width; H = r.height;
      const dpr = window.devicePixelRatio || 1; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px";
      const a = ratio(); fw = Math.min(W - 32, (H - 32) * a); fh = fw / a;
      frame.style.width = fw + "px"; frame.style.height = fh + "px"; frame.style.left = (W - fw) / 2 + "px"; frame.style.top = (H - fh) / 2 + "px";
      draw();
    };
    const clamp = () => {
      sc = Math.max(fw / src.width, fh / src.height) * zoom;
      const mx = Math.max(0, (src.width * sc - fw) / 2), my = Math.max(0, (src.height * sc - fh) / 2);
      ox = Math.max(-mx, Math.min(mx, ox)); oy = Math.max(-my, Math.min(my, oy));
    };
    const draw = () => {
      clamp();
      const x = cv.getContext("2d"), dpr = window.devicePixelRatio || 1;
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
      const dw = src.width * sc, dh = src.height * sc;
      x.drawImage(src, W / 2 + ox - dw / 2, H / 2 + oy - dh / 2, dw, dh);
      cv.style.filter = "brightness(" + bright / 100 + ") contrast(" + contrast / 100 + ")";
    };
    // Ziehen und mit zwei Fingern zoomen
    const pts = new Map(); let last = null, pinch = null;
    stage.addEventListener("pointerdown", e => { e.preventDefault(); stage.setPointerCapture && stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom }; } });
    stage.addEventListener("pointermove", e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; zoom = Math.max(1, Math.min(4, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); zoomIn.value = String(zoom); draw(); return; }
      if (pts.size === 1 && last) { ox += e.clientX - last.x; oy += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; draw(); }
    });
    const end = e => { pts.delete(e.pointerId); pinch = null; const r = [...pts.values()][0]; last = r ? { x: r.x, y: r.y } : null; };
    stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end);
    stage.addEventListener("wheel", e => { e.preventDefault(); zoom = Math.max(1, Math.min(4, zoom * (e.deltaY < 0 ? 1.08 : 0.92))); zoomIn.value = String(zoom); draw(); }, { passive: false });
    const slider = (label, min, max, step, val, on) => { const i = h("input", { type: "range", min, max, step, value: val, "aria-label": label }); i.addEventListener("input", () => on(+i.value)); return [h("label", { class: "pe-sl" }, h("span", null, label), i), i]; };
    const [zoomL, zoomIn] = slider("Zoom", "1", "4", "0.01", "1", v => { zoom = v; draw(); });
    const [brL, brIn] = slider("Helligkeit", "60", "140", "1", "100", v => { bright = v; draw(); });
    const [coL, coIn] = slider("Kontrast", "60", "140", "1", "100", v => { contrast = v; draw(); });
    const fmts = h("div", { class: "pe-fmts", role: "group", "aria-label": "Format" });
    const drawFmts = () => fmts.replaceChildren(...[["4:3", "4:3"], ["1:1", "Quadrat"], ["orig", "Original"]].map(([k, l]) =>
      h("button", { type: "button", class: aspect === k ? "on" : null, "aria-pressed": aspect === k ? "true" : "false", onclick: () => { aspect = k; ox = oy = 0; drawFmts(); layout(); } }, l)));
    drawFmts();
    const close = val => { window.removeEventListener("resize", layout); ov.remove(); resolve(val); };
    const done = () => {
      clamp();
      const sw = fw / sc, sh = fh / sc, sx = src.width / 2 - ox / sc - sw / 2, sy = src.height / 2 - oy / sc - sh / 2;
      const k = Math.min(1, 1400 / Math.max(sw, sh));
      const c = document.createElement("canvas"); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
      const x = c.getContext("2d"); x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
      if (bright !== 100 || contrast !== 100) {
        const d = x.getImageData(0, 0, c.width, c.height), a = d.data, b = bright / 100, ct = contrast / 100;
        for (let i = 0; i < a.length; i += 4) for (let j = 0; j < 3; j++) { const v = (a[i + j] * b - 128) * ct + 128; a[i + j] = v < 0 ? 0 : v > 255 ? 255 : v; }
        x.putImageData(d, 0, 0);
      }
      c.toBlob(bl => close(bl), "image/jpeg", 0.85);
    };
    const ov = h("div", { class: "pe", role: "dialog", "aria-modal": "true", "aria-label": "Foto bearbeiten" },
      h("div", { class: "pe-top" },
        h("button", { type: "button", class: "btn", onclick: () => close(null) }, "Abbrechen"),
        h("h3", null, "Foto bearbeiten"),
        h("button", { type: "button", class: "btn primary", onclick: done }, "Fertig")),
      stage,
      h("div", { class: "pe-tools" },
        h("div", { class: "pe-row" }, fmts, h("button", { type: "button", class: "btn pe-rot", onclick: () => { rotate(); layout(); } }, "↻ Drehen")),
        zoomL, brL, coL));
    document.body.append(ov);
    window.addEventListener("resize", layout);
    requestAnimationFrame(layout);
  });
}
function prepPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1400, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error("blob")), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img")); };
    img.src = url;
  });
}
function uuid() { return (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2)); }
async function saveRecipe(existing, form) {
  const val = id => form.querySelector("#" + id).value;
  const title = val("f-title").trim();
  const scroll = window.scrollY;
  if (!title) { state.formError = "Bitte gib dem Rezept einen Titel."; showFormError(form); return; }
  const num = s => { const n = parseInt(s, 10); return isNaN(n) || n < 0 ? null : n; };
  const data = {
    title, category: val("f-cat").trim(), servings: num(val("f-serv")), servings_unit: val("f-sunit") || "Portion", prep_min: num(val("f-prep")), cook_min: num(val("f-cook")),
    tags: val("f-tags").split(",").map(t => t.trim()).filter(Boolean),
    ingredients: readIngs(),
    steps: readSteps(),
    notes: val("f-notes").trim(), source: val("f-src").trim()
  };
  state.saving = true;
  const btn = form.querySelector('button[type="submit"]'); if (btn) { btn.disabled = true; btn.textContent = "Wird gespeichert …"; }
  let oldPhotos = [];
  try {
    const list = state.draftPhotos || photoPaths(existing || {}).map(path => ({ path }));
    const paths = [];
    for (const d of list) {
      if (d.blob) {
        const path = state.user.id + "/" + uuid() + ".jpg";
        const up = await sb.storage.from("photos").upload(path, d.blob, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw up.error;
        d.path = path; d.blob = null; paths.push(path);
      } else if (d.path) paths.push(d.path);
    }
    data.photo_path = paths[0] || null;
    data.photos = paths.slice(1);
    oldPhotos = photoPaths(existing || {}).filter(x => !paths.includes(x));
    let id;
    if (existing) {
      const res = await sb.from("recipes").update(data).eq("id", existing.id).select("id").single();
      if (res.error) throw res.error; id = existing.id;
    } else {
      const res = await sb.from("recipes").insert(data).select("id").single();
      if (res.error) throw res.error; id = res.data.id;
    }
    if (oldPhotos.length) sb.storage.from("photos").remove(oldPhotos);
    state.saving = false; clearDraftPhoto();
    toast("Gespeichert");
    await loadAll();
    location.replace("#rezept-" + id);
  } catch (e) {
    state.saving = false;
    state.formError = "Speichern hat nicht geklappt (" + errText(e) + "). Bitte versuch es noch einmal.";
    if (btn) { btn.disabled = false; btn.textContent = "Speichern"; }
    showFormError(form);
    window.scrollTo(0, scroll);
  }
}
function showFormError(form) {
  let p = form.querySelector(".err");
  if (!p) { p = h("p", { class: "err", role: "alert" }); form.querySelector(".form-actions").before(p); }
  p.textContent = state.formError;
  p.scrollIntoView({ block: "center" });
}
async function toggleFav(r) {
  r.favorite = !r.favorite; render();
  if (isGuest()) { const f = guestFavs(); r.favorite ? f.add(r.id) : f.delete(r.id); lsSet(GUEST_FAV, [...f]); saveCache(); return; }
  const { error } = await sb.from("recipes").update({ favorite: r.favorite }).eq("id", r.id);
  if (error) { r.favorite = !r.favorite; render(); toast("Favorit konnte nicht gespeichert werden."); }
  else saveCache();
}
// Kopie des gespeicherten Rezepts anlegen (Fotos werden mitkopiert, damit beide unabhängig bleiben) und die Kopie zum Bearbeiten öffnen
async function duplicateRecipe(r, btn) {
  if (btn) btn.disabled = true;
  try {
    const paths = [];
    for (const p of photoPaths(r)) {
      const np = state.user.id + "/" + uuid() + ".jpg";
      const c = await sb.storage.from("photos").copy(p, np);
      if (!c.error) paths.push(np);
    }
    const base = String(r.title || "Rezept").replace(/ \(Kopie( \d+)?\)$/, "");
    let title = base + " (Kopie)", n = 2;
    while (state.recipes.some(x => x.title === title)) title = base + " (Kopie " + n++ + ")";
    const data = { title, category: r.category, servings: r.servings, servings_unit: r.servings_unit, prep_min: r.prep_min, cook_min: r.cook_min,
      tags: r.tags || [], ingredients: JSON.parse(JSON.stringify(r.ingredients || [])), steps: [...(r.steps || [])], notes: r.notes || "", source: r.source || "",
      photo_path: paths[0] || null, photos: paths.slice(1), favorite: false };
    const res = await sb.from("recipes").insert(data).select("id").single();
    if (res.error) throw res.error;
    toast("Kopie angelegt");
    await loadAll();
    location.replace("#bearbeiten-" + res.data.id);
  } catch (e) {
    toast("Duplizieren hat nicht geklappt (" + errText(e) + ").");
    if (btn) btn.disabled = false;
  }
}
async function deleteRecipe(r) {
  const { error } = await sb.from("recipes").delete().eq("id", r.id);
  if (error) { toast("Löschen hat nicht geklappt."); return; }
  if (photoPaths(r).length) sb.storage.from("photos").remove(photoPaths(r));
  state.recipes = state.recipes.filter(x => x.id !== r.id);
  saveCache();
  toast("„" + r.title + "“ gelöscht");
  go("");
}
async function logout() { await sb.auth.signOut(); try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(URL_KEY); } catch (e) {} state.photoUrls = {}; go(""); }


// ---------- Timer ----------
function timerLabel(tok) { const t = stepTimers(tok)[0]; return t ? [fmtDur(t.sec), t.dev, t.temp].filter(Boolean).join(" · ") : ""; }
// Dauer aus einem Timer-Eintrag {Timer 45 Min.} lesen: "45 Min.", "1 Std. 30 Min.", "90" (= Minuten)
const TIME_RE = /(\d+(?:[,.]\d+)?)\s*(Minuten|Minute|Min\.?|Stunden|Stunde|Std\.?|Sekunden|Sek\.?)/gi;
function parseDur(str) {
  str = String(str || ""); let sec = 0, m; TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(str))) { const n = parseFloat(m[1].replace(",", ".")), u = m[2].toLowerCase(); sec += n * (u.startsWith("st") ? 3600 : u.startsWith("se") ? 1 : 60); }
  if (!sec && /^\s*\d+(?:[,.]\d+)?\s*$/.test(str)) sec = parseFloat(str.replace(",", ".")) * 60;
  return Math.round(sec) > 0 && sec <= 24 * 3600 ? Math.round(sec) : 0;
}
// {Timer 45 Min. | Backofen | 175 °C}
function stepTimers(text) {
  const out = []; String(text || "").replace(TTOK, (m, d) => { const [z, dev, temp] = d.split("|").map(x => x.trim()); const sec = parseDur(z); if (sec) out.push({ sec, dev: dev || "", temp: temp || "" }); });
  return out;
}
function fmtClock(s) { s = Math.max(0, Math.ceil(s)); const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60; return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0"); }
function fmtDur(sec) { const hh = Math.floor(sec / 3600), mm = Math.round(sec % 3600 / 60); if (sec < 60) return sec + " Sek."; return [hh ? hh + " Std." : "", mm ? mm + " Min." : ""].filter(Boolean).join(" "); }
state.timers = [];
let audioCtx = null, timerTick = null;
function unlockAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume && audioCtx.resume(); } catch (e) {} }
// Klingeln wie eine alte Eieruhr: schnelles Klöppeln auf eine kleine Glocke
function ring() {
  try { if (!audioCtx) return; const t0 = audioCtx.currentTime + .02, out = audioCtx.createGain(); out.gain.value = .22; out.connect(audioCtx.destination);
    const parts = [[2380, 1], [3460, .55], [5150, .3], [7020, .14]];
    for (let k = 0; k < 42; k++) { const t = t0 + k * .058, jit = 1 + (Math.random() - .5) * .006, vel = .75 + Math.random() * .25;
      parts.forEach(([f, a]) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = "sine"; o.frequency.value = f * jit;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a * vel, t + .002); g.gain.exponentialRampToValueAtTime(.0008, t + .28);
        o.connect(g); g.connect(out); o.start(t); o.stop(t + .3); }); }
  } catch (e) {}
  try { navigator.vibrate && navigator.vibrate([400, 120, 400, 120, 400]); } catch (e) {}
}
function startTimer(sec, name, key) {
  unlockAudio();
  state.timers.push({ id: Date.now() + Math.random(), key: key || "", name: name || "", sec, end: Date.now() + sec * 1000, done: false, rang: 0 });
  drawTimers(); if (state.cook) drawCook();
  if (!timerTick) timerTick = setInterval(tickTimers, 500);
}
function leftOf(t, now) { return t.paused ? t.left : ((t.end - (now || Date.now())) / 1000); }
function findTimer(id) { return state.timers.find(t => t.id === id); }
function pauseTimer(id) { const t = findTimer(id); if (!t || t.done) return; if (t.paused) { t.end = Date.now() + t.left * 1000; t.paused = false; } else { t.left = leftOf(t); t.paused = true; } drawTimers(true); if (state.cook) drawCook(); }
function addMinute(id) { const t = findTimer(id); if (!t) return; if (t.done) { t.done = false; t.rang = 0; t.end = Date.now() + 60000; t.sec = 60; } else if (t.paused) { t.left += 60; t.sec += 60; } else { t.end += 60000; t.sec += 60; } drawTimers(true); if (state.cook) drawCook(); }
function stopTimer(id) { state.timers = state.timers.filter(t => t.id !== id); drawTimers(); if (state.cook) drawCook(); if (!state.timers.length) { clearInterval(timerTick); timerTick = null; } }
function tickTimers() {
  const now = Date.now(); let changed = false;
  state.timers.forEach(t => {
    const left = leftOf(t, now);
    if (left <= 0 && !t.done && !t.paused) { t.done = true; t.rang = 0; changed = true; }
    if (t.done && t.rang < 10 && (!t.last || now - t.last > 4000)) { t.last = now; t.rang++; ring(); }
  });
  if (changed && state.cook) drawCook();
  drawTimers();
  document.querySelectorAll("[data-tkey]").forEach(n => { const t = state.timers.find(x => x.key === n.dataset.tkey); if (t && !t.done) { const x = fmtClock(leftOf(t, now)); n.textContent = x; n.classList.toggle("long", x.length > 5); } });
  document.querySelectorAll("[data-tring]").forEach(n => { const t = state.timers.find(x => x.key === n.getAttribute("data-tring")); if (t && !t.done) { const C = 2 * Math.PI * 64; n.setAttribute("stroke-dashoffset", String(C * (1 - Math.max(0, leftOf(t, now)) / t.sec))); } });
}
function curStepKey() { const c = state.cook; return c && c.step >= 0 ? c.r.id + ":" + c.step + ":" : null; }
function drawTimers(force) {
  let el = document.getElementById("timers");
  const ck = curStepKey(), list = state.timers.filter(t => !ck || !t.key.startsWith(ck));
  if (!list.length) { el && el.remove(); return; }
  if (!el) { el = h("div", { class: "tmr-bar", id: "timers", "aria-live": "polite" }); document.body.append(el); }
  el.classList.toggle("in-cook", !!state.cook);
  const now = Date.now(), sig = list.map(t => t.id + (t.done ? "d" : "") + (t.paused ? "p" : "")).join("|");
  if (!force && el.dataset.sig === sig) { el.querySelectorAll(".tmr-t").forEach((n, k) => { const t = list[k]; n.textContent = t.done ? "Fertig!" : fmtClock(leftOf(t, now)); }); return; }
  el.dataset.sig = sig;
  el.replaceChildren(...list.map(t => h("div", { class: "tmr" + (t.done ? " done" : ""), onclick: t.done ? () => stopTimer(t.id) : null },
    icon("timer"),
    h("span", { class: "tmr-t" }, t.done ? "Fertig!" : fmtClock(leftOf(t, now)) + (t.paused ? " ⏸" : "")),
    t.name ? h("span", { class: "tmr-n" }, t.name) : null,
    h("button", { class: "tmr-x", "aria-label": t.done ? "Timer ausschalten" : "Timer abbrechen", onclick: () => stopTimer(t.id) }, "×"))));
}

// ---------- cooking mode ----------
async function requestWake() { try { if ("wakeLock" in navigator) { state.wakeLock = await navigator.wakeLock.request("screen"); return true; } } catch (e) {} return false; }
function releaseWake() { try { state.wakeLock && state.wakeLock.release(); } catch (e) {} state.wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.cook) requestWake().then(ok => { if (state.cook) { state.cook.awake = ok; drawCook(); } });
  if (state.online) loadAll();
});
function openCook(r) {
  const f = scaled(r), steps = [], parts = [];
  const add = (rr, ff, title) => { const l = stepList(rr); if (!l.length) return; parts.push({ title, start: steps.length, n: l.length }); l.forEach((st, k) => steps.push(Object.assign({}, st, { r: rr, f: ff, part: parts.length - 1, k }))); };
  basicsOf(r).forEach(({ i, rr }) => add(rr, f * basicFactor(i, rr), i.name || rr.title));
  add(r, f, r.title);
  state.cook = { r, step: 0, awake: false, f, steps, parts };
  requestWake().then(ok => { if (state.cook) { state.cook.awake = ok; drawCook(); } });
  drawCook();
}
function closeCook() { state.cook = null; releaseWake(); const el = document.getElementById("cook"); el && el.remove(); drawTimers(); }
// Timer im Kochmodus: Ring mit Zeit, Play/Pause, darunter +1:00 und Zurücksetzen
function cookTimerCards(c, st) {
  return stepTimers(st.text).map(({ sec, dev, temp }, k) => {
    const key = c.r.id + ":" + c.step + ":" + k, t = state.timers.find(x => x.key === key);
    const R = 64, C = 2 * Math.PI * R, now = Date.now();
    const frac = !t ? 1 : t.done ? 0 : Math.max(0, leftOf(t, now)) / t.sec;
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("viewBox", "0 0 140 140"); ring.setAttribute("class", "tmr-ring"); ring.setAttribute("aria-hidden", "true");
    ring.innerHTML = '<circle cx="70" cy="70" r="' + R + '" class="bg"/><circle cx="70" cy="70" r="' + R + '" class="fg"' + (t && !t.done ? ' data-tring="' + key + '"' : "") + ' stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - frac)) + '"/>';
    const label = !t ? fmtClock(sec) : t.done ? "Fertig!" : fmtClock(leftOf(t, now));
    const act = !t ? () => startTimer(sec, dev || st.sec || ("Schritt " + (c.step + 1)), key) : t.done ? () => stopTimer(t.id) : () => pauseTimer(t.id);
    const aria = !t ? "Timer starten" : t.done ? "Timer ausschalten" : t.paused ? "Weiter" : "Pause";
    const round = h("button", { class: "tmr-round" + (t ? t.done ? " done" : t.paused ? " paused" : " run" : ""), "aria-label": aria, onclick: act }, ring,
      h("span", { class: "tmr-left" + (label.length > 5 ? " long" : ""), "data-tkey": t && !t.done ? key : null }, label),
      t && t.done ? null : h("span", { class: "tmr-pp" }, icon(!t || t.paused ? "play2" : "pause")));
    return h("div", { class: "tmr-card" }, round,
      t ? h("div", { class: "tmr-ctrl" },
        h("button", { class: "tmr-plus", onclick: () => addMinute(t.id) }, "+1:00"),
        h("button", { class: "tmr-reset", "aria-label": "Zurücksetzen", onclick: () => stopTimer(t.id) }, icon("reset"))) : null,
      dev || temp ? h("ul", { class: "tmr-info" },
        dev ? h("li", null, icon(devIcon(dev)), dev) : null,
        temp ? h("li", null, icon("thermo"), temp) : null) : null);
  });
}
function cookSide(c, st) {
  const side = [stepIngLine(st.r || c.r, st.text, st.f || c.f, "cook-step-ings", st.links), ...cookTimerCards(c, st)].filter(Boolean);
  return side.length ? h("div", { class: "cook-side" }, side) : null;
}
function drawCook() {
  const c = state.cook; if (!c) return;
  let el = document.getElementById("cook");
  if (!el) { el = h("div", { class: "cook", id: "cook", role: "dialog", "aria-modal": "true", "aria-label": "Kochmodus" }); document.body.append(el); }
  const steps = c.steps, total = Math.max(1, steps.length), pos = c.step + 1, multi = c.parts.length > 1;
  const st = steps[c.step], pt = st && c.parts[st.part], nextPt = st && st.k === pt.n - 1 && c.parts[st.part + 1];
  const main = !steps.length
    ? [h("p", { class: "cook-text" }, "Für dieses Rezept ist noch keine Zubereitung eingetragen.")]
    : [h("div", { class: "cook-label" }, multi ? pt.title + (st.sec && st.sec !== pt.title ? " · " + st.sec : "") + " · Schritt " + (st.k + 1) + " von " + pt.n : (st.sec ? st.sec + " · " : "") + "Schritt " + (c.step + 1) + " von " + steps.length), h("p", { class: "cook-text" }, linkedText(st.text)), cookSide(c, st),
       nextPt ? h("p", { class: "cook-next" }, "Danach geht es mit " + nextPt.title + " weiter") : null];
  el.replaceChildren(
    h("div", { class: "cook-top" }, h("h2", null, c.r.title), h("button", { class: "btn", onclick: closeCook }, "Beenden")),
    multi ? h("div", { class: "cook-parts", "aria-hidden": "true" }, c.parts.map((p, k) => { const done = Math.min(p.n, Math.max(0, pos - p.start));
      return h("div", { class: k === st.part ? "on" : null, style: "flex:" + Math.max(1, p.n) }, h("i", null, h("b", { style: "width:" + Math.round(done / p.n * 100) + "%" })), h("span", null, p.title)); }))
    : h("div", { class: "cook-progress", "aria-hidden": "true" }, h("div", { style: "width:" + Math.round(pos / total * 100) + "%" })),
    h("div", { class: "cook-main" }, main),
    h("div", { class: "cook-nav" },
      h("button", { class: "btn", disabled: c.step <= 0, onclick: () => { c.step--; drawCook(); } }, "← Zurück"),
      c.step < steps.length - 1
        ? h("button", { class: "btn primary", onclick: () => { c.step++; drawCook(); } }, "Weiter →")
        : h("button", { class: "btn primary", onclick: closeCook }, "Fertig ✓")));
  drawTimers();
}
document.addEventListener("keydown", e => {
  const c = state.cook; if (!c) return;
  if (e.key === "Escape") closeCook();
  else if (e.key === "ArrowRight" && c.step < c.steps.length - 1) { c.step++; drawCook(); }
  else if (e.key === "ArrowLeft" && c.step > 0) { c.step--; drawCook(); }
});
// Rezeptansicht: Wischen. Zur rechten Seite (Finger nach links) -> Zubereitung, zur linken Seite (Finger nach rechts) -> Zutaten bzw. Inhaltsverzeichnis
let swipe = null;
document.addEventListener("touchstart", e => {
  if (state.cook || state.route.view !== "detail" || e.touches.length !== 1 || e.target.closest(".gal, .d-hero, input, textarea, .servings, .dlg-ov, .pv")) { swipe = null; return; }
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
document.addEventListener("touchend", e => {
  if (!swipe || state.cook || state.route.view !== "detail") return;
  const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y; swipe = null;
  if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const two = mqTwo.matches, tab = state.tab || "ing";
  if (dx < 0) { if (!two && tab === "ing") { state.tab = "steps"; render(); } }
  else if (!two && tab === "steps") { state.tab = "ing"; render(); }
  else go("");
}, { passive: true });
let touchX = null;
document.addEventListener("touchstart", e => { if (state.cook) touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener("touchend", e => {
  const c = state.cook; if (!c || touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) < 60) return;
  if (dx < 0 && c.step < c.steps.length - 1) c.step++;
  else if (dx > 0 && c.step > 0) c.step--;
  else return;
  drawCook();
}, { passive: true });

// ---------- PDF ----------
function safeName(s) { return (s || "Rezept").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Rezept"; }
function pdfText(s) { return plainLinks(s).replace(/⅓/g, "1/3").replace(/⅔/g, "2/3").replace(/⅛/g, "1/8").replace(/[“”„]/g, '"').replace(/[–—]/g, "-").replace(/→/g, "-").replace(/[^\x00-\xFF€]/g, ""); }
async function imgData(src, aspect) {
  try {
    const res = await fetch(src); if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    // Ausschnitt im festen Seitenverhältnis (wie ein Foto im Kochbuch)
    let sw = bmp.width, sh = bmp.height, sx = 0, sy = 0;
    if (aspect) { if (sw / sh > aspect) { sw = sh * aspect; sx = (bmp.width - sw) / 2; } else { sh = sw / aspect; sy = (bmp.height - sh) / 2; } }
    const c = document.createElement("canvas"), s = Math.min(1, 1600 / sw);
    c.width = Math.round(sw * s); c.height = Math.round(sh * s);
    c.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.88), w: c.width, h: c.height };
  } catch (e) { return null; }
}
async function buildPdf(recipes, book) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW = 210, PH = 297, M = 20, CW = PW - 2 * M, BOTTOM = PH - 22;
  const INK = [33, 33, 30], GREEN = [47, 107, 74], GREY = [110, 110, 104], RULE = [200, 196, 186];
  const PT = 0.3528; // mm pro Punkt
  let y = M;
  const font = (fam, style, size, color) => { doc.setFont(fam, style); doc.setFontSize(size); doc.setTextColor(...(color || INK)); };
  const wrap = (text, width) => doc.splitTextToSize(pdfText(text), width);
  // schreibt Zeilen ab Oberkante y, gibt neue Oberkante zurück
  const lines = (ls, x, top, size, lh, opts) => { ls.forEach((l, i) => doc.text(l, x, top + size * PT * 0.8 + i * lh, opts || {})); return top + ls.length * lh; };
  const newPage = () => { doc.addPage(); y = M; };
  const ensure = hgt => { if (y + hgt > BOTTOM) newPage(); };
  const ornament = (cy, w) => {
    doc.setDrawColor(...RULE); doc.setLineWidth(0.3);
    doc.line(PW / 2 - w, cy, PW / 2 - 3, cy); doc.line(PW / 2 + 3, cy, PW / 2 + w, cy);
    doc.setFillColor(...GREEN); doc.lines([[1.6, 1.6], [1.6, -1.6], [-1.6, -1.6], [-1.6, 1.6]], PW / 2 - 1.6, cy, [1, 1], "F", true);
  };
  const heading = (text, x, top, width) => {
    font("times", "bold", 14, GREEN); doc.text(pdfText(text), x, top + 14 * PT * 0.8);
    doc.setDrawColor(...RULE); doc.setLineWidth(0.3); doc.line(x, top + 7, x + width, top + 7);
    return top + 10;
  };

  // Buch: Titelseite und Inhaltsverzeichnis
  const starts = [];
  let tocPages = 0;
  if (book) {
    // feine Strichzeichnung: Topf mit drei Dampflinien
    const cx = PW / 2;
    doc.setDrawColor(...GREEN); doc.setLineWidth(0.8); doc.setLineCap("round"); doc.setLineJoin("round");
    doc.line(cx - 24, 116, cx + 24, 116);
    doc.lines([[0, 10], [0, 4, 2.5, 7, 7, 7], [20, 0], [4.5, 0, 7, -3, 7, -7], [0, -10]], cx - 17, 116, [1, 1], "S", false);
    doc.line(cx - 24, 120, cx - 17, 120); doc.line(cx + 17, 120, cx + 24, 120);
    [-9, 0, 9].forEach(dx => doc.lines([[-3, -3, 3, -6, 0, -9], [-3, -3, 3, -6, 0, -9]], cx + dx, 109, [1, 1], "S", false));
    doc.setLineCap("butt");
    font("times", "bold", 46, INK); doc.text("Rezeptbuch", PW / 2, 160, { align: "center" });
    ornament(171, 30);
    font("times", "italic", 13, GREY);
    doc.text(recipes.length + (recipes.length === 1 ? " Rezept" : " Rezepte"), PW / 2, 184, { align: "center" });
    const d = new Date(); doc.text(pdfText(d.toLocaleDateString("de-DE", { month: "long", year: "numeric" })), PW / 2, 191, { align: "center" });
    const cats = new Set(recipes.map(r => r.category || "Ohne Kategorie"));
    const rows = recipes.length + cats.size * 2;
    const perPage = Math.floor((BOTTOM - (M + 30)) / 8.6);
    tocPages = Math.max(1, Math.ceil(rows / perPage));
    for (let i = 0; i < tocPages; i++) doc.addPage();
  }
  for (let n = 0; n < recipes.length; n++) {
    const r = recipes[n];
    if (n > 0 || book) newPage();
    starts[n] = doc.getNumberOfPages();
    y = M + 4;
    // Kopf
    if (r.category) { font("helvetica", "bold", 8, GREEN); doc.text(pdfText(r.category.toUpperCase()), PW / 2, y + 3, { align: "center", charSpace: 0.9 }); y += 7; }
    font("times", "bold", 28, INK);
    y = lines(wrap(r.title, CW - 10), PW / 2, y, 28, 11, { align: "center" }) + 2;
    ornament(y + 1, 22); y += 7;
    const facts = [r.servings ? servLabel(r, r.servings) : "", r.prep_min ? "Vorbereitung " + fmtMin(r.prep_min) : "", r.cook_min ? "Kochen/Backen " + fmtMin(r.cook_min) : ""].filter(Boolean).join("   ·   ");
    if (facts) { font("times", "italic", 11, GREY); y = lines(wrap(facts, CW), PW / 2, y, 11, 5, { align: "center" }) + 4; }
    // Spalten vorbereiten
    const LW = 56, GAP = 9, RX = M + LW + GAP, RW = CW - LW - GAP, QW = 17;
    const ing = (r.ingredients || []);
    font("times", "normal", 11);
    const ingRows = ing.map(i => i.section ? { sec: pdfText(i.section) } : { q: pdfText([fmtQty(i.qty), i.unit].filter(Boolean).join(" ")), name: wrap(i.name, LW - QW - 2), nameRaw: pdfText(i.name) });
    const stepRows = (r.steps || []).map(s => isStepSec(s) ? { sec: pdfText(parseStepHead(s).title) } : wrap(s, RW - 8));
    const nut = ing.some(i => !i.section) ? computeNutrition(r) : null;
    const ingH = 10 + ingRows.reduce((s, x) => s + (x.sec ? 7 : x.name.length * 4.8 + 1.2), 0) + (nut ? 50 : 0);
    const stepH = stepRows.length ? 10 + stepRows.reduce((s, ls) => s + (ls.sec !== undefined ? 7 : ls.length * 5.2 + 3), 0) : 0;
    // Foto: so hoch, dass Zutaten und Zubereitung möglichst noch auf dieselbe Seite passen
    font("times", "italic", 11, GREY);
    const noteLines = r.notes ? wrap(r.notes, CW - 20) : [];
    const noteH = noteLines.length ? noteLines.length * 5 + 5 : 0;
    const src = null; // PDF ohne Fotos (Lias Wunsch, v77)
    if (src) {
      const full = CW * 9 / 16, contentH = Math.max(ingH, stepH);
      let ih = Math.min(full, BOTTOM - y - noteH - contentH - 7);
      if (ih < 60) ih = full;
      const im = await imgData(src, CW / ih);
      if (im) { ensure(ih + 6); doc.addImage(im.data, "JPEG", M, y, CW, ih); y += ih + 7; }
    }
    if (noteLines.length) { font("times", "italic", 11, GREY); ensure(noteH); y = lines(noteLines, PW / 2, y, 11, 5, { align: "center" }) + 5; }

    const ING_STYLE = window.RB_ING_STYLE || "column";
    const drawIngredients = (x, top, width, qw) => {
      const boxed = ING_STYLE === "box";
      let yy = heading("Zutaten", x, top, width);
      if (boxed) { const hgt = ingRows.reduce((s, r2) => s + (r2.sec ? 7 : 5.6), 0) + 6; doc.setFillColor(238, 243, 236); doc.roundedRect(x - 2, yy - 2, width + 4, hgt, 2, 2, "F"); yy += 2; }
      const pad = boxed ? 2 : 0;
      ingRows.forEach(row => {
        if (row.sec) { yy += 2; font("helvetica", "bold", 7.5, GREEN); doc.text(row.sec.toUpperCase(), x + pad, yy + 2.6, { charSpace: 0.6 }); yy += 5; return; }
        if (yy + 5 > BOTTOM) { newPage(); yy = y; }
        const base = yy + 11 * PT * 0.8;
        if (ING_STYLE === "column") {
          font("times", "bold", 11, INK); doc.text(row.q, x + qw - 1, base, { align: "right" });
          font("times", "normal", 11, INK); yy = lines(row.name, x + qw + 1.5, yy, 11, 4.8) + 1.2;
        } else if (ING_STYLE === "leader") {
          font("times", "italic", 11, INK); const qW = row.q ? doc.getTextWidth(row.q) : 0;
          font("times", "normal", 11, INK); const nl = doc.splitTextToSize(row.nameRaw, width - qW - 8);
          nl.forEach((l, i) => doc.text(l, x, base + i * 4.8));
          const lastW = doc.getTextWidth(nl[nl.length - 1]), ly = base + (nl.length - 1) * 4.8;
          if (row.q) {
            font("times", "italic", 11, INK); doc.text(row.q, x + width, ly, { align: "right" });
            const d0 = x + lastW + 2, d1 = x + width - qW - 2;
            doc.setFillColor(...RULE); for (let dx = d0; dx < d1; dx += 1.6) doc.circle(dx, ly - 0.4, 0.18, "F");
          }
          yy += nl.length * 4.8 + 1.4;
        } else {
          // Menge und Zutat in einer Zeile, mit kleinem Punkt davor
          doc.setFillColor(...GREEN); doc.circle(x + pad + 1, base - 1.3, 0.7, "F");
          font("times", "bold", 11, INK); const qW = row.q ? doc.getTextWidth(row.q) + 1.8 : 0;
          if (row.q) doc.text(row.q, x + pad + 4, base);
          font("times", "normal", 11, INK);
          const nl = doc.splitTextToSize(row.nameRaw, width - pad * 2 - 4 - qW);
          doc.text(nl[0], x + pad + 4 + qW, base);
          const rest = nl.slice(1).join(" ");
          const more = rest ? doc.splitTextToSize(rest, width - pad * 2 - 4) : [];
          more.forEach((l, i) => doc.text(l, x + pad + 4, base + (i + 1) * 4.8));
          yy += (1 + more.length) * 4.8 + 0.8;
        }
      });
      return yy + (boxed ? 3 : 0);
    };
    const drawNutrition = (x, top, width) => {
      let yy = top + 6;
      if (yy + 46 > BOTTOM) { newPage(); yy = y; }
      font("times", "bold", 11, GREEN); doc.text(r.servings ? "Nährwerte " + perLabel(r) : "Nährwerte gesamt", x, yy + 3); yy += 5.5;
      const rows = [["Brennwert", fmtNut(nut.per.kcal, "kcal") + " kcal"], ["Fett", fmtNut(nut.per.fat, "fat") + " g"], ["Kohlenhydrate", fmtNut(nut.per.carbs, "carbs") + " g"], ["  davon Zucker", fmtNut(nut.per.sugar, "sugar") + " g"], ["Eiweiß", fmtNut(nut.per.protein, "protein") + " g"], ["Ballaststoffe", fmtNut(nut.per.fiber, "fiber") + " g"], ["Salz", fmtNut(nut.per.salt, "salt") + " g"]];
      doc.setDrawColor(...RULE); doc.setLineWidth(0.25);
      rows.forEach(([a, b], i) => {
        font("times", i === 3 ? "italic" : "normal", 9.5, i === 3 ? GREY : INK);
        doc.text(pdfText(a.trim()), x + (i === 3 ? 3 : 0), yy + 3.2); doc.text(pdfText(b), x + width, yy + 3.2, { align: "right" });
        doc.line(x, yy + 4.6, x + width, yy + 4.6); yy += 5;
      });
      font("times", "italic", 8, GREY); doc.text("Schätzwerte", x, yy + 3.2);
      return yy + 5;
    };
    const drawSteps = (x, top, width) => {
      let yy = heading("Zubereitung", x, top, width);
      let k = 0;
      stepRows.forEach(ls => {
        if (ls.sec !== undefined) { if (!ls.sec) return; yy += 2; font("helvetica", "bold", 7.5, GREEN); doc.text(ls.sec.toUpperCase(), x, yy + 2.6, { charSpace: 0.6 }); yy += 5; return; }
        if (yy + Math.min(ls.length, 2) * 5.2 > BOTTOM) { newPage(); yy = y; }
        font("times", "bold", 12, GREEN); doc.text(String(++k), x, yy + 11 * PT * 0.8);
        font("times", "normal", 11, INK);
        ls.forEach(l => { if (yy + 5.2 > BOTTOM) { newPage(); yy = y; } doc.text(l, x + 8, yy + 11 * PT * 0.8); yy += 5.2; });
        yy += 3;
      });
      return yy;
    };

    const twoCol = stepRows.length && ingRows.length && Math.max(ingH, stepH) <= BOTTOM - y;
    const fitsFresh = stepRows.length && ingRows.length && Math.max(ingH, stepH) <= BOTTOM - M;
    if (!twoCol && fitsFresh && y > M + 120) newPage();
    if ((twoCol || fitsFresh) && stepRows.length && ingRows.length) {
      const top = y, startPage = doc.getNumberOfPages();
      let yl = drawIngredients(M, top, LW, QW);
      const ingPage = doc.getNumberOfPages();
      doc.setPage(startPage); y = top;
      let yr = drawSteps(RX, top, RW);
      const stepPage = doc.getNumberOfPages();
      const lastPage = Math.max(ingPage, stepPage);
      if (ingPage === startPage && stepPage === startPage) {
        doc.setDrawColor(...RULE); doc.setLineWidth(0.25); doc.line(M + LW + GAP / 2, top + 2, M + LW + GAP / 2, Math.max(yl, yr) - 2);
      }
      if (nut) {
        if (ingPage === startPage && stepPage === startPage && yl + 52 <= BOTTOM) { doc.setPage(startPage); yl = drawNutrition(M, yl, LW); }
        else if (stepPage === lastPage && yr + 52 <= BOTTOM) { doc.setPage(lastPage); yr = drawNutrition(RX, yr, 70); }
        else { doc.setPage(lastPage); y = M; newPage(); yl = drawNutrition(M, M - 6, LW); yr = 0; }
      }
      doc.setPage(doc.getNumberOfPages());
      y = Math.max(ingPage === doc.getNumberOfPages() ? yl : 0, stepPage === doc.getNumberOfPages() ? yr : 0, yl, yr);
    } else {
      if (ingRows.length) { ensure(20); y = drawIngredients(M, y, CW, 22) + 4; }
      if (stepRows.length) { ensure(20); y = drawSteps(M, y, CW) + 2; }
      if (nut) y = drawNutrition(M, y, 70);
    }
    if (r.source) { font("times", "italic", 9.5, GREY); ensure(8); y += 4; doc.text(pdfText("Quelle: " + r.source), PW / 2, y + 3, { align: "center", maxWidth: CW }); }
  }
  if (book) {
    // Inhaltsverzeichnis auf den reservierten Seiten
    let pg = 2; doc.setPage(pg); y = M + 6;
    font("times", "bold", 30, INK); doc.text("Inhalt", PW / 2, y + 8, { align: "center" }); y += 14;
    ornament(y, 22); y += 12;
    let last = null;
    const next = need => { if (y + need > BOTTOM && pg < 1 + tocPages) { pg++; doc.setPage(pg); y = M + 6; } };
    recipes.forEach((r, n) => {
      const c = r.category || "Ohne Kategorie";
      if (c !== last) {
        next(18); if (last !== null) y += 4;
        font("helvetica", "bold", 10.5, GREEN); doc.text(pdfText(c.toUpperCase()), M, y + 4, { charSpace: 1 }); y += 10; last = c;
      }
      next(8.6);
      const pn = String(starts[n]);
      font("times", "normal", 14.5, INK);
      const t = doc.splitTextToSize(pdfText(r.title), CW - 30)[0];
      doc.text(t, M, y + 5); doc.text(pn, PW - M, y + 5, { align: "right" });
      const tw = doc.getTextWidth(t), nw = doc.getTextWidth(pn);
      doc.setDrawColor(...RULE); doc.setLineWidth(0.25); doc.setLineDashPattern([0.4, 1.2], 0);
      doc.line(M + tw + 2, y + 4.6, PW - M - nw - 2, y + 4.6); doc.setLineDashPattern([], 0);
      doc.link(M, y - 0.5, CW, 7.5, { pageNumber: starts[n] });
      y += 8.6;
    });
  }
  // Fußzeile
  const pages = doc.getNumberOfPages();
  for (let p = book ? 2 : 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...RULE); doc.setLineWidth(0.25); doc.line(PW / 2 - 10, PH - 14, PW / 2 + 10, PH - 14);
    font("times", "italic", 9, GREY); doc.text(pages > 1 ? String(p) : "Rezeptbuch", PW / 2, PH - 9.5, { align: "center" });
  }
  return doc.output("blob");
}
const isMobile = () => /iPad|iPhone|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function download(blob, filename) {
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function exportPdf(recipes, filename, book) {
  if (!window.jspdf) { toast("PDF-Export lädt noch. Bitte gleich noch einmal tippen."); return; }
  toast("PDF wird erstellt …");
  const blob = await buildPdf(recipes, book);
  const file = new File([blob], filename, { type: "application/pdf" });
  // Auf iPad/iPhone öffnet das Teilen-Menü (Sichern in Dateien, Drucken, AirDrop); sonst normaler Download
  if (navigator.canShare && navigator.canShare({ files: [file] }) && isMobile()) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  download(blob, filename);
  toast("PDF gespeichert");
}
// Jedes Rezept als eigene PDF, zusammen in einer ZIP-Datei (am Tablet/Handy direkt über Teilen)
function sortedForPdf() { return state.recipes.filter(r => catRank(r.category) !== 2).sort((a, b) => catCmp(a.category || "Ohne Kategorie", b.category || "Ohne Kategorie") || (a.title || "").localeCompare(b.title || "", "de")); }
async function shareApp() {
  const url = location.origin + location.pathname;
  if (navigator.share) { try { await navigator.share({ title: "Rezeptbuch", text: "Mein Rezeptbuch", url }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(url); toast("Link kopiert: " + url, 5000); } catch (e) { toast(url, 8000); }
}
async function exportPdfEach(recipes) {
  if (!window.jspdf) { toast("PDF-Export lädt noch. Bitte gleich noch einmal tippen."); return; }
  const files = [], used = new Set();
  for (let i = 0; i < recipes.length; i++) {
    toast("PDF " + (i + 1) + " von " + recipes.length + " …", 60000);
    let name = safeName(recipes[i].title || "Rezept"), n = 2;
    while (used.has(name.toLowerCase())) name = safeName(recipes[i].title || "Rezept") + " " + n++;
    used.add(name.toLowerCase());
    files.push(new File([await buildPdf([recipes[i]])], name + ".pdf", { type: "application/pdf" }));
    await new Promise(r => setTimeout(r, 0));
  }
  if (navigator.canShare && navigator.canShare({ files }) && isMobile()) {
    toast("Fertig: " + files.length + " PDFs", 2500);
    try { await navigator.share({ files, title: "Rezeptbuch" }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  download(await makeZip(files), "Rezeptbuch PDFs.zip");
  toast(files.length + " PDFs gespeichert (ZIP-Datei)");
}
// einfache ZIP-Datei ohne Kompression
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)), dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dt, 2], [12, dd, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, l]) => l === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true));
    const ch = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dt, 2], [14, dd, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]]
      .forEach(([o, v, l]) => l === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true));
    parts.push(lh, name, data); central.push(ch, name); off += 30 + name.length + data.length;
  }
  const size = central.reduce((a, x) => a + x.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, off, 4]].forEach(([o, v, l]) => l === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// ---------- boot ----------
window.addEventListener("online", () => { state.online = true; loadAll(); render(); });
window.addEventListener("offline", () => { state.online = false; render(); });
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
  // Neue Version aktiv: einmal neu laden, damit die neuen Dateien greifen
  let reloaded = false; const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded && !state.cook && state.route.view !== "edit") { reloaded = true; location.reload(); } });
}
state.route = readHash();
initAuth();
})();
