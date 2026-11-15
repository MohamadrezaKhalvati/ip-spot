import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidIpAddress, lookupIpFamilies, createNetworkService, NETWORK_CACHE_TTL_MS } from './network.mjs';

const fakeStorage = () => {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); },
  };
};

const reply = (ip, status = 200) => ({ ok: status === 200, status, async json() { return { ip }; } });

test('validates public address syntax for both families', () => {
  assert.equal(isValidIpAddress('203.0.113.9', 4), true);
  assert.equal(isValidIpAddress('2001:db8::1', 6), true);
  for (const ip of ['256.1.1.1', '1.1.1', '1.1.1.001', 'example.com', '::1']) {
    assert.equal(isValidIpAddress(ip, 4), false);
  }
  for (const ip of ['2001:::1', '203.0.113.9', 'bad:ip']) {
    assert.equal(isValidIpAddress(ip, 6), false);
  }
});

test('queries separate IPv4-only and IPv6-only endpoints in parallel', async () => {
  const urls = [];
  const result = await lookupIpFamilies(async (url) => {
    urls.push(url);
    return reply(url.includes('api6') ? '2001:db8::10' : '203.0.113.10');
  });
  assert.deepEqual(result, { ipv4: '203.0.113.10', ipv6: '2001:db8::10' });
  assert.deepEqual(urls.sort(), ['https://api.ipify.org?format=json', 'https://api6.ipify.org?format=json']);
});

test('degrades safely when IPv6 endpoint is unreachable', async () => {
  const result = await lookupIpFamilies(async (url) => {
    if (url.includes('api6')) throw Error('No IPv6 route');
    return reply('203.0.113.11');
  });
  assert.deepEqual(result, { ipv4: '203.0.113.11', ipv6: null });
});

test('rejects mismatched family responses and both failed requests', async () => {
  const result = await lookupIpFamilies(async (url) => reply(url.includes('api6') ? '203.0.113.2' : '203.0.113.1'));
  assert.deepEqual(result, { ipv4: '203.0.113.1', ipv6: null });
  await assert.rejects(() => lookupIpFamilies(async () => { throw Error('network error'); }), /IP version check failed/);
});

test('network service caches successful checks and respects manual refresh', async () => {
  const storage = fakeStorage();
  let time = 1000;
  let calls = 0;
  const service = createNetworkService({ storage, now: () => time, lookup: async () => { calls++; return { ipv4: `203.0.113.${calls}`, ipv6: null }; } });
  const first = await service.get();
  assert.equal(first.ipv4, '203.0.113.1');
  assert.equal((await service.get()).ipv4, '203.0.113.1');
  assert.equal(calls, 1);
  assert.equal((await service.get({ force: true })).ipv4, '203.0.113.2');
  time += NETWORK_CACHE_TTL_MS;
  assert.equal((await service.get()).ipv4, '203.0.113.3');
  assert.equal(calls, 3);
});

test('network service does not destroy cached addresses on lookup failure', async () => {
  const storage = fakeStorage();
  let fail = false;
  const service = createNetworkService({ storage, lookup: async () => {
    if (fail) throw Error('offline');
    return { ipv4: '203.0.113.4', ipv6: '2001:db8::4' };
  } });
  await service.get();
  fail = true;
  await assert.rejects(() => service.get({force:true}), /offline/);
  assert.equal((await service.readCache()).ipv6, '2001:db8::4');
});

test('network service handles old or corrupt storage and concurrent checks', async () => {
  const storage = fakeStorage();
  storage.data.ipSpotNetworkV1 = { ip4:'unexpected' };
  let calls = 0;
  const service = createNetworkService({ storage, lookup: async () => {
    calls++;
    return { ipv4: '203.0.113.8', ipv6: null };
  } });
  const [a, b] = await Promise.all([service.get(), service.get()]);
  assert.deepEqual([a.ipv4, b.ipv4], ['203.0.113.8', '203.0.113.8']);
  assert.equal(calls, 1);
});
