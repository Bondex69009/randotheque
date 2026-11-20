/* Randothèque – carte de chaleur de toutes les traces (même fichier dans les deux sites).
   Bouton « Carte de chaleur » sur la carte d'ensemble : toutes les traces de la sélection en cours sont
   superposées ; plus un chemin a été parcouru, plus il passe du bleu au jaune. Les traces allégées
   (data/chaleur.js, environ 130 Ko) ne sont chargées qu'au premier affichage.
   Utilisation par app.js : const h = RTChaleur.attach(carte, options) puis h.setRandos(liste filtrée). */
(() => {
  'use strict';

  // Couleur selon la densité (0 à 255) : transparent, bleu, violet, rouge, orange, jaune
  const STOPS = [[0, [59, 91, 219, 0]], [0.08, [59, 91, 219, 150]], [0.3, [156, 54, 181, 205]], [0.55, [240, 62, 62, 230]],
    [0.8, [255, 146, 43, 245]], [1, [255, 224, 102, 255]]];
  const PALETTE = (() => {
    const p = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
      const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1];
      const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
      for (let j = 0; j < 4; j++) p[i * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
    }
    return p;
  })();

  let heatData = null, heatP = null;
  function loadHeat(url) {
    if (heatData) return Promise.resolve(heatData);
    if (!heatP) {
      heatP = new Promise((resolve, reject) => {
        window.__rtHeat = (obj) => {
          const dec = window.RANDOTHEQUE && window.RANDOTHEQUE.decodePoints;
          heatData = new Map(Object.entries(obj).map(([id, s]) => [id, dec ? dec(s) : []]));
          resolve(heatData);
        };
        const s = document.createElement('script');
        s.src = url;
        s.onerror = () => { heatP = null; s.remove(); reject(new Error('carte de chaleur introuvable')); };
        document.head.appendChild(s);
      });
    }
    return heatP;
  }

  function attach(map, { dataUrl, cluster, onToggle } = {}) {
    const L = window.L;
    let randos = [], on = false, drawn = null;
    const projCache = new Map(); // zoom -> Map(id -> Float64Array de points en pixels du monde)

    const Heat = L.Layer.extend({
      onAdd(m) {
        this._c = L.DomUtil.create('canvas', 'heat-layer leaflet-zoom-hide');
        m.getPane('overlayPane').appendChild(this._c);
        m.on('moveend resize', this._draw, this);
        this._draw();
      },
      onRemove(m) {
        L.DomUtil.remove(this._c);
        m.off('moveend resize', this._draw, this);
      },
      _draw() {
        if (!heatData || !this._c) return;
        const size = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
        const c = this._c;
        L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
        c.style.width = `${size.x}px`; c.style.height = `${size.y}px`;
        c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr);
        const g = c.getContext('2d', { willReadFrequently: true });
        const z = map.getZoom();
        if (!projCache.has(z)) projCache.set(z, new Map());
        const cache = projCache.get(z);
        const origin = map.getPixelBounds().min;
        const view = map.getBounds().pad(0.05);
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.lineWidth = Math.max(1.5, Math.min(5, (z - 6) * 0.55)) * dpr;
        g.strokeStyle = `rgba(0,0,0,${z >= 13 ? 0.32 : 0.2})`;
        for (const r of randos) {
          const b = r.bbox;
          if (b && !view.intersects([[b[0], b[1]], [b[2], b[3]]])) continue;
          let px = cache.get(r.id);
          if (!px) {
            const pts = heatData.get(r.id);
            if (!pts || pts.length < 2) continue;
            px = new Float64Array(pts.length * 2);
            pts.forEach((p, i) => { const q = map.project(p, z); px[i * 2] = q.x; px[i * 2 + 1] = q.y; });
            cache.set(r.id, px);
          }
          g.beginPath();
          for (let i = 0; i < px.length; i += 2) {
            const x = (px[i] - origin.x) * dpr, y = (px[i + 1] - origin.y) * dpr;
            if (i) g.lineTo(x, y); else g.moveTo(x, y);
          }
          g.stroke();
        }
        // Densité (opacité accumulée) -> couleurs de la palette
        const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
        for (let i = 3; i < d.length; i += 4) {
          const a = d[i];
          if (!a) continue;
          const k = a * 4;
          d[i - 3] = PALETTE[k]; d[i - 2] = PALETTE[k + 1]; d[i - 1] = PALETTE[k + 2]; d[i] = PALETTE[k + 3];
        }
        g.putImageData(img, 0, 0);
        drawn = randos.length;
      },
    });
    const layer = new Heat();

    // Bouton sur la carte (sous le zoom) et légende
    const Toggle = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar heat-ctrl');
        box.innerHTML = `<button type="button" class="heat-ctrl__btn" aria-pressed="false" title="Superposer toutes les traces : les chemins les plus parcourus ressortent">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.6.7-2.8 1.6-3.7.2 1.5 1 2.3 2 2.6C11 8 11 5.5 12 3Z" fill="currentColor"/><path d="M6.5 13.5A5.5 5.5 0 0 0 12 21a5.5 5.5 0 0 0 5.5-7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <span>Carte de chaleur</span></button>`;
        L.DomEvent.disableClickPropagation(box);
        box.querySelector('button').addEventListener('click', () => toggle(!on));
        return box;
      },
    });
    const Legend = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'heat-legend');
        box.innerHTML = '<span>Peu parcouru</span><i aria-hidden="true"></i><span>Très parcouru</span><small data-heat-count></small>';
        return box;
      },
    });
    const ctrl = new Toggle().addTo(map);
    const legend = new Legend();
    const btn = ctrl.getContainer().querySelector('button');

    function paintCount() {
      const el = legend.getContainer() && legend.getContainer().querySelector('[data-heat-count]');
      if (el) el.textContent = `${randos.length} trace${randos.length > 1 ? 's' : ''}`;
    }

    async function toggle(want) {
      on = want;
      btn.setAttribute('aria-pressed', String(on));
      map.getContainer().classList.toggle('is-heat', on);
      if (onToggle) onToggle(on);
      if (!on) {
        map.removeLayer(layer); legend.remove();
        if (cluster && !map.hasLayer(cluster)) map.addLayer(cluster);
        return;
      }
      btn.classList.add('is-loading');
      try { await loadHeat(dataUrl); } catch {
        btn.classList.remove('is-loading');
        on = false; btn.setAttribute('aria-pressed', 'false'); map.getContainer().classList.remove('is-heat');
        alert('La carte de chaleur n\'a pas pu se charger. Vérifiez la connexion internet puis réessayez.');
        return;
      }
      btn.classList.remove('is-loading');
      if (!on) return;
      if (cluster && map.hasLayer(cluster)) map.removeLayer(cluster);
      legend.addTo(map); paintCount();
      if (!map.hasLayer(layer)) map.addLayer(layer); else layer._draw();
      // Vue trop large (toute la France) : on se place sur le cœur des randos (départ médian)
      if (map.getZoom() < 9 && randos.length) {
        const med = (k) => randos.map((r) => r.start[k]).sort((a, b) => a - b)[randos.length >> 1];
        map.setView([med(0), med(1)], 10);
      }
    }

    return {
      setRandos(list) {
        randos = list;
        paintCount();
        if (on && map.hasLayer(layer) && drawn !== null) layer._draw();
      },
      isOn: () => on,
      toggle,
    };
  }

  window.RTChaleur = { attach };
})();
