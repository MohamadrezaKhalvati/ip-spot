import assert from 'node:assert/strict';
import test from 'node:test';
import { CACHE_TTL_MS, HISTORY_LIMIT, createIpSpotService, formatCheckedTime } from './state.mjs';

const location = (ip, extra = {}) => ({
  ip,
  type: 'IPv4',
  city: 'London',
  region: 'England',
  country: 'United Kingdom',
  isp: 'Example ISP',
  asn: 'AS64500',
  timezone: 'Europe/London',
  coordinates: { latitude: 51.5, longitude: -0.12 },
  ...extra,
});

function memoryStorage(initialValue) {
  const data = initialValue ? { ipSpotStateV1: initialValue } : {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(update) { Object.assign(data, update); },
  };
}

test('first successful lookup persists a timestamp and initial history record', async () => {
  const storage = memoryStorage();
  const service = createIpSpotService({ storage, lookup: async () => location('203.0.113.10'), now: () => 1_000_000 });

  assert.equal(await service.readCache(), null);
  const snapshot = await service.getLocation();
  assert.equal(snapshot.source, 'network');
  assert.equal(snapshot.checkedAt, 1_000_000);
  assert.equal(snapshot.changedFromIp, null);
  assert.deepEqual(snapshot.history.map((entry) => entry.ip), ['203.0.113.10']);
  assert.equal(storage.data.ipSpotStateV1.location.ip, '203.0.113.10');
});

test('uses fresh cache on opening, but manual refresh always bypasses it', async () => {
  let now = 1_000_000;
  let requests = 0;
  const storage = memoryStorage();
  const lookup = async () => { requests++; return location('203.0.113.10'); };
  const service = createIpSpotService({ storage, lookup, now: () => now });
  await service.getLocation();
  now += 5000;
  assert.equal((await service.getLocation()).source, 'cache');
  assert.equal(requests, 1);
  assert.equal((await service.getLocation({ force: true })).source, 'network');
  assert.equal(requests, 2);
  assert.equal((await service.readCache()).fresh, true);
});

test('expires cache at TTL and a successful unchanged IP clears the change indicator', async () => {
  let now = 1_000_000;
  let ip = '203.0.113.10';
  let requests = 0;
  const service = createIpSpotService({
    storage: memoryStorage(),
    lookup: async () => { requests++; return location(ip); },
    now: () => now,
  });
  await service.getLocation();
  ip = '203.0.113.11';
  now += CACHE_TTL_MS;
  assert.equal((await service.getLocation()).changedFromIp, '203.0.113.10');
  now += CACHE_TTL_MS;
  const unchanged = await service.getLocation();
  assert.equal(unchanged.changedFromIp, null);
  assert.deepEqual(unchanged.history.map((entry) => entry.ip), ['203.0.113.11', '203.0.113.10']);
  assert.equal(requests, 3);
});

test('keeps five most recently observed distinct addresses and reorders previously seen IPs', async () => {
  let now = 1_000_000;
  let ip = '203.0.113.1';
  const storage = memoryStorage();
  const service = createIpSpotService({ storage, lookup: async () => location(ip), now: () => now });
  for (let index = 1; index <= HISTORY_LIMIT + 1; index++) {
    ip = `203.0.113.${index}`;
    await service.getLocation({ force: true });
    now += 1000;
  }
  ip = '203.0.113.4';
  const snapshot = await service.getLocation({ force: true });
  assert.deepEqual(snapshot.history.map((entry) => entry.ip), ['203.0.113.4', '203.0.113.6', '203.0.113.5', '203.0.113.3', '203.0.113.2']);
  assert.equal(snapshot.changedFromIp, '203.0.113.6');
  assert.equal(snapshot.history.length, HISTORY_LIMIT);
});

test('reload preserves cached location, IP change and history across popup instances', async () => {
  const storage = memoryStorage();
  let ip = '203.0.113.10';
  const dependencies = { storage, lookup: async () => location(ip), now: () => 1_000_000 };
  const first = createIpSpotService(dependencies);
  await first.getLocation();
  ip = '203.0.113.11';
  await first.getLocation({ force: true });
  const second = createIpSpotService(dependencies);
  const cached = await second.getLocation();
  assert.equal(cached.source, 'cache');
  assert.equal(cached.changedFromIp, '203.0.113.10');
  assert.equal(cached.history.length, 2);
});

test('ignores corrupted persistent state safely', async () => {
  const storage = memoryStorage({ schema: 1, checkedAt: -123, location: { ip: '' }, history: 'bad' });
  const service = createIpSpotService({ storage, lookup: async () => location('203.0.113.7'), now: () => 1_000_000 });
  assert.equal(await service.readCache(), null);
  assert.deepEqual((await service.getLocation()).history.map((entry) => entry.ip), ['203.0.113.7']);
});

test('an upstream lookup failure leaves saved location and timestamp untouched', async () => {
  const storage = memoryStorage();
  let fail = false;
  const service = createIpSpotService({
    storage,
    lookup: async () => { if (fail) throw new Error('Offline'); return location('203.0.113.10'); },
    now: () => 1_000_000,
  });
  const snapshot = await service.getLocation();
  fail = true;
  await assert.rejects(service.getLocation({ force: true }), /Offline/);
  assert.deepEqual(await service.readCache(), { ...snapshot, source: 'cache' });
});

test('storage read and write failures do not prevent showing a live result', async () => {
  const storage = {
    async get() { throw new Error('Storage unavailable'); },
    async set() { throw new Error('Storage unavailable'); },
  };
  const service = createIpSpotService({ storage, lookup: async () => location('203.0.113.10'), now: () => 1_000_000 });
  const result = await service.getLocation();
  assert.equal(result.location.ip, '203.0.113.10');
  assert.equal(result.persisted, false);
  assert.equal((await service.getLocation()).source, 'cache');
});

test('coalesces concurrent network lookups to prevent duplicate API calls', async () => {
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createIpSpotService({
    storage: memoryStorage(),
    lookup: async () => { requests++; await gate; return location('203.0.113.10'); },
    now: () => 1_000_000,
  });
  const a = service.getLocation({ force: true });
  const b = service.getLocation({ force: true });
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(requests, 1);
  assert.deepEqual(first, second);
});

test('a timestamp in the future is never treated as fresh cache', async () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  let requests = 0;
  const service = createIpSpotService({ storage, lookup: async () => { requests++; return location('203.0.113.10'); }, now: () => now });
  await service.getLocation();
  now -= 10_000;
  assert.equal((await service.readCache()).fresh, false);
  await service.getLocation();
  assert.equal(requests, 2);
});

test('formats last-checked value without misrepresenting missing dates', () => {
  assert.equal(formatCheckedTime(-1), 'Unknown');
  assert.match(formatCheckedTime(1_000_000), /\d/);
});


test('history saves the full approximate location and map coordinates for each observed IP', async () => {
  let current = location('203.0.113.10', {
    city: 'London', region: 'England', country: 'United Kingdom',
    coordinates: { latitude: 51.5, longitude: -0.12 },
  });
  const storage = memoryStorage();
  const service = createIpSpotService({ storage, lookup: async () => current, now: () => 1_000_000 });
  await service.getLocation();
  current = location('203.0.113.11', {
    city: 'Washington', region: 'District of Columbia', country: 'United States',
    coordinates: { latitude: 38.8951, longitude: -77.0364 },
  });
  const result = await service.getLocation({ force: true });
  assert.deepEqual(result.history, [
    { ip: '203.0.113.11', city: 'Washington', region: 'District of Columbia', country: 'United States', coordinates: { latitude: 38.8951, longitude: -77.0364 }, checkedAt: 1_000_000 },
    { ip: '203.0.113.10', city: 'London', region: 'England', country: 'United Kingdom', coordinates: { latitude: 51.5, longitude: -0.12 }, checkedAt: 1_000_000 },
  ]);
  const reloaded = createIpSpotService({ storage, lookup: async () => { throw new Error('Should not fetch'); }, now: () => 1_000_000 });
  assert.deepEqual((await reloaded.readCache()).history, result.history);
});

test('v2.1 history entries remain readable when region and coordinates were not stored', async () => {
  const storage = memoryStorage({
    schema: 1, location: location('203.0.113.11'), checkedAt: 1_000_000, changedFromIp: null,
    history: [{ ip: '203.0.113.10', city: 'London', country: 'United Kingdom', checkedAt: 900_000 }],
  });
  const service = createIpSpotService({ storage, lookup: async () => { throw new Error('Unexpected fetch'); }, now: () => 1_000_000 });
  assert.deepEqual((await service.readCache()).history, [
    { ip: '203.0.113.10', city: 'London', region: 'Unknown', country: 'United Kingdom', coordinates: null, checkedAt: 900_000 },
  ]);
});

test('invalid historical coordinates are discarded and repeated IP observations refresh its location', async () => {
  let now = 1_000_000;
  let current = location('203.0.113.11', {
    city: 'London', coordinates: { latitude: 120, longitude: 10 },
  });
  const service = createIpSpotService({ storage: memoryStorage(), lookup: async () => current, now: () => now });
  assert.equal((await service.getLocation()).history[0].coordinates, null);
  current = location('203.0.113.22');
  now += 1000;
  await service.getLocation({ force: true });
  current = location('203.0.113.11', {
    city: 'Paris', region: 'Île-de-France', country: 'France',
    coordinates: { latitude: 48.8566, longitude: 2.3522 },
  });
  now += 1000;
  const result = await service.getLocation({ force: true });
  assert.deepEqual(result.history.map((entry) => entry.ip), ['203.0.113.11', '203.0.113.22']);
  assert.equal(result.history[0].city, 'Paris');
  assert.equal(result.history[0].region, 'Île-de-France');
  assert.deepEqual(result.history[0].coordinates, { latitude: 48.8566, longitude: 2.3522 });
  assert.equal(result.history[0].checkedAt, now);
});


test('invalid out-of-range historical dates are ignored safely', async () => {
  const storage = memoryStorage({
    schema: 1, location: location('203.0.113.12'), checkedAt: 1_000_000,
    history: [{ ip: '203.0.113.10', city: 'London', country: 'United Kingdom', checkedAt: 8_640_000_000_000_001 }],
  });
  const service = createIpSpotService({ storage, lookup: async () => location('203.0.113.12'), now: () => 1_000_000 });
  assert.deepEqual((await service.readCache()).history, []);
});

test('history timestamps include the calendar date, not just time of day', async () => {
  const { formatHistoryTime } = await import('./state.mjs');
  const timestamp = Date.UTC(2026, 10, 15, 10, 0);
  assert.equal(formatHistoryTime(timestamp), new Date(timestamp).toLocaleString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  assert.equal(formatHistoryTime(-1), 'Unknown');
});
