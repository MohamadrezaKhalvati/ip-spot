import { buildMapUrl, formatCopyDetails, formatLocationLabel, formatPlace, lookupIpLocation } from './location.mjs';
import { createIpSpotService, formatCheckedTime, formatHistoryTime } from './state.mjs';
import { createNetworkService, lookupIpFamilies } from './network.mjs';
import { MONITOR_ENABLED_KEY, setMonitoringEnabled } from './monitor.mjs';

const LOOKUP_TIMEOUT_MS = 8000;
const COPY_FEEDBACK_MS = 1500;
const elements = Object.fromEntries(
  [
    'refresh', 'copy', 'copy-label', 'copy-details', 'copy-details-label', 'status', 'result',
    'ip', 'ip-type', 'last-checked', 'change', 'previous-ip', 'city', 'region-country',
    'map-link', 'isp', 'asn', 'history-count', 'history-list',
    'ipv4', 'ipv6', 'family-status', 'monitor-toggle', 'monitor-status',
  ].map((id) => [id, document.getElementById(id)]),
);

const service = createIpSpotService({
  storage: chrome.storage.local,
  lookup: (signal) => lookupIpLocation(fetch, signal),
});

const networkService = createNetworkService({
  storage: chrome.storage.local,
  lookup: () => lookupIpFamilies(fetch, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)),
});

let currentSnapshot = null;
let currentFamilies = null;
const feedbackTimers = new Map();

function showStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
  elements.status.hidden = false;
}

function displayHistory(history) {
  const fragment = document.createDocumentFragment();
  for (const entry of history) {
    const item = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'history-heading';

    const ip = document.createElement('span');
    ip.className = 'history-ip';
    ip.textContent = entry.ip;

    const checked = document.createElement('time');
    checked.className = 'history-time';
    checked.dateTime = new Date(entry.checkedAt).toISOString();
    checked.textContent = formatHistoryTime(entry.checkedAt);
    heading.append(ip, checked);

    const locationRow = document.createElement('div');
    locationRow.className = 'history-location-row';
    const place = document.createElement('span');
    place.className = 'history-location';
    place.textContent = formatLocationLabel(entry);
    locationRow.append(place);

    const mapUrl = buildMapUrl(entry.coordinates);
    if (mapUrl) {
      const map = document.createElement('a');
      map.className = 'history-map';
      map.href = mapUrl;
      map.target = '_blank';
      map.rel = 'noopener noreferrer';
      map.textContent = 'Map';
      map.setAttribute('aria-label', `Open map for ${entry.ip}`);
      locationRow.append(map);
    }

    item.append(heading, locationRow);
    fragment.append(item);
  }
  elements['history-list'].replaceChildren(fragment);
  elements['history-count'].textContent = `(${history.length})`;
}

function displayLocation(snapshot) {
  currentSnapshot = snapshot;
  const { location } = snapshot;
  elements.ip.textContent = location.ip;
  elements['ip-type'].textContent = location.type;
  elements['last-checked'].textContent = `Checked ${formatCheckedTime(snapshot.checkedAt)}${snapshot.source === 'cache' ? ' · cached' : ''}`;

  elements.change.hidden = !snapshot.changedFromIp;
  elements['previous-ip'].textContent = snapshot.changedFromIp ?? '';

  const place = formatPlace(location);
  elements.city.textContent = place.title;
  elements['region-country'].textContent = place.detail;
  elements.isp.textContent = location.isp;
  elements.asn.textContent = location.asn;

  const mapUrl = buildMapUrl(location.coordinates);
  elements['map-link'].hidden = !mapUrl;
  if (mapUrl) {
    elements['map-link'].href = mapUrl;
  } else {
    elements['map-link'].removeAttribute('href');
  }

  elements['copy-label'].textContent = 'Copy';
  elements['copy-details-label'].textContent = 'Copy all details';
  displayHistory(snapshot.history);
  elements.result.hidden = false;
  elements.status.hidden = true;
}

function displayFamilies(snapshot) {
  currentFamilies = snapshot;
  elements.ipv4.textContent = snapshot.ipv4 ?? 'Not detected';
  elements.ipv6.textContent = snapshot.ipv6 ?? 'Not detected';
  elements['family-status'].textContent = snapshot.fresh ? 'Updated' : 'Previous check';
}

async function refreshFamilies(force = false) {
  elements['family-status'].textContent = 'Checking…';
  try {
    displayFamilies(await networkService.get({ force }));
  } catch {
    const last = await networkService.readCache();
    if (last) {
      displayFamilies(last);
      elements['family-status'].textContent = 'Offline · cached';
    } else {
      elements.ipv4.textContent = 'Check failed';
      elements.ipv6.textContent = 'Check failed';
      elements['family-status'].textContent = 'Retry';
    }
  }
}

async function refreshLocation(force = false) {
  if (elements.refresh.disabled) return;
  elements.refresh.disabled = true;
  showStatus(currentSnapshot ? 'Checking for IP changes…' : 'Finding your public IP…');

  try {
    const snapshot = await service.getLocation({ force, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    displayLocation(snapshot);
    if (!snapshot.persisted) showStatus('Unable to save IP history on this device.', true);
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'Request timed out. Try refreshing.'
      : error instanceof Error ? error.message : 'Unable to find your IP location.';
    showStatus(currentSnapshot ? `${message} Showing last known result.` : message, true);
  } finally {
    elements.refresh.disabled = false;
  }
}

async function copyText(text, labelId, defaultLabel) {
  const timer = feedbackTimers.get(labelId);
  if (timer !== undefined) clearTimeout(timer);

  try {
    await navigator.clipboard.writeText(text);
    elements[labelId].textContent = 'Copied';
    feedbackTimers.set(labelId, setTimeout(() => {
      elements[labelId].textContent = defaultLabel;
      feedbackTimers.delete(labelId);
    }, COPY_FEEDBACK_MS));
  } catch {
    showStatus('Clipboard unavailable. Check browser permissions.', true);
  }
}

async function initializeFamilies() {
  const cached = await networkService.readCache();
  if (cached) displayFamilies(cached);
  if (!cached?.fresh) await refreshFamilies();
}

async function initializeMonitoring() {
  try {
    const saved = (await chrome.storage.local.get(MONITOR_ENABLED_KEY))?.[MONITOR_ENABLED_KEY] === true;
    const permission = await chrome.permissions.contains({ permissions: ['notifications'] });
    elements['monitor-toggle'].checked = saved && permission;
  } catch {
    elements['monitor-toggle'].checked = false;
  }
}

function showMonitorStatus(message, isError = false) {
  elements['monitor-status'].textContent = message;
  elements['monitor-status'].classList.toggle('error', isError);
  elements['monitor-status'].hidden = !message;
}

async function changeMonitoring(enabled, permissionPromise) {
  elements['monitor-toggle'].disabled = true;
  showMonitorStatus('');
  try {
    if (enabled && !await permissionPromise) {
      elements['monitor-toggle'].checked = false;
      showMonitorStatus('Notifications permission was not granted.', true);
      return;
    }
    await setMonitoringEnabled({ storage: chrome.storage.local, alarms: chrome.alarms }, enabled);
    elements['monitor-toggle'].checked = enabled;
    showMonitorStatus(enabled ? 'Monitoring is on. The first check establishes a baseline.' : 'Monitoring is off.');
  } catch {
    elements['monitor-toggle'].checked = !enabled;
    showMonitorStatus('Unable to update notification settings.', true);
  } finally {
    elements['monitor-toggle'].disabled = false;
  }
}

async function initialize() {
  const cached = await service.readCache();
  if (cached) displayLocation(cached);
  if (!cached?.fresh) {
    await refreshLocation();
  } else if (!cached.persisted) {
    showStatus('Unable to read saved IP history.', true);
  }
}

elements.refresh.addEventListener('click', () => {
  void refreshLocation(true);
  void refreshFamilies(true);
});
elements['monitor-toggle'].addEventListener('change', (event) => {
  const enabled = event.target.checked;
  const permission = enabled
    ? chrome.permissions.request({ permissions: ['notifications'] })
    : Promise.resolve(true);
  void changeMonitoring(enabled, permission);
});
elements.copy.addEventListener('click', () => {
  if (currentSnapshot) void copyText(currentSnapshot.location.ip, 'copy-label', 'Copy');
});
elements['copy-details'].addEventListener('click', () => {
  if (currentSnapshot) {
    void copyText(formatCopyDetails(currentSnapshot.location, currentSnapshot.checkedAt) + (currentFamilies ? `\nIPv4: ${currentFamilies.ipv4 ?? 'Not detected'}\nIPv6: ${currentFamilies.ipv6 ?? 'Not detected'}` : ''), 'copy-details-label', 'Copy all details');
  }
});
void Promise.all([initialize(), initializeFamilies(), initializeMonitoring()]);
