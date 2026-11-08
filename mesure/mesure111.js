/* ================= v111 : mesure d'audience anonyme =================
   But : savoir si les lecteurs reviennent (le lendemain, la semaine suivante) et où ils décrochent.
   - Aucun nom, aucun e-mail, aucun cookie : un numéro tiré au hasard sur l'appareil, renouvelé après 13 mois
     (jamais prolongé), et ce que l'appli a déjà enregistré de la lecture (épisodes finis, chapitres, défis).
   - Rien n'est envoyé ailleurs que sur enfinlu.fr (ni dans l'aperçu claude.ai, ni en local), ni si le lecteur a refusé
     (Réglages, la roue dentée de l'accueil). Les signaux du navigateur « ne pas me suivre » (GPC) valent refus par défaut.
   - Le programme de l'appli n'est pas touché : on compare l'état enregistré (localStorage) à la dernière fois.
   Tests : window.__mesure111 (etat, scan, envoyer, reset). */
(() => {
'use strict';
// adresse du récepteur Cloudflare (Worker) ; vide = rien n'est envoyé
const ADRESSE = 'https://enfinlu-mesure.enfinlu.workers.dev';
const SITES = ['enfinlu.fr', 'www.enfinlu.fr'];
const VER = '111';
const CLE = 'enfinlu.mesure';              // état de la mesure (numéro, refus, dernière vue, file d'attente)
const KEY = 'belami.lecture.v2';           // progression de l'appli (lue seulement)
const VIE_ID = 395 * 864e5;                // 13 mois
const FILE_MAX = 300, LOT = 50;
const TEST = window.__mesureTest111 || null; // tests : { adresse } (permet de mesurer hors d'enfinlu.fr)
const adresse = (TEST && TEST.adresse) || ADRESSE;
const surLeSite = SITES.includes(location.hostname) || !!TEST;
if (!surLeSite || !window.localStorage) return;

const lire = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const jour = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const nouvelId = () => {
  const a = new Uint8Array(8);
  (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256 | 0; });
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
};
const gpc = () => navigator.globalPrivacyControl === true;

// ---- d'où l'on vient : appli Google Play, appli installée depuis le site, ou site dans le navigateur ----
function source() {
  let s = null;
  try { s = sessionStorage.getItem('enfinlu.src'); } catch (e) {}
  if (!s) {
    if (/^android-app:\/\/fr\.enfinlu\.app/.test(document.referrer || '')) s = 'play';
    else if (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches) || navigator.standalone) s = 'installee';
    else s = 'site';
    try { sessionStorage.setItem('enfinlu.src', s); } catch (e) {}
  }
  return s;
}
function plateforme() {
  const u = navigator.userAgent || '';
  if (/Android/i.test(u)) return 'android';
  if (/iPhone|iPad|iPod/i.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)) return 'ios';
  return 'ordi';
}

// ---- état de la mesure ----
function etat() {
  let M = lire(CLE);
  if (!M || typeof M !== 'object') M = { refus: gpc() };
  if (M.refus) return { refus: true };
  const t = Date.now();
  if (!M.id || !M.cree || t - M.cree > VIE_ID || t < M.cree - 864e5) {
    // nouveau numéro (première fois, ou 13 mois passés) : on repart de l'état actuel, sans rien envoyer du passé
    M = { id: nouvelId(), cree: t, vu: null, ch: M.ch || {}, f: [] };
  }
  M.f = Array.isArray(M.f) ? M.f : [];
  M.ch = M.ch && typeof M.ch === 'object' ? M.ch : {};
  return M;
}
const garder = (M) => ecrire(CLE, M);

function ajouter(M, e, b, n, c) {
  const t = Date.now();
  M.f.push([t, jour(t), e, b || '', n == null ? -1 : n, c == null ? -1 : c]);
  if (M.f.length > FILE_MAX) M.f.splice(0, M.f.length - FILE_MAX);
}

// ---- découpage des livres en chapitres, noté quand le livre est ouvert dans l'appli ----
// M.ch[livre] = { n: nombre d'épisodes, f: [dernier épisode de chaque chapitre] }
function noterChapitres(M) {
  const L = window.__lecture;
  try {
    const B = L && L.BOOK, C = L && L.CHAPS, E = L && L.EPS;
    if (!B || !B.id || !Array.isArray(C) || !Array.isArray(E) || !E.length) return;
    const S = lire(KEY);
    if (S && S.cur && S.cur !== B.id) return; // l'appli est en train de changer de livre : on attend
    const f = C.map((c) => (Array.isArray(c.eps) && c.eps.length ? c.eps[c.eps.length - 1] : -1));
    if (f.some((x) => !(x >= 0 && x < E.length))) return;
    for (let i = 1; i < f.length; i++) if (f[i] <= f[i - 1]) return;
    M.ch[B.id] = { n: E.length, f };
  } catch (e) {}
}
const chapitreDe = (d, ep) => { if (!d) return -1; for (let i = 0; i < d.f.length; i++) if (ep <= d.f[i]) return i; return -1; };

// ---- ce que l'appli a enregistré, réduit à l'essentiel ----
function resume(S) {
  const r = {};
  const lib = S && S.lib && typeof S.lib === 'object' ? S.lib : {};
  for (const b of Object.keys(lib)) {
    if (!/^[a-z0-9_-]{1,24}$/.test(b)) continue;
    const l = lib[b] || {};
    const eps = l.eps && typeof l.eps === 'object' ? l.eps : {};
    const e = Object.keys(eps).filter((k) => eps[k] && eps[k].done && /^\d+$/.test(k)).map(Number).sort((x, y) => x - y);
    const q = l.quiz && typeof l.quiz === 'object' ? Object.keys(l.quiz).filter((k) => /^\d+$/.test(k)).map(Number) : [];
    r[b] = { e, q, d: (l.k > 0 || e.length > 0) ? 1 : 0 };
  }
  return r;
}

// ---- comparer avec la dernière fois et noter ce qui est nouveau ----
function scan(ouverture) {
  const M = etat();
  if (M.refus) return M;
  noterChapitres(M);
  const S = lire(KEY);
  const R = resume(S);
  if (ouverture) ajouter(M, 'ouverture');
  if (M.vu) {
    for (const b of Object.keys(R)) {
      const a = M.vu[b], r = R[b], d = M.ch[b];
      if (!a) ajouter(M, 'livre', b);
      if (r.d && !(a && a.d)) ajouter(M, 'debut', b);
      const avant = new Set(a ? a.e : []);
      for (const ep of r.e) {
        if (avant.has(ep)) continue;
        const c = chapitreDe(d, ep);
        ajouter(M, 'episode', b, ep, c);
        if (d && c >= 0 && d.f[c] === ep) ajouter(M, 'chapitre', b, ep, c);
        if (d && ep === d.n - 1) ajouter(M, 'fin', b, ep, c);
      }
      const qa = new Set(a ? a.q : []);
      for (const ch of r.q) if (!qa.has(ch)) {
        const qz = S.lib[b].quiz[ch] || {};
        ajouter(M, 'defi', b, typeof qz.n === 'number' ? Math.max(0, Math.min(99, qz.n | 0)) : -1, ch);
      }
    }
  }
  M.vu = R;
  garder(M);
  return M;
}

// ---- envoi : par lots, en arrière-plan ; ce qui n'est pas parti attend le prochain essai ----
let envoiEnCours = false;
function corps(M, evs) {
  return JSON.stringify({ v: 1, id: M.id, src: source(), plat: plateforme(), ver: VER, ev: evs });
}
async function envoyer() {
  if (!adresse || envoiEnCours || navigator.onLine === false) return false;
  const M = etat();
  if (M.refus || !M.f.length) return false;
  envoiEnCours = true;
  const lot = M.f.slice(0, LOT);
  try {
    const r = await fetch(adresse.replace(/\/$/, '') + '/e', {
      method: 'POST', body: corps(M, lot), keepalive: true, credentials: 'omit', mode: 'cors', cache: 'no-store'
    });
    if (r.ok || r.status === 400) {
      // envoyé (ou refusé comme invalide : inutile de le renvoyer) : on retire ce lot de la file
      const M2 = etat();
      if (!M2.refus && M2.id === M.id) {
        const fait = new Set(lot.map((x) => x[0] + x[2] + x[3] + x[4]));
        M2.f = M2.f.filter((x) => !fait.has(x[0] + x[2] + x[3] + x[4]));
        garder(M2);
        if (M2.f.length) setTimeout(envoyer, 1500);
      }
      return true;
    }
  } catch (e) {} finally { envoiEnCours = false; }
  return false;
}
// quand l'appli passe en arrière-plan : un dernier envoi qui survit à la fermeture
function envoyerEnPartant() {
  if (!adresse || !navigator.sendBeacon) return;
  const M = scan(false);
  if (M.refus || !M.f.length) return;
  const lot = M.f.slice(0, LOT);
  try {
    if (navigator.sendBeacon(adresse.replace(/\/$/, '') + '/e', new Blob([corps(M, lot)], { type: 'text/plain' }))) {
      M.f = M.f.slice(lot.length);
      garder(M);
    }
  } catch (e) {}
}

// ---- réglage : « Partager des statistiques de lecture anonymes » (feuille de la roue dentée de l'accueil) ----
function refuser(oui) {
  if (oui) { ecrire(CLE, { refus: true }); return; }
  const M = lire(CLE) || {};
  ecrire(CLE, { ch: M.ch || {} }); // nouveau numéro au prochain passage, sans rien du passé
  scan(false);
}
function ligneReglage() {
  const p = document.querySelector('#apSheet .panel');
  if (!p || p.querySelector('#mesureRow')) return;
  const row = document.createElement('div');
  row.className = 'row mesure111';
  row.id = 'mesureRow';
  row.innerHTML = '<span class="lab">Statistiques</span>'
    + '<label class="check"><input type="checkbox" id="optMesure"> Partager des statistiques de lecture anonymes</label>'
    + '<p class="tile-small">Aucun nom ni e-mail : seulement les épisodes lus et les retours, pour savoir ce qui plaît. '
    + '<a href="confidentialite.html#mesure" target="_blank" rel="noopener">En savoir plus</a></p>';
  const note = p.querySelector('.tile-small');
  if (note && note.parentElement === p) p.insertBefore(row, note.nextSibling); else p.append(row);
  const box = row.querySelector('#optMesure');
  box.checked = !etat().refus;
  box.addEventListener('change', () => { refuser(!box.checked); });
}
const st = document.createElement('style');
st.textContent = '.mesure111{margin-top:18px;padding-top:14px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}'
  + '.mesure111 .check{display:flex;gap:10px;align-items:flex-start;justify-content:flex-start;text-align:left;width:100%;margin:6px 0 4px}'
  + '.mesure111 .check input{margin-top:3px;flex:none;width:18px;height:18px;accent-color:var(--accent,#2f5d9e)}'
  + '.mesure111 .tile-small{margin:4px 0 0}.mesure111 a{color:inherit;text-decoration:underline;text-underline-offset:2px}';
document.head.append(st);

// ---- démarrage et rythme ----
let cache = 0;
function demarrer() {
  scan(true);
  ligneReglage();
  setTimeout(envoyer, 4000);
  setInterval(() => { if (document.visibilityState === 'visible') { scan(false); if (++cache % 3 === 0) envoyer(); } }, 10000);
  let cacheDepuis = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { cacheDepuis = Date.now(); envoyerEnPartant(); }
    else {
      // retour après plus de 30 min : une nouvelle « ouverture »
      scan(cacheDepuis && Date.now() - cacheDepuis > 30 * 6e4);
      setTimeout(envoyer, 2000);
    }
  });
  window.addEventListener('pagehide', envoyerEnPartant);
  window.addEventListener('online', () => setTimeout(envoyer, 1000));
  document.addEventListener('click', () => requestAnimationFrame(ligneReglage), true);
}
// après l'ouverture de l'appli (le livre et l'état sont alors en place)
if (document.readyState === 'complete') setTimeout(demarrer, 1500);
else window.addEventListener('load', () => setTimeout(demarrer, 1500), { once: true });

window.__mesure111 = { etat: () => lire(CLE), scan, envoyer, refuser, reset: () => localStorage.removeItem(CLE), ADRESSE: adresse };
})();
