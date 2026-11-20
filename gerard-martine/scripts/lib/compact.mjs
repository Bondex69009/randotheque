// Écriture compacte des données publiées (même fichier dans les deux Randothèques).
// Les petits dessins des cartes (forme de la trace, mini-profil) sont écrits en « polyline » (entiers
// en différences successives, 1 à 3 caractères par nombre) au lieu de tableaux de nombres décimaux :
// data/randos.js passe d'environ 1,4 Mo à moins d'1 Mo, et de ~400 à ~260 Ko une fois compressé.
// Un petit décodeur ajouté à la fin du fichier remet les tableaux d'origine avant que le site ne les lise.

// Encodage polyline (algorithme de Google) d'une suite d'entiers déjà en différences
export function encodeInts(nums) {
  let out = '';
  for (let v of nums) {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    out += String.fromCharCode(v + 63);
  }
  return out;
}

// Liste de points [lat, lon] -> texte (précision 1e-4 degré, environ 11 m, comme les formes actuelles)
export function encodePoints(points, factor = 1e4) {
  const prev = [0, 0], nums = [];
  for (const p of points) {
    for (let k = 0; k < 2; k++) {
      const v = Math.round(p[k] * factor);
      nums.push(v - prev[k]);
      prev[k] = v;
    }
  }
  return encodeInts(nums);
}

// Profil [[km, alt], …] à pas régulier -> [pas en km, altitudes encodées]
export function encodeProfile(profile) {
  if (!profile || profile.length < 2) return profile || [];
  const step = profile[profile.length - 1][0] / (profile.length - 1);
  let prev = 0;
  return [+step.toFixed(4), encodeInts(profile.map(([, e]) => { const d = e - prev; prev = e; return d; }))];
}

// Décodeur ajouté à data/randos.js (s'exécute avant le site, l'administration et les autres scripts)
export const DECODER = `(function(D){if(!D||!D.randos)return;
function ints(s){var o=[],i=0,n=s.length;while(i<n){var r=0,sh=0,b;do{b=s.charCodeAt(i++)-63;r|=(b&31)<<sh;sh+=5}while(b>=32);o.push(r&1?~(r>>1):r>>1)}return o}
function pts(s){var v=ints(s),o=[],a=0,b=0;for(var i=0;i+1<v.length;i+=2){a+=v[i];b+=v[i+1];o.push([a/1e4,b/1e4])}return o}
D.randos.forEach(function(r){
if(typeof r.shape==='string')r.shape=pts(r.shape);
if(r.profile&&r.profile.length===2&&typeof r.profile[1]==='string'){var st=r.profile[0],e=0;r.profile=ints(r.profile[1]).map(function(d,i){e+=d;return[Math.round(i*st*100)/100,e]})}
});
D.decodePoints=pts;})(window.RANDOTHEQUE);`;
