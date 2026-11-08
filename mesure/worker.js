/* Enfin lu · récepteur de statistiques anonymes (Cloudflare Worker + base D1)
   - POST /e      : reçoit les événements envoyés par l'appli (enfinlu.fr), sans adresse IP ni cookie
   - GET  /       : tableau de bord (demande la clé)
   - GET  /stats  : chiffres du tableau de bord (clé obligatoire, en-tête Authorization)
   Réglages dans Cloudflare : base D1 liée sous le nom DB ; secret CLE (la clé du tableau de bord).
   Les données de plus de 25 mois sont effacées (CNIL). */

const ORIGINES = ['https://enfinlu.fr', 'https://www.enfinlu.fr'];
const EVENEMENTS = new Set(['ouverture', 'livre', 'debut', 'episode', 'chapitre', 'fin', 'defi']);
const SOURCES = new Set(['site', 'installee', 'play']);
const PLATS = new Set(['android', 'ios', 'ordi']);
const GARDE_MS = 760 * 864e5; // 25 mois

let pret = false;
async function preparer(env) {
  if (pret) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ev (ts INTEGER NOT NULL, jour TEXT NOT NULL, uid TEXT NOT NULL, e TEXT NOT NULL, b TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT -1, c INTEGER NOT NULL DEFAULT -1, src TEXT NOT NULL DEFAULT '', plat TEXT NOT NULL DEFAULT '', ver TEXT NOT NULL DEFAULT '')"),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ev_jour ON ev(jour)'),
  ]);
  pret = true;
}
const purger = (env) => env.DB.prepare('DELETE FROM ev WHERE ts < ?1').bind(Date.now() - GARDE_MS).run();

function aujourdhui(decalage = 0) {
  const d = new Date(Date.now() + decalage * 864e5);
  try { return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch (e) { return d.toISOString().slice(0, 10); }
}
function origineOk(req, env) {
  const o = req.headers.get('Origin');
  const autres = String(env.ORIGINES_TEST || '').split(',').map((s) => s.trim()).filter(Boolean);
  return o && (ORIGINES.includes(o) || autres.includes(o)) ? o : null;
}
const entier = (x) => (Number.isInteger(x) && x >= -1 && x <= 9999 ? x : -1);

async function recevoir(req, env) {
  const o = origineOk(req, env);
  if (!o) return new Response('origine refusée', { status: 403 });
  const cors = { 'Access-Control-Allow-Origin': o, Vary: 'Origin' };
  const txt = await req.text();
  if (txt.length > 16384) return new Response('trop long', { status: 413, headers: cors });
  let d;
  try { d = JSON.parse(txt); } catch (e) { return new Response('illisible', { status: 400, headers: cors }); }
  if (!d || d.v !== 1 || !/^[0-9a-f]{16}$/.test(d.id || '') || !Array.isArray(d.ev) || !d.ev.length || d.ev.length > 50)
    return new Response('invalide', { status: 400, headers: cors });
  const src = SOURCES.has(d.src) ? d.src : 'autre';
  const plat = PLATS.has(d.plat) ? d.plat : 'autre';
  const ver = /^[0-9a-z.]{1,8}$/.test(d.ver || '') ? d.ver : '';
  const min = aujourdhui(-31), max = aujourdhui(1);
  const ts = Date.now();
  const lignes = [];
  for (const x of d.ev) {
    if (!Array.isArray(x) || x.length !== 6) continue;
    const [, jour, e, b, n, c] = x;
    if (!EVENEMENTS.has(e) || typeof jour !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(jour) || jour < min || jour > max) continue;
    if (typeof b !== 'string' || !/^[a-z0-9_-]{0,24}$/.test(b)) continue;
    lignes.push([ts, jour, d.id, e, b, entier(n), entier(c), src, plat, ver]);
  }
  if (lignes.length) {
    await preparer(env);
    const st = env.DB.prepare('INSERT INTO ev (ts, jour, uid, e, b, n, c, src, plat, ver) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)');
    await env.DB.batch(lignes.map((l) => st.bind(...l)));
  }
  return new Response(null, { status: 204, headers: cors });
}

function cleOk(req, env) {
  const a = req.headers.get('Authorization') || '';
  const k = a.startsWith('Bearer ') ? a.slice(7) : '';
  const s = encodeURIComponent(String(env.CLE || '').trim()); // la page envoie la clé encodée (accents permis)
  if (!s || k.length !== s.length) return false;
  let r = 0;
  for (let i = 0; i < s.length; i++) r |= s.charCodeAt(i) ^ k.charCodeAt(i);
  return r === 0;
}

async function stats(req, env) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (!env.CLE) return new Response(JSON.stringify({ erreur: 'Le secret CLE n’est pas réglé dans Cloudflare.' }), { status: 503, headers: h });
  if (!cleOk(req, env)) return new Response(JSON.stringify({ erreur: 'Clé incorrecte.' }), { status: 401, headers: h });
  await preparer(env);
  await purger(env);
  const p = Math.min(366, Math.max(1, parseInt(new URL(req.url).searchParams.get('jours') || '30', 10) || 30));
  const auj = aujourdhui(0), depuis = aujourdhui(-(p - 1));
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const premiers = 'WITH f AS (SELECT uid, MIN(jour) AS d FROM ev GROUP BY uid)';
  const r = await env.DB.batch([
    q("SELECT jour, COUNT(DISTINCT uid) AS lecteurs, SUM(e = 'episode') AS episodes, SUM(e = 'chapitre') AS chapitres FROM ev WHERE jour >= ?1 GROUP BY jour ORDER BY jour", depuis),
    q(premiers + ' SELECT d AS jour, COUNT(*) AS n FROM f WHERE d >= ?1 GROUP BY d', depuis),
    q(premiers + ", a AS (SELECT DISTINCT uid, jour FROM ev) SELECT f.d AS jour, COUNT(DISTINCT f.uid) AS nouveaux,"
      + " COUNT(DISTINCT CASE WHEN julianday(a.jour) - julianday(f.d) = 1 THEN f.uid END) AS j1,"
      + " COUNT(DISTINCT CASE WHEN julianday(a.jour) - julianday(f.d) BETWEEN 1 AND 7 THEN f.uid END) AS s1,"
      + " COUNT(DISTINCT CASE WHEN julianday(a.jour) - julianday(f.d) = 7 THEN f.uid END) AS j7"
      + ' FROM f JOIN a ON a.uid = f.uid WHERE f.d >= ?1 GROUP BY f.d ORDER BY f.d', depuis),
    q(premiers + ", s AS (SELECT uid, MAX(e = 'debut') AS deb, SUM(e = 'episode') AS ep, SUM(e = 'chapitre') AS ch, SUM(e = 'defi') AS df, SUM(e = 'fin') AS fi"
      + ' FROM ev WHERE uid IN (SELECT uid FROM f WHERE d >= ?1) GROUP BY uid)'
      + ' SELECT COUNT(*) AS nouveaux, SUM(deb > 0 OR ep > 0) AS debut, SUM(ep >= 1) AS ep1, SUM(ep >= 3) AS ep3, SUM(ep >= 10) AS ep10,'
      + ' SUM(ch >= 1) AS ch1, SUM(df >= 1) AS defi, SUM(fi >= 1) AS fin FROM s', depuis),
    q("SELECT b, n, COUNT(DISTINCT uid) AS k FROM ev WHERE e = 'episode' AND n >= 0 AND b <> '' GROUP BY b, n ORDER BY b, n"),
    q("SELECT b, COUNT(DISTINCT CASE WHEN e = 'debut' OR e = 'episode' THEN uid END) AS lecteurs, COUNT(DISTINCT CASE WHEN e = 'fin' THEN uid END) AS fin FROM ev WHERE b <> '' GROUP BY b"),
    q('SELECT src, plat, COUNT(DISTINCT uid) AS k FROM ev WHERE jour >= ?1 GROUP BY src, plat', depuis),
    q("SELECT COUNT(DISTINCT uid) AS lecteurs, SUM(e = 'episode') AS episodes, SUM(e = 'chapitre') AS chapitres, SUM(e = 'defi') AS defis, AVG(CASE WHEN e = 'defi' AND n >= 0 THEN n END) AS defiMoy FROM ev WHERE jour >= ?1", depuis),
    q('SELECT COUNT(DISTINCT uid) AS lecteurs FROM ev WHERE jour = ?1', auj),
    q('SELECT COUNT(DISTINCT uid) AS lecteurs, COUNT(*) AS lignes, MIN(jour) AS premier FROM ev'),
  ]);
  const R = (i) => r[i].results || [];
  return new Response(JSON.stringify({
    jours: p, depuis, aujourdhui: auj,
    parJour: R(0), nouveauxParJour: R(1), retour: R(2), parcours: R(3)[0] || {},
    episodes: R(4), livres: R(5), sources: R(6), periode: R(7)[0] || {}, auj: R(8)[0] || {}, total: R(9)[0] || {},
  }), { headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    try {
      if (u.pathname === '/e') {
        if (req.method === 'OPTIONS') {
          const o = origineOk(req, env);
          return new Response(null, { status: o ? 204 : 403, headers: o ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : {} });
        }
        if (req.method === 'POST') return await recevoir(req, env);
        return new Response('POST seulement', { status: 405 });
      }
      if (u.pathname === '/stats' && req.method === 'GET') return await stats(req, env);
      if ((u.pathname === '/' || u.pathname === '/index.html') && req.method === 'GET')
        return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
      return new Response('Introuvable', { status: 404 });
    } catch (e) {
      return new Response('Erreur : ' + (e && e.message ? e.message : e), { status: 500 });
    }
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(preparer(env).then(() => purger(env))); },
};

/* ================= tableau de bord ================= */
const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Enfin lu · statistiques</title>
<style>
:root{color-scheme:dark;--fond:#0f131b;--carte:#171c26;--trait:#2a3140;--txt:#eef1f6;--txt2:#b4bccb;--txt3:#8891a2;
--s1:#3987e5;--s2:#d95926;--lien:#86b6ef}
*{box-sizing:border-box}body{margin:0;background:var(--fond);color:var(--txt);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:760px;margin:0 auto;padding:18px 16px 40px}
h1{font:600 22px/1.2 Georgia,serif;margin:4px 0 2px}h1 i{color:var(--lien);font-style:italic}
h2{font-size:16px;margin:0 0 2px}.sous{color:var(--txt3);font-size:13px;margin:0 0 12px}
.barre{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0 16px}
.seg{display:inline-flex;background:var(--carte);border:1px solid var(--trait);border-radius:10px;padding:3px}
.seg button,.btn{font:inherit;font-size:14px;color:var(--txt2);background:none;border:0;border-radius:8px;padding:7px 12px;cursor:pointer}
.seg button[aria-pressed=true]{background:#263045;color:var(--txt)}
.btn{border:1px solid var(--trait);background:var(--carte)}.btn:hover,.seg button:hover{color:var(--txt)}
.tuiles{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
@media(min-width:620px){.tuiles{grid-template-columns:repeat(3,1fr)}}
.tuile{background:var(--carte);border:1px solid var(--trait);border-radius:14px;padding:12px 14px}
.tuile b{display:block;font-size:26px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.tuile span{color:var(--txt2);font-size:13px}.tuile small{display:block;color:var(--txt3);font-size:12px;margin-top:2px}
.carte{background:var(--carte);border:1px solid var(--trait);border-radius:14px;padding:14px;margin-bottom:14px}
.legende{display:flex;gap:14px;font-size:13px;color:var(--txt2);margin:0 0 8px}.legende i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
svg{display:block;width:100%;height:auto;overflow:visible}svg text{fill:var(--txt3);font-size:11px;font-family:inherit}
.grille{stroke:var(--trait);stroke-width:1}.cible{fill:transparent;cursor:default}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:7px 6px;border-bottom:1px solid var(--trait)}th:first-child,td:first-child{text-align:left}
th{color:var(--txt3);font-weight:500;font-size:12px}td.att{color:var(--txt3)}
details{margin-top:10px}summary{cursor:pointer;color:var(--lien);font-size:14px;padding:6px 0}
.etape{display:grid;grid-template-columns:minmax(120px,38%) 1fr;gap:10px;align-items:center;margin:7px 0;font-size:14px}
.etape .rail{height:22px;border-radius:4px;background:#1d2330;position:relative;overflow:hidden}
.etape .rail div{position:absolute;inset:0 auto 0 0;border-radius:0 4px 4px 0}
.etape .rail em{position:absolute;left:8px;top:2px;font-style:normal;font-size:13px;color:#fff;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px #0008}
#bulle{position:fixed;pointer-events:none;background:#0b0e14;border:1px solid var(--trait);border-radius:10px;padding:8px 10px;font-size:13px;color:var(--txt);box-shadow:0 6px 24px #0008;display:none;z-index:9;max-width:240px}
#bulle b{display:block;margin-bottom:2px}
.vide{color:var(--txt3);font-size:14px;padding:10px 0}
form{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}input{font:inherit;flex:1;min-width:200px;background:var(--carte);color:var(--txt);border:1px solid var(--trait);border-radius:10px;padding:10px 12px}
.erreur{color:#ff9b8f;margin-top:10px}.pied{color:var(--txt3);font-size:12px;margin-top:22px}
a{color:var(--lien)}
</style></head><body><main>
<h1>Enfin <i>lu</i> · statistiques</h1>
<p class="sous">Lecteurs anonymes (un numéro tiré au hasard par appareil). Les données de plus de 25 mois sont effacées.</p>
<div id="porte"><form id="f"><input id="cle" type="password" autocomplete="current-password" placeholder="Clé du tableau de bord" required><button class="btn" type="submit">Ouvrir</button></form><p class="erreur" id="err"></p></div>
<div id="tdb" hidden>
  <div class="barre"><div class="seg" role="group" aria-label="Période"><button data-j="7" aria-pressed="false">7 jours</button><button data-j="30" aria-pressed="true">30 jours</button><button data-j="90" aria-pressed="false">90 jours</button></div>
  <button class="btn" id="maj">Actualiser</button><button class="btn" id="sortir">Changer de clé</button></div>
  <div class="tuiles" id="tuiles"></div>
  <section class="carte"><h2>Lecteurs par jour</h2><p class="sous">Appareils qui ont ouvert l’appli ce jour-là.</p>
    <div class="legende"><span><i style="background:var(--s2)"></i>Nouveaux</span><span><i style="background:var(--s1)"></i>Déjà venus</span></div><div id="g1"></div></section>
  <section class="carte"><h2>Est-ce qu’ils reviennent ?</h2><p class="sous">Pour les nouveaux lecteurs de chaque jour : revenus le lendemain, dans les 7 jours, et le 7<sup>e</sup> jour.</p><div id="t1"></div></section>
  <section class="carte"><h2>Parcours des nouveaux lecteurs</h2><p class="sous">Sur la période choisie, jusqu’où vont ceux qui découvrent l’appli.</p><div id="g2"></div></section>
  <section class="carte"><h2>Où ils décrochent</h2><p class="sous">Pour chaque livre, nombre de lecteurs qui ont fini chaque épisode (depuis le début de la mesure).</p><div id="g3"></div></section>
  <section class="carte"><h2>D’où ils lisent</h2><p class="sous">Sur la période choisie.</p><div id="t2"></div></section>
  <p class="pied" id="pied"></p>
</div>
<div id="bulle" role="status"></div>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var fmt=new Intl.NumberFormat('fr-FR');var n=function(x){return fmt.format(Math.round(x||0))};
var pc=function(a,b){return b?Math.round(100*a/b)+' %':'—'};
var pl=function(x,mot,mots){return n(x)+' '+((x||0)>=2?(mots||mot+'s'):mot)};var dernier=null;
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
var NOMS={belami:'Bel-Ami',potbouille:'Pot-Bouille',boutons:'La Guerre des boutons'};
var SRC={play:'Appli Google Play',installee:'Appli installée depuis le site',site:'Site dans le navigateur',autre:'Autre'};
var PLAT={android:'Android',ios:'iPhone / iPad',ordi:'Ordinateur',autre:'Autre'};
var jours=30,cle='';try{cle=localStorage.getItem('cle')||''}catch(e){}
function dateCourte(j){var p=j.split('-');return (+p[2])+'/'+(+p[1])}
function ajoute(j,d){var t=new Date(j+'T12:00:00Z');t.setUTCDate(t.getUTCDate()+d);return t.toISOString().slice(0,10)}
var bulle=$('bulle');
function montrer(ev,html){bulle.innerHTML=html;bulle.style.display='block';var x=ev.clientX,y=ev.clientY,w=bulle.offsetWidth,h=bulle.offsetHeight;
 x=Math.min(window.innerWidth-w-8,Math.max(8,x-w/2));y=y-h-14;if(y<8)y=ev.clientY+18;bulle.style.left=x+'px';bulle.style.top=y+'px'}
function cacher(){bulle.style.display='none'}
document.addEventListener('scroll',cacher,true);
function survol(el,html){el.addEventListener('pointermove',function(e){montrer(e,html)});el.addEventListener('pointerdown',function(e){montrer(e,html)});el.addEventListener('pointerleave',cacher)}
function svg(w,h,inner){return '<svg viewBox="0 0 '+w+' '+h+'" role="img">'+inner+'</svg>'}
function echelle(max){if(max<=4){var a=[];for(var i=0;i<=max;i++)a.push(i);return a}var p=Math.pow(10,Math.floor(Math.log10(max))),s=[1,2,5,10].map(function(k){return k*p}).find(function(k){return max/k<=4});var r=[];for(var v=0;v<=max+s*0.999;v+=s)r.push(v);return r}
function barres(id,cols,series,etiq,titre){
 // cols : [{x, v:[..]}] empilées ; series : [{nom, coul}] ; une colonne = une barre
 var el=$(id);if(!cols.length){el.innerHTML='<p class="vide">Pas encore de données.</p>';return}
 var W=Math.max(280,el.clientWidth||340),H=190,g=30,b=22,top=8,ih=H-top-b,iw=W-g;var tot=cols.map(function(c){return c.v.reduce(function(a,x){return a+x},0)});
 var max=Math.max(1,Math.max.apply(null,tot));var ticks=echelle(max);var M=ticks[ticks.length-1]||1;
 var step=iw/cols.length,bw=Math.max(2,Math.min(26,step-2));var s='';
 ticks.forEach(function(t){var y=top+ih-ih*t/M;s+='<line class="grille" x1="'+g+'" x2="'+W+'" y1="'+y+'" y2="'+y+'"/><text x="'+(g-6)+'" y="'+(y+4)+'" text-anchor="end">'+n(t)+'</text>'});
 var every=Math.ceil(cols.length/Math.max(3,Math.floor(iw/46)));
 cols.forEach(function(c,i){var x=g+i*step+(step-bw)/2,y0=top+ih;c.v.forEach(function(v,k){if(!v)return;var h=Math.max(1,ih*v/M);var last=c.v.slice(k+1).every(function(z){return !z});
  var r=last?Math.min(4,bw/2):0;y0-=h;s+='<path d="'+rect(x,y0,bw,h,r)+'" fill="'+series[k].coul+'"/>';y0-=last?0:2});
  if(i%every===0)s+='<text x="'+(x+bw/2)+'" y="'+(H-6)+'" text-anchor="middle">'+esc(etiq(c.x))+'</text>';
  s+='<rect class="cible" data-i="'+i+'" x="'+(g+i*step)+'" y="'+top+'" width="'+step+'" height="'+ih+'"/>'});
 el.innerHTML=svg(W,H,s);
 el.querySelectorAll('.cible').forEach(function(r){var c=cols[+r.dataset.i];survol(r,'<b>'+esc(titre(c.x))+'</b>'+series.map(function(se,k){return esc(se.nom)+' : '+n(c.v[k])}).join('<br>'))});
}
function rect(x,y,w,h,r){r=Math.min(r,h);return 'M'+x+','+(y+h)+'V'+(y+r)+'Q'+x+','+y+' '+(x+r)+','+y+'H'+(x+w-r)+'Q'+(x+w)+','+y+' '+(x+w)+','+(y+r)+'V'+(y+h)+'Z'}
function rendre(d){
 dernier=d;var P=d.periode||{},T=d.total||{},par={};(d.parJour||[]).forEach(function(r){par[r.jour]=r});
 var nv={};(d.nouveauxParJour||[]).forEach(function(r){nv[r.jour]=r.n});
 // retour : seulement les jours déjà mesurables
 var a1=0,b1=0,a7=0,as=0,b7=0;(d.retour||[]).forEach(function(r){if(ajoute(r.jour,1)<d.aujourdhui){a1+=r.j1;b1+=r.nouveaux}if(ajoute(r.jour,7)<d.aujourdhui){a7+=r.j7;as+=r.s1;b7+=r.nouveaux}});
 var tu=[['Lecteurs',n(P.lecteurs),'sur '+d.jours+' jours'],['Aujourd’hui',n((d.auj||{}).lecteurs),((d.auj||{}).lecteurs>=2?'lecteurs':'lecteur')],
  ['Revenus le lendemain',pc(a1,b1),b1?n(a1)+' sur '+pl(b1,'nouveau','nouveaux'):'pas encore mesurable'],
  ['Revenus dans la semaine',pc(as,b7),b7?n(as)+' sur '+pl(b7,'nouveau','nouveaux'):'il faut 8 jours de recul'],
  ['Épisodes lus',n(P.episodes),'sur '+d.jours+' jours'],['Chapitres finis',n(P.chapitres),P.defis?pl(P.defis,'défi fait','défis faits'):'sur '+d.jours+' jours']];
 $('tuiles').innerHTML=tu.map(function(t){return '<div class="tuile"><span>'+t[0]+'</span><b>'+t[1]+'</b><small>'+t[2]+'</small></div>'}).join('');
 var cols=[];for(var j=d.depuis;j<=d.aujourdhui;j=ajoute(j,1)){var l=(par[j]||{}).lecteurs||0,k=Math.min(l,nv[j]||0);cols.push({x:j,v:[k,l-k]})}
 if(!(d.parJour||[]).length)cols=[];
 barres('g1',cols,[{nom:'Nouveaux',coul:'var(--s2)'},{nom:'Déjà venus',coul:'var(--s1)'}],dateCourte,function(j){return new Date(j+'T12:00:00Z').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})});
 var rt=(d.retour||[]).slice().reverse();
 var tete='<tr><th>Arrivés le</th><th>Nouveaux</th><th>Lendemain</th><th>Sous 7 jours</th><th>7<sup>e</sup> jour</th></tr>';
 var lignes=rt.map(function(r){
   var m1=ajoute(r.jour,1)<d.aujourdhui,m7=ajoute(r.jour,7)<d.aujourdhui;
   var c=function(ok,v,dj){return ok?'<td>'+pc(v,r.nouveaux)+'</td>':'<td class="att">'+(dj?'en cours':'à venir')+'</td>'};
   return '<tr><td>'+dateCourte(r.jour)+'</td><td>'+n(r.nouveaux)+'</td>'+c(m1,r.j1,0)+c(m7,r.s1,ajoute(r.jour,1)<d.aujourdhui)+c(m7,r.j7,0)+'</tr>'});
 $('t1').innerHTML=!rt.length?'<p class="vide">Pas encore de nouveaux lecteurs.</p>':'<table>'+tete+lignes.slice(0,14).join('')+'</table>'
  +(lignes.length>14?'<details><summary>Voir les '+(lignes.length-14)+' jours précédents</summary><table>'+tete+lignes.slice(14).join('')+'</table></details>':'');
 var p=d.parcours||{},et=[['Ont ouvert l’appli',p.nouveaux],['Ont commencé à lire',p.debut],['1er épisode fini',p.ep1],['3 épisodes finis',p.ep3],['10 épisodes finis',p.ep10],['Un chapitre fini',p.ch1],['Un défi fait',p.defi],['Un livre fini',p.fin]];
 var base=p.nouveaux||0;
 $('g2').innerHTML=base?et.map(function(e,i){var w=base?100*(e[1]||0)/base:0;return '<div class="etape"><span>'+e[0]+'</span><div class="rail" data-i="'+i+'"><div style="width:'+Math.max(w,e[1]?1:0)+'%;background:var(--s1)"></div><em>'+n(e[1])+' · '+pc(e[1]||0,base)+'</em></div></div>'}).join(''):'<p class="vide">Pas encore de nouveaux lecteurs.</p>';
 var parLivre={};(d.episodes||[]).forEach(function(r){(parLivre[r.b]=parLivre[r.b]||[]).push(r)});
 var inf={};(d.livres||[]).forEach(function(r){inf[r.b]=r});
 var html='',ids=Object.keys(parLivre).sort(function(a,b){return (inf[b]||{}).lecteurs-(inf[a]||{}).lecteurs});
 ids.forEach(function(b,i){var L=inf[b]||{};html+='<h2 style="margin-top:'+(i?18:0)+'px">'+esc(NOMS[b]||b)+'</h2><p class="sous">'+pl(L.lecteurs,'lecteur')+' l’'+((L.lecteurs||0)>=2?'ont':'a')+' commencé · '+n(L.fin)+' l’'+((L.fin||0)>=2?'ont':'a')+' fini</p><div id="g3_'+i+'"></div>'});
 $('g3').innerHTML=html||'<p class="vide">Pas encore d’épisode fini.</p>';
 ids.forEach(function(b,i){var rs=parLivre[b],max=rs[rs.length-1].n,m={};rs.forEach(function(r){m[r.n]=r.k});var cs=[];for(var e=0;e<=max;e++)cs.push({x:e,v:[m[e]||0]});
  barres('g3_'+i,cs,[{nom:'Lecteurs',coul:'var(--s1)'}],function(e){return 'É'+(e+1)},function(e){return (NOMS[b]||b)+' · épisode '+(e+1)})});
 var so={},ap={};(d.sources||[]).forEach(function(r){so[r.src]=(so[r.src]||0)+r.k;ap[r.plat]=(ap[r.plat]||0)+r.k});
 var ligne=function(o,N){return Object.keys(o).sort(function(a,b){return o[b]-o[a]}).map(function(k){return '<tr><td>'+esc(N[k]||k)+'</td><td>'+n(o[k])+'</td></tr>'}).join('')};
 $('t2').innerHTML=(d.sources||[]).length?'<table><tr><th>Où</th><th>Lecteurs</th></tr>'+ligne(so,SRC)+'</table><table style="margin-top:12px"><tr><th>Appareil</th><th>Lecteurs</th></tr>'+ligne(ap,PLAT)+'</table>':'<p class="vide">Pas encore de données.</p>';
 $('pied').textContent='Depuis le début : '+pl(T.lecteurs,'lecteur')+(T.premier?' (le premier le '+dateCourte(T.premier)+')':'')+' · '+pl(T.lignes,'événement gardé','événements gardés')+'.';
}
function charger(){
 cacher();$('err').textContent='';
 fetch('stats?jours='+jours,{headers:{Authorization:'Bearer '+encodeURIComponent(cle)},cache:'no-store'}).then(function(r){return r.json().then(function(j){return [r,j]})}).then(function(x){
  var r=x[0],d=x[1];if(!r.ok){$('porte').hidden=false;$('tdb').hidden=true;$('err').textContent=d.erreur||('Erreur '+r.status);return}
  $('porte').hidden=true;$('tdb').hidden=false;rendre(d)}).catch(function(e){$('err').textContent='Impossible de joindre le serveur : '+e.message;$('porte').hidden=false});
}
$('f').addEventListener('submit',function(e){e.preventDefault();cle=$('cle').value.trim();try{localStorage.setItem('cle',cle)}catch(er){}charger()});
document.querySelectorAll('[data-j]').forEach(function(b){b.addEventListener('click',function(){jours=+b.dataset.j;document.querySelectorAll('[data-j]').forEach(function(x){x.setAttribute('aria-pressed',x===b)});charger()})});
$('maj').addEventListener('click',charger);
$('sortir').addEventListener('click',function(){try{localStorage.removeItem('cle')}catch(e){}cle='';$('cle').value='';$('tdb').hidden=true;$('porte').hidden=false});
if(cle)charger();
var rt0=0;window.addEventListener('resize',function(){clearTimeout(rt0);rt0=setTimeout(function(){if(dernier&&!$('tdb').hidden)rendre(dernier)},200)});
})();
</script></body></html>`;
