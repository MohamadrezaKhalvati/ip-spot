import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupIpLocation, formatPlace, buildMapUrl } from './location.mjs';

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('returns the public IP, approximate location, and network details', async () => {
  const result = await lookupIpLocation(async () => response({
    success: true,
    ip: '203.0.113.42',
    type: 'IPv4',
    city: 'London',
    region: 'England',
    country: 'United Kingdom',
    latitude: 51.5074,
    longitude: -0.1278,
    connection: { isp: 'Example ISP' },
    timezone: { id: 'Europe/London' },
  }));

  assert.deepEqual(result, {
    ip: '203.0.113.42',
    type: 'IPv4',
    city: 'London',
    region: 'England',
    country: 'United Kingdom',
    isp: 'Example ISP',
    asn: 'Unknown',
    timezone: 'Europe/London',
    coordinates: { latitude: 51.5074, longitude: -0.1278 },
  });
});

test('handles missing optional fields and missing coordinates safely', async () => {
  const result = await lookupIpLocation(async () => response({ success: true, ip: '2001:db8::1' }));
  assert.equal(result.ip, '2001:db8::1');
  assert.equal(result.type, 'Unknown');
  assert.equal(result.city, 'Unknown');
  assert.equal(result.isp, 'Unknown');
  assert.equal(result.asn, 'Unknown');
  assert.equal(result.timezone, 'Unknown');
  assert.equal(result.coordinates, null);
});

test('rejects invalid geographical coordinates', async () => {
  const result = await lookupIpLocation(async () => response({
    success: true,
    ip: '203.0.113.42',
    latitude: 200,
    longitude: 10,
  }));
  assert.equal(result.coordinates, null);
});

test('rejects application-level lookup failures', async () => {
  await assert.rejects(
    lookupIpLocation(async () => response({ success: false, message: 'Invalid IP address' })),
    /Invalid IP address/,
  );
});

test('explains HTTP rate limiting', async () => {
  await assert.rejects(
    lookupIpLocation(async () => response({}, 429)),
    /limit/i,
  );
});

test('rejects missing IP values', async () => {
  await assert.rejects(
    lookupIpLocation(async () => response({ success: true, ip: '' })),
    /invalid location data/i,
  );
});

test('does not request any unrelated host', async () => {
  let requestedUrl;
  await lookupIpLocation(async (url) => {
    requestedUrl = url;
    return response({ success: true, ip: '203.0.113.42' });
  });
  assert.equal(requestedUrl, 'https://ipwho.is/');
});


test('formats a city and its region and country for a compact popup', () => {
  assert.deepEqual(formatPlace({ city: 'Washington', region: 'District of Columbia', country: 'United States' }), {
    title: 'Washington',
    detail: 'District of Columbia, United States',
  });
});

test('falls back to the available region or country if a city is missing', () => {
  assert.deepEqual(formatPlace({ city: 'Unknown', region: 'Virginia', country: 'United States' }), {
    title: 'Virginia',
    detail: 'United States',
  });
  assert.deepEqual(formatPlace({ city: 'Unknown', region: 'Unknown', country: 'Unknown' }), {
    title: 'Location unavailable',
    detail: 'IP-based estimate',
  });
});

test('generates a map URL only for valid coordinates', () => {
  assert.equal(buildMapUrl({ latitude: 38.8951, longitude: -77.0364 }),
    'https://www.openstreetmap.org/?mlat=38.8951&mlon=-77.0364#map=10/38.8951/-77.0364');
  assert.equal(buildMapUrl({ latitude: 91, longitude: 0 }), null);
  assert.equal(buildMapUrl(null), null);
});

test('rejects non-successful upstream responses', async () => {
  await assert.rejects(lookupIpLocation(async () => response({}, 502)), /unavailable/i);
});

test('normalizes numeric and string ASNs from upstream connection data', async () => {
  const numeric = await lookupIpLocation(async () => response({ success: true, ip: '203.0.113.42', connection: { asn: 16509 } }));
  const string = await lookupIpLocation(async () => response({ success: true, ip: '203.0.113.42', connection: { asn: 'AS64500' } }));
  const invalid = await lookupIpLocation(async () => response({ success: true, ip: '203.0.113.42', connection: { asn: '<script>' } }));
  assert.equal(numeric.asn, 'AS16509');
  assert.equal(string.asn, 'AS64500');
  assert.equal(invalid.asn, 'Unknown');
});

test('copy details contains all relevant network fields and a stable UTC timestamp', async () => {
  const { formatCopyDetails } = await import('./location.mjs');
  const details = formatCopyDetails({
    ip: '203.0.113.42', type: 'IPv4', city: 'London', region: 'England', country: 'United Kingdom',
    isp: 'Example ISP', asn: 'AS64500', timezone: 'Europe/London',
    coordinates: { latitude: 51.5, longitude: -0.12 },
  }, Date.UTC(2026, 10, 15, 10, 0));
  assert.match(details, /IP: 203\.0\.113\.42/);
  assert.match(details, /ISP: Example ISP/);
  assert.match(details, /ASN: AS64500/);
  assert.match(details, /Location: London, England, United Kingdom/);
  assert.match(details, /Coordinates: 51\.5, -0\.12/);
  assert.match(details, /Checked: 2026-11-15T10:00:00\.000Z/);
});

test('HTTP 429 error does not incorrectly claim the daily quota is exhausted', async () => {
  await assert.rejects(lookupIpLocation(async () => response({}, 429)), /rate limit/i);
});


test('formats stored history locations with all available geographic fields', async () => {
  const { formatLocationLabel } = await import('./location.mjs');
  assert.equal(formatLocationLabel({ city: 'Washington', region: 'District of Columbia', country: 'United States' }),
    'Washington, District of Columbia, United States');
  assert.equal(formatLocationLabel({ city: 'London', region: 'Unknown', country: 'United Kingdom' }),
    'London, United Kingdom');
  assert.equal(formatLocationLabel({ city: 'Unknown', region: 'Unknown', country: 'Unknown' }),
    'Location unavailable');
});
