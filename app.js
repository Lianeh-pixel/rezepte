(() => {
"use strict";
const app = document.getElementById("app");
const CFG = window.RB_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const CACHE_KEY = "rb-cache-v1";
const URL_KEY = "rb-photo-urls-v1";

const state = {
  user: null, authReady: false, authMode: "login", authMsg: "", authErr: "", authBusy: false,
  recipes: [], foods: [], loaded: false, loadError: "", online: navigator.onLine,
  query: "", cat: "", favOnly: false,
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
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function parseQty(s) {
  s = s.trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)([½¼¾⅓⅔⅛])$/); if (m) return +m[1] + FRAC[m[2]];
  if (FRAC[s] != null) return FRAC[s];
  m = s.match(/^(\d+)\/(\d+)$/); if (m) return m[1] / m[2];
  const n = parseFloat(s.replace(",", ".")); return isNaN(n) ? null : n;
}
function parseIngredient(line) {
  line = line.trim(); if (!line) return null;
  if (/^#|:$/.test(line)) return { section: line.replace(/^#\s*/, "").replace(/:$/, "") };
  const m = line.match(/^(\d+\s+\d+\/\d+|\d+[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+\/\d+|\d+(?:[.,]\d+)?)\s*(.*)$/);
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
function ingToLine(i) { return i.section ? i.section + ":" : [fmtQty(i.qty), i.unit, i.name].filter(Boolean).join(" "); }
function scaled(r) { const base = r.servings || 0, now = state.servings[r.id] || base; return base ? now / base : 1; }
function fmtMin(m) { if (!m) return ""; return m >= 60 ? Math.floor(m / 60) + " Std." + (m % 60 ? " " + (m % 60) + " Min." : "") : m + " Min."; }
function norm(s) { return (s || "").toLocaleLowerCase("de").normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function photoSrc(r) { return r.photo_path ? (state.photoUrls[r.photo_path] || {}).url || "" : ""; }
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
  if (!state.user) return;
  const [rec, foods] = await Promise.all([
    sb.from("recipes").select("*").order("updated_at", { ascending: false }),
    sb.from("foods").select("*").order("name")
  ]);
  if (rec.error) {
    state.loadError = state.online ? "Die Rezepte konnten nicht geladen werden (" + errText(rec.error) + ")." : "Du bist offline. Du siehst den zuletzt geladenen Stand.";
    render(); return;
  }
  state.recipes = rec.data; state.loaded = true; state.loadError = "";
  if (!foods.error) state.foods = foods.data;
  lsSet(CACHE_KEY, { user: state.user.id, recipes: state.recipes, foods: state.foods });
  await refreshPhotoUrls();
  rerenderKeepingForm();
}
function rerenderKeepingForm() {
  if (state.route.view === "edit") return;
  if (state.route.view === "list" && document.activeElement && document.activeElement.id === "q") { renderGridOnly(); return; }
  render();
}
async function refreshPhotoUrls() {
  const now = Date.now(), need = state.recipes.map(r => r.photo_path).filter(p => p && !(state.photoUrls[p] && state.photoUrls[p].exp > now + 3600e3));
  if (!need.length) return;
  const { data, error } = await sb.storage.from("photos").createSignedUrls([...new Set(need)], 7 * 24 * 3600);
  if (error || !data) return;
  data.forEach(d => { if (d.signedUrl) state.photoUrls[d.path] = { url: d.signedUrl, exp: now + 7 * 24 * 3600e3 }; });
  lsSet(URL_KEY, state.photoUrls);
}

// ---------- auth ----------
async function initAuth() {
  state.photoUrls = lsGet(URL_KEY, {});
  const { data } = await sb.auth.getSession();
  setUser(data.session ? data.session.user : null);
  sb.auth.onAuthStateChange((_ev, session) => {
    const before = state.user && state.user.id;
    setUser(session ? session.user : null);
    if ((state.user && state.user.id) !== before) { if (state.user) loadAll(); render(); }
  });
  state.authReady = true;
  render();
  if (state.user) loadAll();
}
function setUser(u) {
  state.user = u;
  if (u) {
    const c = lsGet(CACHE_KEY, null);
    if (c && c.user === u.id && !state.loaded) { state.recipes = c.recipes || []; state.foods = c.foods || []; state.loaded = true; }
  } else { state.recipes = []; state.foods = []; state.loaded = false; }
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
    h("button", { type: "button", class: "switch", onclick: () => { state.authMode = signup ? "login" : "signup"; state.authErr = ""; state.authMsg = ""; render(); } },
      signup ? "Ich habe schon ein Konto" : "Noch kein Konto? Einmalig anlegen"),
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
    h("p", null, signup ? "Leg einmalig dein Konto an. Danach meldest du dich auf jedem Gerät mit denselben Daten an." : "Melde dich an, um deine Rezepte zu sehen."),
    form));
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
  app.classList.remove("full");
  if (!state.authReady) { app.append(h("div", { class: "empty" }, h("h2", null, "Wird geladen …"))); return; }
  if (state.route.view === "newpw" && state.user) return renderNewPassword();
  if (!state.user) return renderLogin();
  const r = state.route;
  if (r.view === "detail") return renderDetail(r.id);
  if (r.view === "edit") return renderForm(r.id);
  renderList();
}
const searchIcon = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("width", "18"); s.setAttribute("height", "18"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.2"); s.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4" stroke-linecap="round"/>'; return s; };

function renderList() {
  app.append(h("div", { class: "top" },
    h("div", { class: "brand" }, h("h1", null, "Rezeptbuch"),
      state.loaded ? h("span", { class: "count" }, state.recipes.length + (state.recipes.length === 1 ? " Rezept" : " Rezepte")) : null,
      !state.online ? h("span", { class: "offline" }, "offline") : null),
    h("div", { class: "actions" },
      state.recipes.length ? h("button", { class: "btn", onclick: () => exportPdf(state.recipes, "Rezeptbuch.pdf") }, "Alle als PDF") : null,
      h("button", { class: "btn ghost", onclick: logout }, "Abmelden"),
      h("button", { class: "btn primary", onclick: () => go("neu"), disabled: !state.online }, "+ Neues Rezept"))));
  if (state.loadError) app.append(h("div", { class: "notice" }, state.loadError));
  if (!state.loaded) { app.append(h("div", { class: "empty" }, h("h2", null, "Rezepte werden geladen …"))); return; }
  if (!state.recipes.length) {
    app.append(h("div", { class: "empty" },
      h("h2", null, "Noch keine Rezepte"),
      h("p", null, "Leg dein erstes Rezept an: Zutaten, Schritte und ein Foto. Es erscheint dann auf all deinen Geräten."),
      h("button", { class: "btn primary", onclick: () => go("neu") }, "+ Erstes Rezept anlegen")));
    return;
  }
  const input = h("input", { id: "q", type: "search", placeholder: "Suche nach Rezept, Zutat oder Tag", value: state.query, autocomplete: "off", "aria-label": "Rezepte durchsuchen" });
  input.addEventListener("input", () => { state.query = input.value; renderGridOnly(); });
  app.append(h("div", { class: "search" }, searchIcon(), input));
  const chips = h("div", { class: "chips", role: "toolbar", "aria-label": "Filter" });
  const chip = (label, pressed, onclick, cls) => h("button", { class: "chip" + (cls ? " " + cls : ""), "aria-pressed": pressed ? "true" : "false", onclick }, label);
  chips.append(chip("Alle", !state.cat && !state.favOnly, () => { state.cat = ""; state.favOnly = false; render(); }));
  chips.append(chip("★ Favoriten", state.favOnly, () => { state.favOnly = !state.favOnly; render(); }, "fav"));
  const seen = new Set();
  [...categories(), ...allTags()].forEach(c => { if (seen.has(c)) return; seen.add(c); chips.append(chip(c, state.cat === c, () => { state.cat = state.cat === c ? "" : c; render(); })); });
  app.append(chips, h("div", { id: "gridhost" }));
  renderGridOnly();
  if (state._keepSearchFocus != null) { input.focus(); try { input.setSelectionRange(state._keepSearchFocus, state._keepSearchFocus); } catch (e) {} state._keepSearchFocus = null; }
}
function renderGridOnly() {
  const host = document.getElementById("gridhost"); if (!host) return;
  const list = filtered();
  if (!list.length) { host.replaceChildren(h("div", { class: "empty" }, h("h2", null, "Nichts gefunden"), h("p", null, "Versuch einen anderen Suchbegriff oder setz die Filter zurück."))); return; }
  host.replaceChildren(h("div", { class: "grid" }, list.map(card)));
}
function thumb(r) {
  const src = photoSrc(r);
  return h("div", { class: "thumb" },
    src ? h("img", { src, alt: "", loading: "lazy" }) : h("span", { class: "initial", "aria-hidden": "true" }, (r.title || "?").trim().charAt(0).toUpperCase()),
    r.favorite ? h("span", { class: "star", "aria-label": "Favorit" }, "★") : null);
}
function card(r) {
  const time = (r.prep_min || 0) + (r.cook_min || 0);
  return h("button", { class: "card", onclick: () => go("rezept-" + r.id) },
    thumb(r),
    h("div", { class: "card-body" },
      r.category ? h("span", { class: "tag" }, r.category) : null,
      h("h3", null, r.title || "Ohne Titel"),
      h("div", { class: "meta" }, time ? h("span", null, "⏱ " + fmtMin(time)) : null, r.servings ? h("span", null, r.servings + " Portionen") : null)));
}

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>'
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

  const hero = h("div", { class: "d-hero" + (src ? "" : " noimg") },
    src ? h("img", { src, alt: "" }) : h("span", { class: "initial", "aria-hidden": "true" }, (r.title || "?").trim().charAt(0).toUpperCase()),
    h("div", { class: "d-bar" },
      h("button", { class: "round", "aria-label": "Zurück", onclick: () => go("") }, icon("back")),
      h("div", null,
        h("button", { class: "round", "aria-label": "Als PDF teilen", onclick: () => exportPdf([r], safeName(r.title) + ".pdf") }, icon("share")),
        h("button", { class: "round", "aria-label": "Bearbeiten", onclick: () => go("bearbeiten-" + r.id), disabled: !state.online }, icon("pen")))));

  const meta = h("div", { class: "d-meta" },
    r.servings ? h("span", null, icon("people"), r.servings + " " + (r.servings === 1 ? "Portion" : "Portionen")) : null,
    total ? h("span", { title: [r.prep_min ? "Vorbereitung " + fmtMin(r.prep_min) : "", r.cook_min ? "Kochen/Backen " + fmtMin(r.cook_min) : ""].filter(Boolean).join(", ") }, icon("clock"), fmtMin(total)) : null,
    h("button", { class: "d-fav" + (r.favorite ? " on" : ""), "aria-pressed": r.favorite ? "true" : "false", onclick: () => toggleFav(r) }, icon("heart", r.favorite), r.favorite ? "Favorit" : "Merken"));

  const nut = n ? h("div", { class: "d-nut", role: "list", "aria-label": r.servings ? "Nährwerte pro Portion" : "Nährwerte gesamt" },
    NUT.filter(([k]) => k !== "sugar" && k !== "salt").map(([k, label, unit]) => h("div", { class: k === "kcal" ? "k" : null, role: "listitem" }, h("b", null, fmtNut(n.per[k], k) + unit), label))) : null;

  const seg = h("div", { class: "seg", role: "tablist" },
    h("button", { role: "tab", "aria-selected": tab === "ing" ? "true" : "false", class: tab === "ing" ? "on" : null, onclick: () => { state.tab = "ing"; render(); } }, "Zutaten"),
    h("button", { role: "tab", "aria-selected": tab === "steps" ? "true" : "false", class: tab === "steps" ? "on" : null, onclick: () => { state.tab = "steps"; render(); } }, "Zubereitung"));

  let body;
  if (tab === "ing") {
    const serv = r.servings ? h("span", { class: "servings" },
      h("button", { "aria-label": "Weniger Portionen", onclick: () => { state.servings[r.id] = Math.max(1, now - 1); render(); } }, "−"),
      h("span", null, now + " " + (now === 1 ? "Portion" : "Portionen")),
      h("button", { "aria-label": "Mehr Portionen", onclick: () => { state.servings[r.id] = now + 1; render(); } }, "+")) : null;
    // group by sections
    const groups = []; let cur = { title: "", items: [] };
    (r.ingredients || []).forEach(i => { if (i.section) { if (cur.items.length || cur.title) groups.push(cur); cur = { title: i.section, items: [] }; } else cur.items.push(i); });
    if (cur.items.length || cur.title) groups.push(cur);
    body = h("div", null,
      h("div", { class: "d-row" }, h("span", { class: "sec" }, groups[0] && groups[0].title ? groups[0].title : ""), serv),
      groups.length ? groups.map((g, gi) => [gi > 0 ? h("div", { class: "sec d-sec" }, g.title) : null,
        h("ul", { class: "d-ing" }, g.items.map(i => h("li", null,
          h("span", { class: "qty" }, [fmtQty(i.qty != null ? i.qty * f : null), i.unit].filter(Boolean).join(" ")),
          h("span", null, i.name))))]) : h("p", { class: "meta" }, "Keine Zutaten eingetragen."),
      nutritionBlock(r));
  } else {
    body = (r.steps || []).length ? h("ol", { class: "steps" }, r.steps.map(s => h("li", null, h("p", null, s)))) : h("p", { class: "meta" }, "Keine Schritte eingetragen.");
  }

  app.append(hero, h("div", { class: "d-sheet" },
    h("div", { class: "grab", "aria-hidden": "true" }),
    r.category ? h("div", { class: "sec" }, r.category) : null,
    h("h2", { class: "d-title" }, r.title),
    meta,
    r.notes ? h("p", { class: "notes" }, r.notes) : null,
    nut, seg, body,
    r.source ? h("div", { class: "meta d-src" }, "Quelle: ", /^https?:\/\//.test(r.source) ? h("a", { href: r.source, target: "_blank", rel: "noopener" }, r.source.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)) : r.source) : null,
    (r.steps || []).length ? h("div", { class: "d-dock" }, h("button", { class: "btn primary", onclick: () => openCook(r) }, icon("play"), "Kochmodus starten")) : null));
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
function computeNutrition(r) {
  const idx = foodIndex(), total = {}, rows = [];
  NUT.forEach(([k]) => total[k] = 0);
  (r.ingredients || []).filter(i => !i.section).forEach(i => {
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
  const list = h("ul", { class: "nut-list" }, n.rows.map(x => h("li", { class: x.miss ? "miss" : null },
    h("span", null, ingToLine(x.i) + (x.food && !x.miss ? " → " + x.food.label : "")),
    h("span", null, x.miss ? x.miss : Math.round(x.g) + " g · " + Math.round(x.kcal) + " kcal"))));
  const missNames = n.missing.filter(x => !x.food).map(x => x.i.name);
  return h("section", { class: "nut" },
    h("h3", null, r.servings ? "Nährwerte pro Portion" : "Nährwerte (ganzes Rezept)"),
    h("p", { class: "meta" }, NUT.map(([k, label, unit]) => label + " " + fmtNut(n.per[k], k) + unit).join(" · ")),
    n.missing.length ? h("p", { class: "notice" }, n.missing.length + (n.missing.length === 1 ? " Zutat fehlt" : " Zutaten fehlen") + " in der Berechnung. Die Werte sind deshalb zu niedrig.") : null,
    h("small", null, "Geschätzt aus der eingebauten Nährwerttabelle (Durchschnittswerte pro 100 g)."),
    h("details", null, h("summary", null, "So wurde gerechnet"), list),
    missNames.length && state.online ? foodFormFor(missNames) : null);
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
function clearDraftPhoto() { if (state.draftPhoto && state.draftPhoto.previewUrl) URL.revokeObjectURL(state.draftPhoto.previewUrl); state.draftPhoto = null; }
function renderForm(id) {
  const r = id ? findRecipe(id) : null;
  if (id && !r) { app.append(h("button", { class: "btn ghost back", onclick: () => go("") }, "← Alle Rezepte"), h("div", { class: "empty" }, h("h2", null, state.loaded ? "Rezept nicht gefunden" : "Wird geladen …"))); return; }
  const v = r || {};
  const fld = (label, control, hint) => h("label", { class: "field" }, h("span", null, label), control, hint ? h("small", null, hint) : null);
  const inp = (fid, val, extra) => h("input", Object.assign({ id: fid, value: val == null ? "" : val }, extra || {}));
  const dl = h("datalist", { id: "catlist" }, ["Frühstück","Vorspeise","Hauptgericht","Beilage","Suppe","Salat","Dessert","Kuchen & Gebäck","Brot","Getränk","Snack", ...categories()].filter((x, i, a) => a.indexOf(x) === i).map(c => h("option", { value: c })));
  const photoBox = h("div", { class: "photo-pick" });
  const fileIn = h("input", { type: "file", id: "f-photo", accept: "image/*", hidden: true });
  fileIn.addEventListener("change", () => { const file = fileIn.files && fileIn.files[0]; if (!file) return; prepPhoto(file).then(blob => { clearDraftPhoto(); state.draftPhoto = { blob, previewUrl: URL.createObjectURL(blob) }; drawPhoto(); }).catch(() => toast("Das Bild konnte nicht gelesen werden.")); });
  function drawPhoto() {
    const d = state.draftPhoto;
    const src = d ? (d.remove ? "" : d.previewUrl) : photoSrc(v);
    photoBox.replaceChildren(
      h("div", { class: "thumb" }, src ? h("img", { src, alt: "Vorschau" }) : h("span", { class: "initial", "aria-hidden": "true" }, "📷")),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onclick: () => fileIn.click() }, src ? "Foto ändern" : "Foto hinzufügen"),
        src ? h("button", { type: "button", class: "btn ghost", onclick: () => { clearDraftPhoto(); state.draftPhoto = { remove: true }; drawPhoto(); } }, "Entfernen") : null),
      fileIn);
  }
  drawPhoto();
  const form = h("form", { class: "form", id: "recipe-form", novalidate: true },
    h("button", { type: "button", class: "btn ghost back", onclick: () => r ? go("rezept-" + r.id) : go("") }, "← Abbrechen"),
    h("h2", null, r ? "Rezept bearbeiten" : "Neues Rezept"),
    fld("Titel", inp("f-title", v.title, { required: true, placeholder: "z. B. Omas Apfelkuchen" })),
    fld("Foto", photoBox),
    h("div", { class: "row" },
      fld("Kategorie", inp("f-cat", v.category, { list: "catlist", placeholder: "z. B. Kuchen & Gebäck" })),
      fld("Portionen", inp("f-serv", v.servings, { type: "number", min: "1", inputmode: "numeric" })),
      fld("Vorbereitung (Min.)", inp("f-prep", v.prep_min, { type: "number", min: "0", inputmode: "numeric" })),
      fld("Kochen/Backen (Min.)", inp("f-cook", v.cook_min, { type: "number", min: "0", inputmode: "numeric" }))),
    dl,
    fld("Tags", inp("f-tags", (v.tags || []).join(", "), { placeholder: "vegetarisch, schnell, Weihnachten" }), "Mit Komma trennen."),
    fld("Zutaten", h("textarea", { id: "f-ing", rows: "8", placeholder: "200 g Mehl\n2 Eier\n1/2 TL Salz\nFür den Guss:\n100 g Puderzucker" }, (v.ingredients || []).map(ingToLine).join("\n")),
      "Eine Zutat pro Zeile, Menge zuerst (z. B. 200 g Mehl, 2 EL Öl, 1 Zwiebel). Eine Zeile mit Doppelpunkt am Ende wird zur Zwischenüberschrift."),
    fld("Zubereitung", h("textarea", { id: "f-steps", rows: "10", placeholder: "Ofen auf 180 °C vorheizen.\n\nMehl und Eier verrühren." }, (v.steps || []).join("\n\n")),
      "Jeder Absatz (Leerzeile dazwischen) wird ein Schritt."),
    fld("Notizen", h("textarea", { id: "f-notes", rows: "3", placeholder: "Tipps, Varianten, was beim letzten Mal anders war" }, v.notes || "")),
    fld("Quelle", inp("f-src", v.source, { placeholder: "Webseite, Buch oder Person" })),
    state.formError ? h("p", { class: "err", role: "alert" }, state.formError) : null,
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "btn primary", disabled: state.saving }, state.saving ? "Wird gespeichert …" : "Speichern"),
      h("button", { type: "button", class: "btn", onclick: () => r ? go("rezept-" + r.id) : go("") }, "Abbrechen"),
      r ? h("button", { type: "button", class: "btn danger", style: "margin-left:auto", onclick: () => { state.confirmDelete = true; drawConfirm(); } }, "Löschen") : null),
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
    title, category: val("f-cat").trim(), servings: num(val("f-serv")), prep_min: num(val("f-prep")), cook_min: num(val("f-cook")),
    tags: val("f-tags").split(",").map(t => t.trim()).filter(Boolean),
    ingredients: val("f-ing").split("\n").map(parseIngredient).filter(Boolean),
    steps: val("f-steps").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean),
    notes: val("f-notes").trim(), source: val("f-src").trim()
  };
  if (data.steps.length === 1 && data.steps[0].includes("\n")) data.steps = data.steps[0].split("\n").map(s => s.trim()).filter(Boolean);
  state.saving = true;
  const btn = form.querySelector('button[type="submit"]'); if (btn) { btn.disabled = true; btn.textContent = "Wird gespeichert …"; }
  let oldPhoto = null;
  try {
    const d = state.draftPhoto;
    if (d && d.blob) {
      const path = state.user.id + "/" + uuid() + ".jpg";
      const up = await sb.storage.from("photos").upload(path, d.blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      data.photo_path = path;
      if (existing && existing.photo_path) oldPhoto = existing.photo_path;
    } else if (d && d.remove) {
      data.photo_path = null;
      if (existing && existing.photo_path) oldPhoto = existing.photo_path;
    }
    let id;
    if (existing) {
      const res = await sb.from("recipes").update(data).eq("id", existing.id).select("id").single();
      if (res.error) throw res.error; id = existing.id;
    } else {
      const res = await sb.from("recipes").insert(data).select("id").single();
      if (res.error) throw res.error; id = res.data.id;
    }
    if (oldPhoto) sb.storage.from("photos").remove([oldPhoto]);
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
  const { error } = await sb.from("recipes").update({ favorite: r.favorite }).eq("id", r.id);
  if (error) { r.favorite = !r.favorite; render(); toast("Favorit konnte nicht gespeichert werden."); }
  else lsSet(CACHE_KEY, { user: state.user.id, recipes: state.recipes, foods: state.foods });
}
async function deleteRecipe(r) {
  const { error } = await sb.from("recipes").delete().eq("id", r.id);
  if (error) { toast("Löschen hat nicht geklappt."); return; }
  if (r.photo_path) sb.storage.from("photos").remove([r.photo_path]);
  state.recipes = state.recipes.filter(x => x.id !== r.id);
  lsSet(CACHE_KEY, { user: state.user.id, recipes: state.recipes, foods: state.foods });
  toast("„" + r.title + "“ gelöscht");
  go("");
}
async function logout() { await sb.auth.signOut(); try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(URL_KEY); } catch (e) {} state.photoUrls = {}; go(""); }

// ---------- cooking mode ----------
async function requestWake() { try { if ("wakeLock" in navigator) { state.wakeLock = await navigator.wakeLock.request("screen"); return true; } } catch (e) {} return false; }
function releaseWake() { try { state.wakeLock && state.wakeLock.release(); } catch (e) {} state.wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.cook) requestWake().then(ok => { if (state.cook) { state.cook.awake = ok; drawCook(); } });
  if (state.user && state.online) loadAll();
});
function openCook(r) {
  state.cook = { r, step: -1, awake: false, f: scaled(r) };
  requestWake().then(ok => { if (state.cook) { state.cook.awake = ok; drawCook(); } });
  drawCook();
}
function closeCook() { state.cook = null; releaseWake(); const el = document.getElementById("cook"); el && el.remove(); }
function drawCook() {
  const c = state.cook; if (!c) return;
  let el = document.getElementById("cook");
  if (!el) { el = h("div", { class: "cook", id: "cook", role: "dialog", "aria-modal": "true", "aria-label": "Kochmodus" }); document.body.append(el); }
  const steps = c.r.steps || [], total = steps.length + 1, pos = c.step + 1;
  const main = c.step < 0
    ? [h("div", { class: "cook-label" }, "Zutaten bereitlegen" + (c.r.servings ? " · " + Math.round(c.r.servings * c.f) + " Portionen" : "")),
       h("ul", { class: "cook-ings" }, (c.r.ingredients || []).map(i => i.section ? h("li", null, h("span", { class: "cook-label" }, i.section)) : h("li", null, h("b", null, [fmtQty(i.qty != null ? i.qty * c.f : null), i.unit].filter(Boolean).join(" ")), " ", i.name)))]
    : [h("div", { class: "cook-label" }, "Schritt " + (c.step + 1) + " von " + steps.length), h("p", { class: "cook-text" }, steps[c.step])];
  el.replaceChildren(
    h("div", { class: "cook-top" }, h("h2", null, c.r.title), h("button", { class: "btn", onclick: closeCook }, "Beenden")),
    h("div", { class: "cook-progress", "aria-hidden": "true" }, h("div", { style: "width:" + Math.round(pos / total * 100) + "%" })),
    h("div", { class: "cook-main" }, main),
    h("div", { class: "wake" }, c.awake ? "Der Bildschirm bleibt an, solange der Kochmodus offen ist." : "Tipp: Wischen oder Pfeiltasten blättern weiter."),
    h("div", { class: "cook-nav" },
      h("button", { class: "btn", disabled: c.step < 0, onclick: () => { c.step--; drawCook(); } }, "← Zurück"),
      c.step < steps.length - 1
        ? h("button", { class: "btn primary", onclick: () => { c.step++; drawCook(); } }, c.step < 0 ? "Los geht's →" : "Weiter →")
        : h("button", { class: "btn primary", onclick: closeCook }, "Fertig ✓")));
}
document.addEventListener("keydown", e => {
  const c = state.cook; if (!c) return;
  if (e.key === "Escape") closeCook();
  else if (e.key === "ArrowRight" && c.step < (c.r.steps || []).length - 1) { c.step++; drawCook(); }
  else if (e.key === "ArrowLeft" && c.step >= 0) { c.step--; drawCook(); }
});
let touchX = null;
document.addEventListener("touchstart", e => { if (state.cook) touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener("touchend", e => {
  const c = state.cook; if (!c || touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) < 60) return;
  if (dx < 0 && c.step < (c.r.steps || []).length - 1) c.step++;
  else if (dx > 0 && c.step >= 0) c.step--;
  else return;
  drawCook();
}, { passive: true });

// ---------- PDF ----------
function safeName(s) { return (s || "Rezept").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Rezept"; }
function pdfText(s) { return String(s || "").replace(/⅓/g, "1/3").replace(/⅔/g, "2/3").replace(/⅛/g, "1/8").replace(/[“”„]/g, '"').replace(/[–—]/g, "-").replace(/→/g, "-").replace(/[^\x00-\xFF€]/g, ""); }
async function imgData(src) {
  try {
    const res = await fetch(src); if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement("canvas"), s = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.85), w: c.width, h: c.height };
  } catch (e) { return null; }
}
async function exportPdf(recipes, filename) {
  if (!window.jspdf) { toast("PDF-Export lädt noch. Bitte gleich noch einmal tippen."); return; }
  toast("PDF wird erstellt …");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, M = 18, CW = W - 2 * M, BOTTOM = 280;
  const green = [47, 107, 74], grey = [92, 106, 98];
  let y;
  const need = hg => { if (y + hg > BOTTOM) { doc.addPage(); y = M; } };
  const para = (text, size, o) => {
    o = o || {};
    doc.setFont("helvetica", o.bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...(o.color || [29, 36, 32]));
    const lines = doc.splitTextToSize(pdfText(text), o.width || CW), lh = size * 0.42;
    lines.forEach(l => { need(lh); doc.text(l, o.x || M, y); y += lh; });
  };
  for (let n = 0; n < recipes.length; n++) {
    const r = recipes[n];
    if (n > 0) doc.addPage();
    y = M + 4;
    if (r.category) { para(r.category.toUpperCase(), 9, { bold: true, color: green }); y += 1; }
    para(r.title, 22, { bold: true }); y += 2;
    const facts = [r.servings ? r.servings + " Portionen" : "", r.prep_min ? "Vorbereitung " + fmtMin(r.prep_min) : "", r.cook_min ? "Kochen/Backen " + fmtMin(r.cook_min) : "", (r.tags || []).join(", ")].filter(Boolean).join("   ·   ");
    if (facts) { para(facts, 10, { color: grey }); y += 2; }
    const src = photoSrc(r);
    if (src) {
      const im = await imgData(src);
      if (im) { const ih = Math.min(95, CW * im.h / im.w), iw = ih * im.w / im.h; need(ih + 4); doc.addImage(im.data, "JPEG", M, y, iw, ih); y += ih + 6; }
    }
    if (r.notes) { para(r.notes, 10.5, { color: grey }); y += 3; }
    if ((r.ingredients || []).length) {
      need(12); para("Zutaten", 14, { bold: true, color: green }); y += 1;
      r.ingredients.forEach(i => {
        if (i.section) { y += 1.5; para(i.section, 10.5, { bold: true }); return; }
        need(5);
        doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(29, 36, 32);
        doc.text(pdfText([fmtQty(i.qty), i.unit].filter(Boolean).join(" ")), M + 24, y, { align: "right" });
        para(i.name, 10.5, { x: M + 28, width: CW - 28 }); y += 0.6;
      });
      y += 4;
    }
    if ((r.steps || []).length) {
      need(12); para("Zubereitung", 14, { bold: true, color: green }); y += 1;
      r.steps.forEach((s, k) => {
        need(6);
        doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...green);
        doc.text(String(k + 1) + ".", M, y);
        para(s, 10.5, { x: M + 8, width: CW - 8 }); y += 2;
      });
    }
    if ((r.ingredients || []).some(i => !i.section)) {
      const nn = computeNutrition(r);
      y += 4; need(14); para(r.servings ? "Nährwerte pro Portion (geschätzt)" : "Nährwerte gesamt (geschätzt)", 12, { bold: true, color: green });
      para(NUT.map(([k, label, unit]) => label + " " + fmtNut(nn.per[k], k) + unit).join("   ·   "), 10);
    }
    if (r.source) { y += 3; para("Quelle: " + r.source, 9, { color: grey }); }
  }
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  // Auf iPad/iPhone öffnet das Teilen-Menü (Sichern in Dateien, Drucken, AirDrop); sonst normaler Download
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast("PDF gespeichert");
}

// ---------- boot ----------
window.addEventListener("online", () => { state.online = true; loadAll(); render(); });
window.addEventListener("offline", () => { state.online = false; render(); });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
state.route = readHash();
initAuth();
})();
