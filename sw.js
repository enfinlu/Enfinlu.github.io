/* Enfin lu : fonctionnement hors ligne, et ouverture immédiate (version 105 ; v117 : voix enregistrée) */
const CACHE = 'enfinlu-v117';   // v117 : la voix enregistrée n'est pas interceptée (voir plus bas)
// v104 : les images des livres ont des noms tirés de leur contenu (belami/3f2a….webp) : une image donnée ne change
// jamais. Elles sont rangées à part, et gardées d'une version de l'appli à l'autre.
const LIVRES = 'enfinlu-livres';
// v105 : le dictionnaire de chaque livre est lui aussi un fichier nommé d'après son contenu (belami/<empreinte>.json)
const MEDIA = /^[0-9a-f]{16}\.(webp|png|jpg|json)$/;
// v104 : ni les grandes icônes (le navigateur les prend lui-même à l'installation), ni les polices « latin-ext »
// (caractères rares, chargées seulement si un texte en a besoin, puis gardées) : 0,7 Mo de moins à la première visite
// la page est demandée une seule fois (« ./ ») puis rangée aussi sous « index.html »
const FICHIERS = ['./', 'manifest.webmanifest', 'catalogue.json', 'belami.json',
  'icone-180.png', 'icone-192.png', 'confidentialite.html',
  'bodoni-moda-latin-opsz-normal.woff2', 'bodoni-moda-latin-opsz-italic.woff2', 'schibsted-grotesk-latin-wght-normal.woff2',
  'spectral-latin-400-normal.woff2', 'spectral-latin-400-italic.woff2', 'spectral-latin-500-normal.woff2',
  'spectral-latin-500-italic.woff2', 'spectral-latin-600-normal.woff2'];
const GARDES = new Set(FICHIERS.map((f) => f.replace('./', '')).concat(['index.html']));
const garde = (nom) => GARDES.has(nom) || /\.(woff2|png)$/.test(nom);
// le programme de l'appli est dans un fichier nommé d'après son contenu (app-<empreinte>.js), que la page désigne :
// un nom donné désigne toujours le même contenu, on n'a jamais besoin de le revérifier
const PROG = /^app-[0-9a-f]+\.js$/;
const progDe = (html) => { const m = /<script src="(app-[0-9a-f]+\.js)"><\/script>/.exec(html); return m ? m[1] : null; };

// une requête « conditionnelle » : le site ne renvoie le fichier que s'il a changé (sinon 304, quelques octets)
function conditionnelle(url, ancien) {
  const h = {};
  const et = ancien && ancien.headers.get('ETag'), lm = ancien && ancien.headers.get('Last-Modified');
  if (et) h['If-None-Match'] = et;
  if (lm) h['If-Modified-Since'] = lm;
  return fetch(new Request(url, { cache: 'no-store', headers: h, credentials: 'same-origin' }));
}
const ancien = (k) => k !== CACHE && k !== LIVRES && (k.startsWith('enfinlu-') || k.startsWith('belle-lurette-'));
async function ancienneCopie(f) {
  const ks = (await caches.keys()).filter(ancien).reverse();
  for (const k of ks) { const hit = await (await caches.open(k)).match(f, { ignoreSearch: true }); if (hit) return hit; }
  return null;
}
async function prendre(c, f) {
  const vieux = await ancienneCopie(f);
  if (vieux && PROG.test(f)) return c.put(f, vieux);
  if (vieux) {
    try { const r = await conditionnelle(f, vieux); if (r.status === 304) return c.put(f, vieux); if (r.ok) return c.put(f, r); } catch (er) {}
  }
  // v104 : le cache du navigateur d'abord (cache: 'default') : à la première visite, la page vient de tout recevoir,
  // inutile de tout retélécharger (avant : cache: 'reload', soit le livre et la page deux fois)
  const r = await fetch(new Request(f, { cache: 'default' }));
  if (!r.ok) throw new Error(f + ' ' + r.status);
  return c.put(f, r);
}

// installation : les fichiers qui n'ont pas changé sont repris de la copie du téléphone
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(FICHIERS.map((f) => prendre(c, f)));
    await c.put('index.html', (await c.match('./')).clone());
    const p = progDe(await (await c.match('index.html')).text());
    if (p) await prendre(c, p);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter(ancien).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// vérification discrète d'une copie, une seule à la fois par fichier
const enCours = new Map();
function revalider(c, cle, hit) {
  if (enCours.has(cle)) return enCours.get(cle);
  const p = (async () => {
    const res = await conditionnelle(cle, hit);
    if (!res || res.status !== 200) return;
    if (cle !== 'index.html') return c.put(cle, res);
    // nouvelle page : son programme est rangé d'abord, pour que la page et le programme changent ensemble
    const html = await res.clone().text(), p = progDe(html), avant = progDe(await hit.text());
    if (p && !(await c.match(p))) {
      const rp = await fetch(new Request(p, { cache: 'reload' }));
      if (!rp.ok) return;
      await c.put(p, rp);
    }
    await Promise.all([c.put('index.html', res.clone()), c.put('./', res)]);
    if (avant && avant !== p) await c.delete(avant);
  })().catch(() => {}).finally(() => enCours.delete(cle));
  enCours.set(cle, p);
  return p;
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  const nom = u.pathname.split('/').pop();
  // v117 : la voix enregistrée (audio/<livre>/e000.mp3) : le navigateur la lit lui-même, par morceaux, depuis le site
  if (/\.(mp3|m4a|ogg|opus)$/.test(nom)) return;
  const page = nom === '' || nom === 'index.html';
  // le programme : toujours la copie du téléphone (son nom change quand il change)
  if (PROG.test(nom)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(nom);
      if (hit) return hit;
      const res = await fetch(r);
      if (res.ok) e.waitUntil(c.put(nom, res.clone()).catch(() => {}));
      return res;
    }));
    return;
  }
  // v104 : les images des livres : la copie du téléphone si elle existe, sinon le réseau (et on la garde)
  if (MEDIA.test(nom)) {
    e.respondWith(caches.open(LIVRES).then(async (c) => {
      const hit = await c.match(r, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(r);
      if (res.ok) e.waitUntil(c.put(r, res.clone()).catch(() => {}));
      return res;
    }));
    return;
  }
  // la page, le manifeste, le catalogue et le livre de l'appli : la copie du téléphone tout de suite (l'appli s'ouvre
  // sans attendre le réseau), puis une vérification discrète auprès du site ; une nouvelle version est rangée et
  // sert à l'ouverture suivante
  if (page || (GARDES.has(nom) && /\.(html|json|webmanifest)$/.test(nom))) {
    const cle = page ? 'index.html' : nom;
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(cle);
      if (hit) {
        e.waitUntil(revalider(c, cle, hit.clone()));
        return hit;
      }
      // pas encore de copie : le réseau, et on range
      const res = await fetch(r);
      if (res.ok) e.waitUntil(Promise.all([c.put(cle, res.clone()), page ? c.put('./', res.clone()) : null]).catch(() => {}));
      return res;
    }).catch(() => caches.match(cle).then((hit) => hit || Response.error())));
    return;
  }
  // autres pages : le réseau, comme sans service worker
  if (r.mode === 'navigate' || /\.(html|json|webmanifest)$/.test(nom)) return;
  // polices et icônes : depuis le téléphone, puis mise à jour discrète
  const g = garde(nom);
  e.respondWith(caches.open(CACHE).then((c) => c.match(r, { ignoreSearch: true }).then((hit) => {
    const net = fetch(r).then((res) => { if (res && res.ok && g) e.waitUntil(c.put(r, res.clone())); return res; }).catch(() => hit);
    return hit || net;
  })));
});
