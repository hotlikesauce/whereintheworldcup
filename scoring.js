const Scoring = {
  haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  // ~20 miles. Land anywhere inside an item's free radius and you score a full 100.
  // Stadiums and birthplaces are single points, so this gives a fair "right city" zone.
  DEFAULT_FREE_KM: 32,

  // Full 100 inside the free radius (per-item override available), then halves
  // roughly every 1000 km beyond it.
  calcScore(distKm, freeKm) {
    const free = (freeKm == null ? this.DEFAULT_FREE_KM : freeKm);
    const d = Math.max(0, distKm - free);
    if (d <= 0) return 100;
    const k = Math.LN2 / 1000;
    return Math.max(0, Math.round(100 * Math.exp(-k * d)));
  },

  // Max points achievable given how many hints were used:
  // 0 -> 100, 1 -> 75 (Region), 2 -> 25 (Country)
  // (the trivia prompt itself is free and never lowers the cap)
  HINT_CAPS: [100, 75, 25],

  capForHints(hintLevel) {
    return this.HINT_CAPS[Math.min(hintLevel, this.HINT_CAPS.length - 1)];
  },

  formatDist(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km).toLocaleString()} km`;
  }
};
