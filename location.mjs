const API_URL = 'https://ipwho.is/';
const UNKNOWN = 'Unknown';

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : UNKNOWN;
}

export function validCoordinates(latitude, longitude) {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function formatAsn(value) {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = /^(?:AS)?(\d{1,10})$/i.exec(candidate);
  if (!match) return UNKNOWN;

  const number = Number(match[1]);
  return number > 0 && number <= 4294967295 ? `AS${number}` : UNKNOWN;
}

export async function lookupIpLocation(fetchImpl = fetch, signal) {
  const response = await fetchImpl(API_URL, {
    method: 'GET',
    cache: 'no-store',
    signal,
  });

  if (response.status === 429) {
    throw new Error('Location service rate limit reached. Try again later.');
  }

  if (!response.ok) {
    throw new Error('Location service unavailable. Please retry.');
  }

  const data = await response.json();

  if (data?.success === false) {
    throw new Error(optionalText(data.message) === UNKNOWN ? 'IP lookup failed.' : data.message);
  }

  if (typeof data?.ip !== 'string' || !data.ip.trim()) {
    throw new Error('Invalid location data received.');
  }

  const coordinates = validCoordinates(data.latitude, data.longitude)
    ? { latitude: data.latitude, longitude: data.longitude }
    : null;

  return {
    ip: data.ip.trim(),
    type: optionalText(data.type),
    city: optionalText(data.city),
    region: optionalText(data.region),
    country: optionalText(data.country),
    isp: optionalText(data.connection?.isp ?? data.connection?.org),
    asn: formatAsn(data.connection?.asn),
    timezone: optionalText(data.timezone?.id),
    coordinates,
  };
}

export function formatPlace({ city, region, country }) {
  const parts = [city, region, country]
    .filter((value) => typeof value === 'string' && value.trim() && value !== UNKNOWN);

  if (parts.length === 0) {
    return { title: 'Location unavailable', detail: 'IP-based estimate' };
  }

  return {
    title: parts[0],
    detail: parts.slice(1).join(', '),
  };
}

export function formatLocationLabel({ city, region, country }) {
  const parts = [city, region, country]
    .filter((value) => typeof value === 'string' && value.trim() && value !== UNKNOWN);
  return parts.join(', ') || 'Location unavailable';
}

export function buildMapUrl(coordinates) {
  if (!coordinates || !validCoordinates(coordinates.latitude, coordinates.longitude)) {
    return null;
  }

  const { latitude, longitude } = coordinates;
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=10/${latitude}/${longitude}`;
}

export function formatCopyDetails(location, checkedAt) {
  const parts = [location.city, location.region, location.country]
    .filter((value) => typeof value === 'string' && value.trim() && value !== UNKNOWN);
  const coordinates = location.coordinates && validCoordinates(location.coordinates.latitude, location.coordinates.longitude)
    ? `${location.coordinates.latitude}, ${location.coordinates.longitude}` : UNKNOWN;
  const checked = Number.isSafeInteger(checkedAt) && checkedAt > 0
    ? new Date(checkedAt).toISOString() : UNKNOWN;

  return [
    `IP: ${location.ip}`,
    `Type: ${location.type}`,
    `Location: ${parts.join(', ') || UNKNOWN}`,
    `ISP: ${location.isp}`,
    `ASN: ${location.asn}`,
    `Timezone: ${location.timezone}`,
    `Coordinates: ${coordinates}`,
    `Checked: ${checked}`,
  ].join('\n');
}
