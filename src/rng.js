// Seeded pseudo-random numbers (mulberry32). Every random choice in the
// generator goes through one of these streams, so output is reproducible.

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function createRng(seed, label = 'root') {
  let state = fnv1a(`${seed}:${label}`) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    /** Independent stream derived from the same seed. */
    fork: (name) => createRng(seed, `${label}/${name}`),
    float: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted(items, weightOf = (item) => item[1]) {
      const total = items.reduce((sum, item) => sum + weightOf(item), 0);
      let r = next() * total;
      for (const item of items) {
        r -= weightOf(item);
        if (r < 0) return item;
      }
      return items[items.length - 1];
    },
    normal() {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    lognormal: (median, sigma) => median * Math.exp(sigma * rng.normal()),
    hex: (length) => {
      let out = '';
      for (let i = 0; i < length; i += 1) out += Math.floor(next() * 16).toString(16);
      return out;
    },
    chars(length, alphabet = B64) {
      let out = '';
      for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(next() * alphabet.length)];
      return out;
    },
    upper: (length) => rng.chars(length, UPPER),
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    uuid() {
      const h = rng.hex(32);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(next() * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
  };
  return rng;
}
