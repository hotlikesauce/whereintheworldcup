const state = {
  items: [],
  round: 0,
  guess: null,
  scores: [],
  distances: [],
  hintLevel: 0,
  testing: false,
  beta: false,
  betaOffset: 0,
  phase: 'guessing',
  map: null,
  guessMarker: null,
  targetMarker: null,
  revealLine: null,
};

const ROUNDS = 5;

const CATEGORY_ICONS = {
  'World Cup Moment':   '🏆',
  'Miracle Run':        '🔥',
  'Match Venue':        '⚽',
  'Stadium':            '🏟️',
  'Player Birthplace':  '👤',
  'Manager Birthplace': '📋',
  'Golden Boot':        '🥇',
  'Born Elsewhere':     '✈️',
  'Debut / Return':     '🆕',
  'Football Nation':    '🌍',
};

// Difficulty served per round: first two are gimmes, last two are tough.
const DIFFICULTY_BY_ROUND = [1, 1, 2, 3, 3];

// ── Daily seed ─────────────────────────────────────────────────────────────

function getDateStrOffset(offset) {
  const d = new Date();
  if (offset) d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayStr() { return getDateStrOffset(0); }

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h;
}

// Deterministic PRNG from a seed — same day, same numbers for everyone.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s ^= (s >>> 16);
    return Math.abs(s);
  };
}

// Pick one item per round following DIFFICULTY_BY_ROUND. If a difficulty bucket
// runs dry, fall back to the nearest available difficulty so we always fill 5.
function pickDaily(items, seed) {
  const rng = makeRng(seed);
  const byDiff = { 1: [], 2: [], 3: [] };
  items.forEach(it => { (byDiff[it.difficulty] || byDiff[2]).push(it); });

  const used = new Set();
  const usedLoc = new Set();   // avoid two questions at the same place in one day
  const locKey = it => `${it.lat.toFixed(1)},${it.lng.toFixed(1)}`;
  const result = [];
  for (const diff of DIFFICULTY_BY_ROUND) {
    const order = [diff, diff + 1, diff - 1, diff + 2, diff - 2];
    let picked = null;
    for (const d of order) {
      const pool = (byDiff[d] || []).filter(it => !used.has(it) && !usedLoc.has(locKey(it)));
      if (pool.length) { picked = pool[rng() % pool.length]; break; }
    }
    if (picked) { used.add(picked); usedLoc.add(locKey(picked)); result.push(picked); }
  }
  return result;
}

// ── Hints ────────────────────────────────────────────────────────────────

function getRegionHint(country) {
  const c = country.toLowerCase();
  if (/usa|canada|mexico|cuba|guatemala|panama|costa rica|honduras|nicaragua|belize|haiti|cura|jamaica|dominican|trinidad/.test(c)) return 'North or Central America';
  if (/peru|bolivia|chile|brazil|argentina|ecuador|colombia|venezuela|uruguay|paraguay|guiana|guyana|suriname/.test(c)) return 'South America';
  if (/uk|united kingdom|england|scotland|wales|northern ireland|france|spain|italy|germany|greece|croatia|czech|hungary|poland|estonia|latvia|lithuania|austria|belgium|norway|sweden|finland|denmark|iceland|netherlands|portugal|switzerland|romania|bulgaria|montenegro|bosnia|north macedonia|serbia|slovenia|slovakia|ukraine|malta|ireland|vatican|luxembourg|russia|turkey|türkiye/.test(c)) return 'Europe';
  if (/egypt|morocco|tunisia|algeria|libya|sudan|senegal|mali|ethiopia|kenya|tanzania|uganda|rwanda|zimbabwe|zambia|botswana|namibia|mozambique|madagascar|nigeria|ghana|ivory coast|cote|cameroon|cape verde|cabo verde|angola|south africa/.test(c)) return 'Africa';
  if (/jordan|israel|palestine|iran|iraq|saudi|united arab emirates|uae|qatar|oman|kuwait|bahrain|lebanon|syria|yemen/.test(c)) return 'the Middle East';
  if (/uzbekistan|kazakhstan|turkmenistan|tajikistan|kyrgyzstan/.test(c)) return 'Central Asia';
  if (/india|sri lanka|nepal|bhutan|bangladesh|pakistan|afghanistan|maldives/.test(c)) return 'South Asia';
  if (/china|japan|korea|cambodia|vietnam|laos|myanmar|indonesia|thailand|malaysia|singapore|philippines|taiwan|hong kong|mongolia|brunei/.test(c)) return 'East or Southeast Asia';
  if (/australia|new zealand|polynesia|fiji|samoa|tahiti|papua|tonga/.test(c)) return 'Oceania';
  return 'somewhere in the world';
}

// Progressive hint tiers — each lowers the score cap.
// (The trivia prompt is always free and never lowers the cap.)
const HINT_TIERS = [
  { label: 'Region',  cap: 75 },
  { label: 'Country', cap: 25 },
];

function hintText(item, level) {
  if (level === 1) return getRegionHint(item.country);
  return item.country;
}

function useHint() {
  if (state.phase !== 'guessing' || state.hintLevel >= HINT_TIERS.length) return;
  state.hintLevel++;
  const item = state.items[state.round];
  const tier = HINT_TIERS[state.hintLevel - 1];

  const box = document.getElementById('hint-box');
  const line = document.createElement('div');
  line.className = 'hint-line';
  line.innerHTML = `<span class="hint-tag">${tier.label}</span><span>${hintText(item, state.hintLevel)}</span>`;
  box.appendChild(line);
  box.style.display = 'flex';

  updateHintButton();
}

function updateHintButton() {
  const btn = document.getElementById('hint-btn');
  if (state.hintLevel >= HINT_TIERS.length) { btn.style.display = 'none'; return; }
  const next = HINT_TIERS[state.hintLevel];
  btn.style.display = 'block';
  btn.disabled = false;
  btn.textContent = `Hint ${state.hintLevel + 1}: ${next.label} · caps at ${next.cap} pts`;
}

// ── Map helpers ────────────────────────────────────────────────────────────

// Great-circle interpolation, antimeridian-safe
function greatCircle(lat1, lng1, lat2, lng2, steps = 100) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const φ1 = lat1*D2R, λ1 = lng1*D2R, φ2 = lat2*D2R, λ2 = lng2*D2R;
  const Δσ = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2));
  const pts = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    if (Δσ < 1e-10) return [lat1, lng1];
    const A = Math.sin((1-t)*Δσ)/Math.sin(Δσ), B = Math.sin(t*Δσ)/Math.sin(Δσ);
    const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2);
    const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2);
    const z = A*Math.sin(φ1) + B*Math.sin(φ2);
    return [Math.atan2(z, Math.sqrt(x*x+y*y))*R2D, Math.atan2(y,x)*R2D];
  });
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i-1][1];
    let lng = pts[i][1];
    while (lng - prev > 180) lng -= 360;
    while (prev - lng > 180) lng += 360;
    pts[i][1] = lng;
  }
  return pts;
}

function scoreToColor(score) {
  if (score >= 90) return '#22c55e';
  if (score >= 65) return '#f7c948';
  if (score >= 35) return '#f97316';
  return '#ef4444';
}

function clearReveal() {
  if (state.guessMarker)  { state.guessMarker.remove();  state.guessMarker  = null; }
  if (state.targetMarker) { state.targetMarker.remove(); state.targetMarker = null; }
  if (state.revealLine)   { state.revealLine.remove();   state.revealLine   = null; }
}

// Guess pin = a little soccer ball; target = gold flag pin.
const GUESS_ICON = () => L.divIcon({
  className: 'pin-wrap',
  html: '<div class="ball-pin">⚽</div>',
  iconSize: [26, 26], iconAnchor: [13, 13],
});
const TARGET_ICON = () => L.divIcon({
  className: 'pin-wrap',
  html: '<div class="map-pin map-pin--target"></div>',
  iconSize: [26, 26], iconAnchor: [13, 26],
});

// ── Map setup ──────────────────────────────────────────────────────────────

function setupMap() {
  state.map = L.map('globe-container', {
    center: [20, 0],
    zoom: 2,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    zoomControl: false,
  });

  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri', maxZoom: 19 }
  ).addTo(state.map);

  state.map.on('click', handleMapClick);

  setTimeout(() => state.map.invalidateSize(), 60);
  window.addEventListener('resize', () => state.map.invalidateSize());

  loadBoundaries();
  state.map.on('zoomend moveend', refreshBoundaries);
}

// ── Admin boundaries (world countries + US states) ──────────────────────────
// Reuses the public GeoJSON published for MonumentGuessr (same white outlines
// + labels). Swap GEO_BASE for your own bucket later if you like.

const GEO_BASE = 'https://monumentguessr-photos.s3.us-east-1.amazonaws.com/geo';

const boundaries = {
  countriesLayer: null, statesLayer: null,
  countryLabelData: [], stateLabelData: [],
  countryFeatures: null,
  winFeatures: null,   // high-res (NE 50m) polygons for the country-win check
  labelGroup: null,
};

// ── "Anywhere in the country wins" (point-in-polygon) ────────────────────────
// Miracle-run items carry winCountry = the exact GeoJSON country name. If the
// guess lands inside that country's borders, it scores a full 100.

const COUNTRY_ALIASES = {
  'usa': 'United States of America', 'united states': 'United States of America',
  'uk': 'United Kingdom', 'england': 'United Kingdom', 'scotland': 'United Kingdom',
  'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
  'ivory coast': "Côte d'Ivoire", 'korea': 'South Korea',
  'czech republic': 'Czechia', 'cape verde': 'Cabo Verde',
};

function resolveCountryName(name) {
  const k = (name || '').toLowerCase().trim();
  return COUNTRY_ALIASES[k] || name;
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lat, lng, coords, type) {
  const polys = type === 'MultiPolygon' ? coords : [coords];
  for (const poly of polys) {
    if (!poly.length || !pointInRing(lat, lng, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lat, lng, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

function pointInCountry(lat, lng, countryName) {
  const target = resolveCountryName(countryName).toLowerCase();
  // Prefer the high-res NE 50m subset; if the country isn't in it, fall back to
  // the (lower-res) rendering boundaries so winCountry works for any nation.
  for (const src of [boundaries.winFeatures, boundaries.countryFeatures]) {
    if (!src) continue;
    const feats = src.filter(
      f => ((f.properties && f.properties.n) || '').toLowerCase() === target);
    if (!feats.length) continue;   // not in this source — try the next
    const hit = (la, ln) => feats.some(f => pointInPolygon(la, ln, f.geometry.coordinates, f.geometry.type));
    if (hit(lat, lng)) return true;
    // Small tolerance ring (~6km) so coastal guesses aren't rejected by the
    // simplified coastline.
    const D = 0.06;
    for (const dla of [-D, 0, D]) for (const dln of [-D, 0, D]) {
      if ((dla || dln) && hit(lat + dla, lng + dln)) return true;
    }
    return false;   // country found in this source but the point is outside it
  }
  return false;
}

function featureBox(feature) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  (function scan(c) {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
    } else c.forEach(scan);
  })(feature.geometry.coordinates);
  return { lat: (minY + maxY) / 2, lng: (minX + maxX) / 2,
           w: maxX - minX, bbox: [minX, minY, maxX, maxY] };
}

async function fetchGeo(name) {
  const r = await fetch(`${GEO_BASE}/${name}.geojson`);
  return r.json();
}

function countryAbbr(f) {
  const ab = f.properties && f.properties.ab;
  if (ab && /^[A-Za-z]{3}$/.test(ab)) return ab.toUpperCase();
  return ((f.properties && f.properties.n) || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}

async function loadBoundaries() {
  boundaries.labelGroup = L.layerGroup().addTo(state.map);

  // High-res polygons (NE 50m subset) for the "anywhere in country wins" check.
  try {
    const r = await fetch('geo/win-countries.geojson');
    boundaries.winFeatures = (await r.json()).features;
  } catch (e) { console.warn('win-countries load failed', e); }

  try {
    const countries = await fetchGeo('countries');
    boundaries.countriesLayer = L.geoJSON(countries, {
      style: { color: '#ffffff', weight: 1, opacity: 0.5,
               fill: false, interactive: false },
      interactive: false,
      renderer: L.canvas({ padding: 0.5 }),
    }).addTo(state.map);
    boundaries.countryFeatures = countries.features;
    boundaries.countryLabelData = countries.features.map(f => ({
      ...featureBox(f), text: countryAbbr(f),
    }));
  } catch (e) { console.warn('countries load failed', e); }

  try {
    const states = await fetchGeo('states');
    boundaries.statesLayer = L.geoJSON(states, {
      style: { color: '#ffffff', weight: 0.6, opacity: 0.4,
               fill: false, interactive: false },
      interactive: false,
      renderer: L.canvas({ padding: 0.5 }),
    });
    boundaries.stateLabelData = states.features.map(f => ({
      ...featureBox(f), text: f.properties.ab,
    }));
  } catch (e) { console.warn('states load failed', e); }

  refreshBoundaries();
}

function makeLabel(d, cls) {
  return L.marker([d.lat, d.lng], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: '', html: `<span class="map-label ${cls}">${d.text}</span>` }),
  });
}

function refreshBoundaries() {
  if (!boundaries.labelGroup) return;
  const z = state.map.getZoom();
  const m = state.map;

  if (boundaries.statesLayer) {
    if (z >= 5) { if (!m.hasLayer(boundaries.statesLayer)) boundaries.statesLayer.addTo(m); }
    else if (m.hasLayer(boundaries.statesLayer)) m.removeLayer(boundaries.statesLayer);
  }

  // Labels intentionally disabled — country/state outlines only, no text.
  boundaries.labelGroup.clearLayers();
}

// ── Round management ───────────────────────────────────────────────────────

function startRound(i) {
  state.round = i;
  state.guess = null;
  state.phase = 'guessing';

  if (state.testing) state.items[i] = pickRandomItem();

  clearReveal();
  if (state.guessMarker) { state.guessMarker.remove(); state.guessMarker = null; }
  state.map.setView([20, 0], 2);
  state.hintLevel = 0;

  const item = state.items[i];
  const icon = CATEGORY_ICONS[item.category] || '⚽';

  const roundTag = state.testing ? 'Test'
                 : state.beta ? `Beta ${getDateStrOffset(state.betaOffset)} · ${i + 1}/${ROUNDS}`
                 : `Round ${i + 1} / ${ROUNDS}`;
  document.getElementById('round-badge').innerHTML =
    `<span class="badge-cat">${icon} ${item.category}</span>` +
    `<span class="badge-round">${roundTag}</span>`;

  // Trivia prompt
  const promptBox = document.getElementById('prompt-box');
  promptBox.textContent = item.prompt;
  promptBox.style.display = 'block';

  // Optional photo
  const photoWrap = document.getElementById('photo-container');
  const img = document.getElementById('site-photo');
  const loader = document.getElementById('photo-loading');
  if (item.photo) {
    photoWrap.style.display = 'block';
    img.style.opacity = '0';
    loader.style.display = 'flex';
    loader.textContent = 'Loading';
    img.onload  = () => { loader.style.display = 'none'; img.style.opacity = '1'; };
    img.onerror = () => { loader.textContent = 'Photo unavailable'; };
    img.src = item.photo;
  } else {
    photoWrap.style.display = 'none';
    img.removeAttribute('src');
  }

  const hintBox = document.getElementById('hint-box');
  hintBox.innerHTML = '';
  hintBox.style.display = 'none';
  document.getElementById('confirm-btn').disabled = true;
  document.getElementById('confirm-btn').style.display = 'block';
  document.getElementById('next-btn').style.display = 'none';
  document.getElementById('reveal-section').style.display = 'none';
  document.getElementById('item-fact').style.display = 'none';
  updateHintButton();
}

function handleMapClick(e) {
  if (state.phase !== 'guessing') return;
  const { lat, lng } = e.latlng;
  state.guess = { lat, lng };
  if (state.guessMarker) state.guessMarker.remove();
  state.guessMarker = L.marker([lat, lng], { icon: GUESS_ICON() }).addTo(state.map);
  document.getElementById('confirm-btn').disabled = false;
}

function confirmGuess() {
  if (!state.guess || state.phase !== 'guessing') return;
  state.phase = 'revealed';

  const item      = state.items[state.round];
  const dist      = Scoring.haversineKm(state.guess.lat, state.guess.lng, item.lat, item.lng);
  // Right country = a guaranteed floor (full 100 for "pin the country" items).
  const target    = item.winCountry || item.country;
  const inCountry = pointInCountry(state.guess.lat, state.guess.lng, target);
  let rawScore    = (item.winCountry && inCountry) ? 100 : Scoring.calcScore(dist, item.radius);
  if (inCountry) rawScore = Math.max(rawScore, Scoring.COUNTRY_FLOOR);
  const score     = Math.min(rawScore, Scoring.capForHints(state.hintLevel));

  state.distances.push(dist);
  state.scores.push(score);

  const color = scoreToColor(score);
  const gcPts = greatCircle(state.guess.lat, state.guess.lng, item.lat, item.lng);
  state.revealLine   = L.polyline(gcPts, { color, weight: 2.5, opacity: 0.9 }).addTo(state.map);
  state.targetMarker = L.marker([item.lat, item.lng], { icon: TARGET_ICON() }).addTo(state.map);

  const bounds = L.latLngBounds([[state.guess.lat, state.guess.lng], [item.lat, item.lng]]);
  state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 8, animate: true });

  document.getElementById('hint-btn').style.display = 'none';
  document.getElementById('hint-box').style.display = 'none';
  document.getElementById('prompt-box').style.display = 'none';

  const capNote = state.hintLevel > 0 ? ` (${state.hintLevel} hint${state.hintLevel > 1 ? 's' : ''})` : '';
  document.getElementById('item-name').textContent    = item.name;
  document.getElementById('item-answer').textContent  = item.answer;
  const distText = Scoring.formatDist(dist);
  document.getElementById('dist-display').textContent =
    (item.winCountry && inCountry) ? `✓ ${item.country}`
    : inCountry ? `${distText} · ✓ ${item.country}`
    : distText;
  document.getElementById('round-score').textContent  = `+${score}${capNote}`;
  document.getElementById('total-score').textContent  = state.scores.reduce((a, b) => a + b, 0);
  document.getElementById('reveal-section').style.display = 'block';

  const factEl = document.getElementById('item-fact');
  if (item.fact) {
    factEl.textContent = item.fact;
    factEl.style.display = 'block';
  } else {
    factEl.style.display = 'none';
  }

  document.getElementById('confirm-btn').style.display = 'none';
  const nextBtn = document.getElementById('next-btn');
  nextBtn.style.display = 'block';
  nextBtn.textContent = state.testing ? 'Next →'
                      : state.round < ROUNDS - 1 ? 'Next Round →' : 'See Results →';
}

function nextRound() {
  if (state.testing) { startRound(state.round + 1); return; }
  if (state.round < ROUNDS - 1) {
    startRound(state.round + 1);
  } else {
    showSummary();
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

function showSummary() {
  const total = state.scores.reduce((a, b) => a + b, 0);
  const saved = {
    date: state.beta ? getDateStrOffset(state.betaOffset) : getTodayStr(),
    total,
    scores: state.scores,
    distances: state.distances,
    items: state.items.map(s => s.name),
  };
  // Beta mode is throwaway — never touch the real daily result or stats.
  if (!state.beta) {
    localStorage.setItem('witwc-daily', JSON.stringify(saved));
    updateStats(total);
  }
  renderSummary(saved);
  document.getElementById('game-screen').style.display = 'none';
  document.getElementById('summary-screen').style.display = 'flex';
}

// ── Beta mode: play / replay any day's puzzle (no daily lock, no saving) ──────

function startBeta(offset) {
  state.beta = true;
  state.testing = false;
  state.betaOffset = offset || 0;
  state.scores = [];
  state.distances = [];
  document.body.classList.add('beta');
  document.getElementById('splash-screen').style.display = 'none';
  document.getElementById('summary-screen').style.display = 'none';
  document.getElementById('already-played-msg').style.display = 'none';
  document.getElementById('game-screen').style.display = '';
  const seed = hashSeed(getDateStrOffset(state.betaOffset));
  state.items = pickDaily(ITEMS, seed);
  state.map.invalidateSize();
  startRound(0);
}

function renderSummary(saved) {
  const max = ROUNDS * 100;
  document.getElementById('final-score').textContent = `${saved.total} / ${max}`;
  const pct = saved.total / max;
  document.getElementById('result-msg').textContent =
    pct === 1   ? 'Perfect — World Cup winner!' :
    pct >= 0.9  ? 'World class!'   :
    pct >= 0.75 ? 'Top of the table!' :
    pct >= 0.5  ? 'Solid effort!' :
    pct >= 0.25 ? 'Mid-table finish' : 'Relegation battle!';

  const betaNav = document.getElementById('beta-nav');
  const betaEnter = document.getElementById('beta-enter');
  if (betaNav)   betaNav.style.display   = state.beta ? 'flex'  : 'none';
  if (betaEnter) betaEnter.style.display = state.beta ? 'none'  : 'block';

  const list = document.getElementById('round-list');
  list.innerHTML = '';
  saved.items.forEach((name, i) => {
    const score = saved.scores[i];
    const bar   = score >= 90 ? '🟩' : score >= 70 ? '🟨' : score >= 40 ? '🟧' : '🟥';
    const row   = document.createElement('div');
    row.className = 'round-row';
    row.innerHTML = `
      <span class="rr-bar">${bar}</span>
      <span class="rr-name">${name}</span>
      <span class="rr-dist">${Scoring.formatDist(saved.distances[i])}</span>
      <span class="rr-pts">${score} pts</span>
    `;
    list.appendChild(row);
  });
}

function flashShareBtn(msg) {
  const btn = document.getElementById('share-btn');
  if (!btn) return;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = 'Share Result'; }, 2000);
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

async function shareResult() {
  const saved = JSON.parse(localStorage.getItem('witwc-daily') || 'null');
  if (!saved || !Array.isArray(saved.scores)) return;
  const max = ROUNDS * 100;
  const bars = saved.scores.map(s => s >= 90 ? '🟩' : s >= 70 ? '🟨' : s >= 40 ? '🟧' : '🟥');
  const text = `WhereInTheWorldCup ${saved.date}\n${saved.total}/${max}\n${bars.join('')}\nwhereintheworldcup.com`;

  if (navigator.share) {
    try { await navigator.share({ title: 'WhereInTheWorldCup', text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); flashShareBtn('Copied!'); return; }
    catch { /* fall through */ }
  }
  flashShareBtn(legacyCopy(text) ? 'Copied!' : 'Press & hold to copy');
}

function updateStats(total) {
  const stats = JSON.parse(localStorage.getItem('witwc-stats') || '{}');
  stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
  stats.totalScore  = (stats.totalScore  || 0) + total;
  stats.bestScore   = Math.max(stats.bestScore || 0, total);
  localStorage.setItem('witwc-stats', JSON.stringify(stats));
}

// ── Init ───────────────────────────────────────────────────────────────────

function init() {
  setupMap();
  setupTestToggle();

  const seed = hashSeed(getTodayStr());
  state.items = pickDaily(ITEMS, seed);

  if (location.hash === '#test') { enterTestMode(); return; }

  const saved = JSON.parse(localStorage.getItem('witwc-daily') || 'null');
  if (saved && saved.date === getTodayStr()) {
    state.scores    = saved.scores;
    state.distances = saved.distances;
    renderSummary(saved);
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('summary-screen').style.display = 'flex';
    document.getElementById('already-played-msg').style.display = 'block';
    return;
  }

  document.getElementById('splash-screen').style.display = 'flex';
}

function startGame() {
  document.getElementById('splash-screen').style.display = 'none';
  state.map.invalidateSize();
  startRound(0);
}

// ── Testing mode ────────────────────────────────────────────────────────────
// Unlimited random rounds; bypasses daily seed + already-played lock.
// Trigger: tap the round badge 5× quickly, or load with #test.

function pickRandomItem() {
  return ITEMS[Math.floor(Math.random() * ITEMS.length)];
}

function enterTestMode() {
  state.testing = true;
  state.scores = [];
  state.distances = [];
  document.getElementById('splash-screen').style.display = 'none';
  document.getElementById('summary-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = '';
  document.body.classList.add('testing');
  state.map.invalidateSize();
  startRound(0);
}

let _badgeTaps = 0, _badgeTimer = null;
function registerTestTap(el) {
  if (!el) return;
  el.addEventListener('click', () => {
    _badgeTaps++;
    clearTimeout(_badgeTimer);
    _badgeTimer = setTimeout(() => { _badgeTaps = 0; }, 1500);
    if (_badgeTaps >= 5) {
      _badgeTaps = 0;
      if (!state.testing) enterTestMode();
      else location.href = location.pathname;
    }
  });
}
function setupTestToggle() {
  registerTestTap(document.getElementById('round-badge'));
  registerTestTap(document.querySelector('#summary-card h1'));
}

// ── Photo lightbox (pinch / drag / double-tap / wheel zoom) ──────────────────

const lb = {
  scale: 1, x: 0, y: 0,
  startX: 0, startY: 0,
  pointers: new Map(),
  startDist: 0, startScale: 1, startMidX: 0, startMidY: 0,
  moved: false, lastTap: 0,
};

function lbImg()   { return document.getElementById('lightbox-img'); }
function lbApply() { lbImg().style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`; }
function lbReset() { lb.scale = 1; lb.x = 0; lb.y = 0; lbApply(); }

function lbDist() {
  const p = [...lb.pointers.values()];
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}
function lbMid() {
  const p = [...lb.pointers.values()];
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}
function lbClamp(s) { return Math.min(6, Math.max(1, s)); }

function openPhoto() {
  const src = document.getElementById('site-photo').src;
  if (!src) return;
  lbImg().src = src;
  document.getElementById('photo-lightbox').style.display = 'flex';
  lbReset();
}

function closePhoto(e) {
  if (e) e.stopPropagation();
  document.getElementById('photo-lightbox').style.display = 'none';
}

function setupLightbox() {
  const stage = document.getElementById('lightbox-stage');
  const img = lbImg();
  if (!stage) return;

  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lb.moved = false;
    img.style.transition = 'none';
    if (lb.pointers.size === 1) {
      lb.startX = e.clientX - lb.x;
      lb.startY = e.clientY - lb.y;
    } else if (lb.pointers.size === 2) {
      lb.startDist = lbDist();
      lb.startScale = lb.scale;
      const m = lbMid();
      lb.startMidX = m.x - lb.x;
      lb.startMidY = m.y - lb.y;
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!lb.pointers.has(e.pointerId)) return;
    lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (lb.pointers.size === 2) {
      lb.scale = lbClamp(lb.startScale * lbDist() / lb.startDist);
      const m = lbMid();
      lb.x = m.x - lb.startMidX;
      lb.y = m.y - lb.startMidY;
      lb.moved = true;
      lbApply();
    } else if (lb.pointers.size === 1 && lb.scale > 1) {
      lb.x = e.clientX - lb.startX;
      lb.y = e.clientY - lb.startY;
      lb.moved = true;
      lbApply();
    }
  });

  const onUp = e => {
    const wasTap = !lb.moved && lb.pointers.size === 1;
    const target = e.target;
    lb.pointers.delete(e.pointerId);

    if (lb.pointers.size === 1) {
      const p = [...lb.pointers.values()][0];
      lb.startX = p.x - lb.x;
      lb.startY = p.y - lb.y;
    }
    if (lb.pointers.size === 0 && lb.scale <= 1) { lb.x = 0; lb.y = 0; lbApply(); }

    if (wasTap) {
      const now = Date.now();
      if (target === img && now - lb.lastTap < 300) {
        img.style.transition = 'transform 0.18s ease';
        if (lb.scale > 1) lbReset();
        else { lb.scale = 2.5; lbApply(); }
        lb.lastTap = 0;
      } else if (target !== img && lb.scale <= 1) {
        closePhoto();
      } else {
        lb.lastTap = now;
      }
    }
  };
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', e => { lb.pointers.delete(e.pointerId); });

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    img.style.transition = 'none';
    lb.scale = lbClamp(lb.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    if (lb.scale === 1) { lb.x = 0; lb.y = 0; }
    lbApply();
  }, { passive: false });
}

function init2() { init(); setupLightbox(); }
document.addEventListener('DOMContentLoaded', init2);
