import { lookupIpFamilies } from './network.mjs';
import {
  checkForChanges,
  MONITOR_ALARM_NAME,
  MONITOR_ENABLED_KEY,
  syncMonitoringAlarm,
} from './monitor.mjs';

const settings = { storage: chrome.storage.local, alarms: chrome.alarms };
const NETWORK_TIMEOUT_MS = 8000;
let checking = null;

async function checkNetwork() {
  if (checking) return checking;
  checking = checkForChanges({
    storage: chrome.storage.local,
    lookup: () => lookupIpFamilies(fetch, AbortSignal.timeout(NETWORK_TIMEOUT_MS)),
    notify: async (message) => {
      if (!await chrome.permissions.contains({ permissions: ['notifications'] })) return false;
      if (await chrome.notifications.getPermissionLevel() !== 'granted') return false;
      await chrome.notifications.create('ip-spot-ip-change', {
        type: 'basic',
        title: 'IP Spot: public IP changed',
        message,
        iconUrl: 'icons/icon128.png',
      });
      return true;
    },
  });
  try { await checking; } finally { checking = null; }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncMonitoringAlarm(settings);
});
chrome.runtime.onStartup.addListener(() => {
  void syncMonitoringAlarm(settings);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_ALARM_NAME) void checkNetwork().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !Object.hasOwn(changes, MONITOR_ENABLED_KEY)) return;
  void syncMonitoringAlarm(settings).then(() => {
    if (changes[MONITOR_ENABLED_KEY].newValue === true) return checkNetwork();
    return undefined;
  }).catch(() => {});
});
chrome.permissions.onRemoved.addListener(({ permissions }) => {
  if (permissions?.includes('notifications')) {
    void chrome.storage.local.set({ [MONITOR_ENABLED_KEY]: false });
  }
});

void syncMonitoringAlarm(settings).catch(() => {});
