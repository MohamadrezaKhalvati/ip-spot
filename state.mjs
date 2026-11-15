import { validCoordinates } from './location.mjs';

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const HISTORY_LIMIT = 5;

const STORAGE_KEY = 'ipSpotStateV1';
const SCHEMA = 1;

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
}

function validLocation(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.ip === 'string' && value.ip.trim().length > 0;
}

function emptyState() {
  return { schema: SCHEMA, location: null, checkedAt: null, changedFromIp: null, history: [] };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];
  for (const entry of value) {
    if (!entry || typeof entry.ip !== 'string' || !entry.ip.trim() ||
        !validTimestamp(entry.checkedAt) || seen.has(entry.ip)) continue;

    seen.add(entry.ip);
    result.push({
      ip: entry.ip,
      city: typeof entry.city === 'string' && entry.city.trim() ? entry.city.trim() : 'Unknown',
      region: typeof entry.region === 'string' && entry.region.trim() ? entry.region.trim() : 'Unknown',
      country: typeof entry.country === 'string' && entry.country.trim() ? entry.country.trim() : 'Unknown',
      coordinates: entry.coordinates && validCoordinates(entry.coordinates.latitude, entry.coordinates.longitude)
        ? { latitude: entry.coordinates.latitude, longitude: entry.coordinates.longitude }
        : null,
      checkedAt: entry.checkedAt,
    });
    if (result.length === HISTORY_LIMIT) break;
  }
  return result;
}

function normalizeState(value) {
  if (value?.schema !== SCHEMA || !validLocation(value.location) || !validTimestamp(value.checkedAt)) {
    return emptyState();
  }

  return {
    schema: SCHEMA,
    location: value.location,
    checkedAt: value.checkedAt,
    changedFromIp: typeof value.changedFromIp === 'string' && value.changedFromIp.trim()
      ? value.changedFromIp : null,
    history: normalizeHistory(value.history),
  };
}

function snapshot(state, now, source, persisted) {
  const elapsed = now - state.checkedAt;
  return {
    location: state.location,
    checkedAt: state.checkedAt,
    changedFromIp: state.changedFromIp,
    history: state.history,
    fresh: elapsed >= 0 && elapsed < CACHE_TTL_MS,
    source,
    persisted,
  };
}

function nextState(previous, location, checkedAt) {
  const latest = {
    ip: location.ip,
    city: location.city,
    region: location.region,
    country: location.country,
    coordinates: location.coordinates,
    checkedAt,
  };
  return {
    schema: SCHEMA,
    location,
    checkedAt,
    changedFromIp: previous.location && previous.location.ip !== location.ip ? previous.location.ip : null,
    history: normalizeHistory([latest, ...previous.history.filter((entry) => entry.ip !== location.ip)]),
  };
}

export function formatHistoryTime(timestamp) {
  return validTimestamp(timestamp)
    ? new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Unknown';
}

export function formatCheckedTime(timestamp) {
  return validTimestamp(timestamp)
    ? new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : 'Unknown';
}

export function createIpSpotService({ storage, lookup, now = Date.now }) {
  let state;
  let loaded;
  let inFlight = null;
  let persisted = true;

  async function load() {
    if (!loaded) {
      loaded = (async () => {
        try {
          state = normalizeState((await storage.get(STORAGE_KEY))?.[STORAGE_KEY]);
        } catch {
          state = emptyState();
          persisted = false;
        }
      })();
    }
    await loaded;
  }

  async function readCache() {
    await load();
    return state.location ? snapshot(state, now(), 'cache', persisted) : null;
  }

  async function getLocation({ force = false, signal } = {}) {
    await load();
    if (inFlight) return inFlight;

    const cached = state.location ? snapshot(state, now(), 'cache', persisted) : null;
    if (!force && cached?.fresh) return cached;

    inFlight = (async () => {
      const location = await lookup(signal);
      if (!validLocation(location)) throw new Error('Invalid location data received.');

      state = nextState(state, location, now());
      try {
        await storage.set({ [STORAGE_KEY]: state });
        persisted = true;
      } catch {
        persisted = false;
      }

      return snapshot(state, now(), 'network', persisted);
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return { readCache, getLocation };
}
