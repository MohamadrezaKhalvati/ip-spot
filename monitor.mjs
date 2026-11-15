import { isValidIpAddress } from './network.mjs';

export const MONITOR_ENABLED_KEY = 'ipSpotMonitoringEnabled';
export const MONITOR_ALARM_NAME = 'ip-spot-ip-check';
export const MONITOR_INTERVAL_MINUTES = 30;
const BASELINE_KEY = 'ipSpotMonitoringBaselineV1';
const PENDING_KEY = 'ipSpotMonitoringPendingV1';

function validBaseline(value) {
  return value && typeof value === 'object' &&
    (value.ipv4 === null || isValidIpAddress(value.ipv4, 4)) &&
    (value.ipv6 === null || isValidIpAddress(value.ipv6, 6)) &&
    (isValidIpAddress(value.ipv4, 4) || isValidIpAddress(value.ipv6, 6));
}

export async function syncMonitoringAlarm({ storage, alarms }) {
  const enabled = (await storage.get(MONITOR_ENABLED_KEY))?.[MONITOR_ENABLED_KEY] === true;
  const current = await alarms.get(MONITOR_ALARM_NAME);
  if (enabled && (!current || current.periodInMinutes !== MONITOR_INTERVAL_MINUTES)) {
    await alarms.create(MONITOR_ALARM_NAME, { periodInMinutes: MONITOR_INTERVAL_MINUTES });
  } else if (!enabled && current) {
    await alarms.clear(MONITOR_ALARM_NAME);
  }
}

export async function setMonitoringEnabled({ storage, alarms }, enabled) {
  if (enabled !== true) {
    await storage.set({ [MONITOR_ENABLED_KEY]: false });
    await alarms.clear(MONITOR_ALARM_NAME);
    await storage.remove(BASELINE_KEY);
    await storage.remove(PENDING_KEY);
    return;
  }
  await storage.remove(BASELINE_KEY);
  await storage.remove(PENDING_KEY);
  await storage.set({ [MONITOR_ENABLED_KEY]: true });
  await syncMonitoringAlarm({ storage, alarms });
}

export async function checkForChanges({ storage, lookup, notify }) {
  const enabled = (await storage.get(MONITOR_ENABLED_KEY))?.[MONITOR_ENABLED_KEY] === true;
  if (!enabled) return;
  const previous = (await storage.get(BASELINE_KEY))?.[BASELINE_KEY];
  const pending = (await storage.get(PENDING_KEY))?.[PENDING_KEY];
  const next = await lookup();
  if (!validBaseline(next)) throw new Error('Invalid monitoring response');

  const baseline = validBaseline(previous) ? previous : null;
  const changes = [];
  for (const [key, label, family] of [['ipv4', 'IPv4', 4], ['ipv6', 'IPv6', 6]]) {
    if (baseline && isValidIpAddress(baseline[key], family) && isValidIpAddress(next[key], family) && baseline[key] !== next[key]) {
      changes.push(`${label}: ${next[key]}`);
    }
  }

  const updated = {
    ipv4: next.ipv4 ?? baseline?.ipv4 ?? null,
    ipv6: next.ipv6 ?? baseline?.ipv6 ?? null,
  };
  if ((await storage.get(MONITOR_ENABLED_KEY))?.[MONITOR_ENABLED_KEY] !== true) return;
  const message = changes.length ? changes.join(' · ') :
    typeof pending === 'string' && pending.length > 0 ? pending : null;
  await storage.set({
    [BASELINE_KEY]: updated,
    ...(message ? { [PENDING_KEY]: message } : {}),
  });
  if (!message) return;
  if ((await storage.get(MONITOR_ENABLED_KEY))?.[MONITOR_ENABLED_KEY] !== true) return;
  const delivered = await notify(message);
  if (delivered !== false) await storage.remove(PENDING_KEY);
}
