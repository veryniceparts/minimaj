// Tile model.
// Each physical tile has an id 0..135. Its type is id >> 2 (0..33):
//   0-8  man 1-9 | 9-17 pin 1-9 | 18-26 sou 1-9
//   27-30 winds E S W N | 31 haku (white) 32 hatsu (green) 33 chun (red)
// One red five per suit: ids 16 (5m), 52 (5p), 88 (5s).

export const RED_IDS = [16, 52, 88];
export const tileType = (id) => id >> 2;
export const isRed = (id) => id === 16 || id === 52 || id === 88;
export const isHonor = (t) => t >= 27;
export const isTerminal = (t) => t < 27 && (t % 9 === 0 || t % 9 === 8);
export const isYaochu = (t) => t >= 27 || t % 9 === 0 || t % 9 === 8;
export const isDragon = (t) => t >= 31;
export const isWind = (t) => t >= 27 && t <= 30;
export const suitOf = (t) => (t < 27 ? Math.floor(t / 9) : 3);
export const numOf = (t) => (t < 27 ? (t % 9) + 1 : 0);

export function doraFromIndicator(t) {
  if (t < 27) return t % 9 === 8 ? t - 8 : t + 1;
  if (t < 31) return t === 30 ? 27 : t + 1;
  return t === 33 ? 31 : t + 1;
}

export function countsOfTypes(types) {
  const c = new Array(34).fill(0);
  for (const t of types) c[t]++;
  return c;
}

export const countsOf = (ids) => countsOfTypes(ids.map(tileType));
export const sortIds = (ids) => ids.slice().sort((a, b) => a - b);

const HONOR_NAMES = ['E', 'S', 'W', 'N', 'Wh', 'G', 'R'];
export function typeName(t) {
  if (t < 27) return `${(t % 9) + 1}${'mps'[Math.floor(t / 9)]}`;
  return HONOR_NAMES[t - 27];
}

export const WIND_NAMES = ['East', 'South', 'West', 'North'];
export const WIND_CHARS = ['東', '南', '西', '北'];
