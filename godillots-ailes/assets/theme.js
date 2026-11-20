/* Randothèque – bouton du thème (même fichier dans les deux sites).
   Trois choix, dans l'ordre : Auto (suit le téléphone ou l'ordinateur), Clair, Sombre. Le choix est gardé
   sur l'appareil. Le thème lui-même est posé avant l'affichage par le petit script en tête de index.html
   (window.rtTheme), pour éviter un flash de la mauvaise couleur. */
(() => {
  'use strict';
  const T = window.rtTheme;
  const btn = document.getElementById('theme-btn');
  if (!T || !btn) return;
  const ORDER = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'automatique (comme l\'appareil)', light: 'clair', dark: 'sombre' };
  const meta = document.querySelector('meta[name="theme-color"]');
  const darkColor = meta ? meta.content : '#000';

  function paint() {
    const choice = T.get();
    btn.dataset.choice = choice;
    btn.setAttribute('aria-label', `Thème ${LABEL[choice]}. Changer de thème`);
    btn.title = `Thème ${LABEL[choice]}`;
    if (meta) meta.content = document.documentElement.dataset.theme === 'light' ? getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim() || '#fff' : darkColor;
  }
  btn.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(T.get()) + 1) % ORDER.length];
    T.set(next);
    if (window.rtStat) window.rtStat('theme', LABEL[next]);
  });
  document.addEventListener('rt-theme', paint);
  paint();
})();
