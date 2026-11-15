import test from 'node:test';
import assert from 'node:assert/strict';
import { MONITOR_ALARM_NAME, MONITOR_ENABLED_KEY } from './monitor.mjs';

let importIndex = 0;

function createChromeHarness({ enabled = true } = {}) {
  const data = { [MONITOR_ENABLED_KEY]: enabled };
  const scheduled = new Map();
  const listeners = new Map();
  const notifications = [];
  let ipv4 = '203.0.113.10';
  let ipv6 = '2001:db8::10';
  let notificationGranted = true;
  let requests = 0;

  function event(name) {
    return { addListener(listener) { listeners.set(name, listener); } };
  }

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: data[key] }; },
        async set(values) { Object.assign(data, values); },
        async remove(key) { delete data[key]; },
      },
      onChanged: event('storage'),
    },
    alarms: {
      async get(name) { return scheduled.get(name); },
      async create(name, options) { scheduled.set(name, options); },
      async clear(name) { return scheduled.delete(name); },
      onAlarm: event('alarm'),
    },
    runtime: { onInstalled: event('installed'), onStartup: event('startup') },
    permissions: {
      async contains() { return notificationGranted; },
      onRemoved: event('permission-removed'),
    },
    notifications: {
      async getPermissionLevel() { return notificationGranted ? 'granted' : 'denied'; },
      async create(id, options) { notifications.push({ id, options }); return id; },
    },
  };
  globalThis.fetch = async (url) => {
    requests++;
    return { ok: true, async json() { return { ip: url.includes('api6') ? ipv6 : ipv4 }; } };
  };

  return {
    data, scheduled, notifications, listeners,
    setAddresses(next4, next6) { ipv4 = next4; ipv6 = next6; },
    setNotificationPermission(allowed) { notificationGranted = allowed; },
    get requests() { return requests; },
    async start() {
      await import(`./background.js?integration-test=${++importIndex}`);
      await new Promise(setImmediate);
    },
    async signal(name, ...args) {
      assert.ok(listeners.has(name), `Missing listener: ${name}`);
      listeners.get(name)(...args);
      await new Promise(setImmediate);
    },
  };
}

test('service worker startup recreates a missing alarm even without onStartup firing', async () => {
  const browser = createChromeHarness();
  await browser.start();
  assert.equal(browser.scheduled.get(MONITOR_ALARM_NAME)?.periodInMinutes, 30);
});

test('notification delivery retries after OS permission is temporarily denied', async () => {
  const browser = createChromeHarness();
  await browser.start();
  await browser.signal('alarm', { name: MONITOR_ALARM_NAME });
  assert.equal(browser.notifications.length, 0);
  browser.setAddresses('203.0.113.11', '2001:db8::11');
  browser.setNotificationPermission(false);
  await browser.signal('alarm', { name: MONITOR_ALARM_NAME });
  assert.equal(browser.notifications.length, 0);
  browser.setNotificationPermission(true);
  await browser.signal('alarm', { name: MONITOR_ALARM_NAME });
  assert.equal(browser.notifications.length, 1);
  await browser.signal('alarm', { name: MONITOR_ALARM_NAME });
  assert.equal(browser.notifications.length, 1);
});

test('background alarms do not perform any network calls when monitoring is off', async () => {
  const browser = createChromeHarness({ enabled: false });
  await browser.start();
  await browser.signal('alarm', { name: MONITOR_ALARM_NAME });
  assert.equal(browser.requests, 0);
  assert.equal(browser.notifications.length, 0);
  assert.equal(browser.scheduled.size, 0);
});
