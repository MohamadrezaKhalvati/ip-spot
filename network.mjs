export const NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;
const NETWORK_KEY = 'ipSpotNetworkV1';
const IPV4_URL = 'https://api.ipify.org?format=json';
const IPV6_URL = 'https://api6.ipify.org?format=json';

export function isValidIpAddress(value, family) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (family === 4) {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
    return value.split('.').every((part) => Number(part) <= 255);
  }
  if (family === 6) {
    if (!value.includes(':') || !/^[\da-fA-F:.]+$/.test(value)) return false;
    try {
      const url = new URL(`http://[${value}]/`);
      return url.hostname.startsWith('[') && url.hostname.endsWith(']');
    } catch {
      return false;
    }
  }
  return false;
}

async function queryAddress(fetchImpl, url, family, signal) {
  const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`IPv${family} lookup failed`);
  const payload = await response.json();
  if (!isValidIpAddress(payload?.ip, family)) throw new Error(`Invalid IPv${family} address returned`);
  return payload.ip;
}

export async function lookupIpFamilies(fetchImpl = fetch, signal) {
  const [v4, v6] = await Promise.allSettled([
    queryAddress(fetchImpl, IPV4_URL, 4, signal),
    queryAddress(fetchImpl, IPV6_URL, 6, signal),
  ]);
  if (v4.status === 'rejected' && v6.status === 'rejected') {
    throw new Error('IP version check failed. Retry when connected.');
  }
  return {
    ipv4: v4.status === 'fulfilled' ? v4.value : null,
    ipv6: v6.status === 'fulfilled' ? v6.value : null,
  };
}

function isValidState(value) {
  return value && value.schema === 1 &&
    Number.isSafeInteger(value.checkedAt) && value.checkedAt > 0 &&
    (value.ipv4 === null || isValidIpAddress(value.ipv4, 4)) &&
    (value.ipv6 === null || isValidIpAddress(value.ipv6, 6)) &&
    (value.ipv4 !== null || value.ipv6 !== null);
}

export function createNetworkService({ storage, lookup, now = Date.now }) {
  let state = null;
  let initialized = null;
  let inFlight = null;

  async function load() {
    if (!initialized) {
      initialized = (async () => {
        try {
          const candidate = (await storage.get(NETWORK_KEY))?.[NETWORK_KEY];
          state = isValidState(candidate) ? candidate : null;
        } catch {
          state = null;
        }
      })();
    }
    await initialized;
  }

  function snapshot() {
    if (!state) return null;
    const age = now() - state.checkedAt;
    return { ipv4: state.ipv4, ipv6: state.ipv6, checkedAt: state.checkedAt,
      fresh: age >= 0 && age < NETWORK_CACHE_TTL_MS };
  }

  async function readCache() {
    await load();
    return snapshot();
  }

  async function get({ force = false } = {}) {
    await load();
    if (inFlight) return inFlight;
    const cached = snapshot();
    if (cached?.fresh && !force) return cached;

    inFlight = (async () => {
      const next = await lookup();
      if (!next || (next.ipv4 !== null && !isValidIpAddress(next.ipv4, 4)) ||
          (next.ipv6 !== null && !isValidIpAddress(next.ipv6, 6)) ||
          (next.ipv4 === null && next.ipv6 === null)) {
        throw new Error('Invalid IP version data received.');
      }
      state = { schema: 1, checkedAt: now(), ipv4: next.ipv4, ipv6: next.ipv6 };
      try { await storage.set({ [NETWORK_KEY]: state }); } catch { /* Continue with in-memory state */ }
      return snapshot();
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }

  return { readCache, get };
}
