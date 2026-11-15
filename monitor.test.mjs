import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForChanges, setMonitoringEnabled, syncMonitoringAlarm, MONITOR_ALARM_NAME, MONITOR_INTERVAL_MINUTES, MONITOR_ENABLED_KEY } from './monitor.mjs';

function fixture() {
  const data = {};
  const alarms = new Map();
  const storage = {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); },
    async remove(key) { delete data[key]; },
  };
  const scheduler = {
    async get(name) { return alarms.get(name); },
    async create(name, opts) { alarms.set(name, opts); },
    async clear(name) { return alarms.delete(name); },
  };
  return { data, alarms, storage, scheduler };
}

test('monitoring is off by default and does not schedule alarms', async () => {
  const { storage, scheduler, alarms } = fixture();
  await syncMonitoringAlarm({ storage, alarms: scheduler });
  assert.equal(alarms.size, 0);
});

test('opt-in schedules a 30-minute check and opt-out clears it', async () => {
  const { data, storage, scheduler, alarms } = fixture();
  await setMonitoringEnabled({ storage, alarms: scheduler }, true);
  assert.equal(data[MONITOR_ENABLED_KEY], true);
  assert.equal(alarms.get(MONITOR_ALARM_NAME).periodInMinutes, MONITOR_INTERVAL_MINUTES);
  await setMonitoringEnabled({ storage, alarms: scheduler }, false);
  assert.equal(data[MONITOR_ENABLED_KEY], false);
  assert.equal(alarms.size, 0);
});

test('first successful check establishes baseline without notifying', async () => {
  const { storage, scheduler } = fixture();
  await setMonitoringEnabled({ storage, alarms: scheduler }, true);
  const messages = [];
  await checkForChanges({ storage, lookup: async () => ({ ipv4:'203.0.113.1', ipv6:null }), notify: async message => {messages.push(message);} });
  assert.deepEqual(messages, []);
});

test('changed IPv4 and IPv6 trigger a single notification with both changes', async () => {
  const { storage, scheduler } = fixture();
  await setMonitoringEnabled({ storage, alarms:scheduler }, true);
  const messages=[];
  const notify= async message=>messages.push(message);
  await checkForChanges({ storage, lookup:async()=>({ipv4:'203.0.113.1',ipv6:'2001:db8::1'}), notify });
  await checkForChanges({ storage, lookup:async()=>({ipv4:'203.0.113.2',ipv6:'2001:db8::2'}), notify });
  assert.equal(messages.length,1);
  assert.match(messages[0], /IPv4/);
  assert.match(messages[0], /IPv6/);
});

test('unavailable IP family does not cause false changes or clear previous valid address', async () => {
  const { storage, scheduler } = fixture();
  await setMonitoringEnabled({storage,alarms:scheduler},true);
  const messages=[];
  const notify=async message=>messages.push(message);
  await checkForChanges({storage,lookup:async()=>({ipv4:'203.0.113.1',ipv6:'2001:db8::1'}),notify});
  await checkForChanges({storage,lookup:async()=>({ipv4:'203.0.113.1',ipv6:null}),notify});
  await checkForChanges({storage,lookup:async()=>({ipv4:'203.0.113.1',ipv6:'2001:db8::1'}),notify});
  assert.equal(messages.length,0);
});

test('disabling monitoring prevents calls and resets baseline on re-enable', async () => {
  const { storage, scheduler }=fixture();
  await setMonitoringEnabled({storage,alarms:scheduler},true);
  let calls=0;
  const lookup=async()=> {calls++;return {ipv4:'203.0.113.1',ipv6:null};};
  await checkForChanges({storage,lookup,notify:async()=>{}});
  await setMonitoringEnabled({storage,alarms:scheduler},false);
  await checkForChanges({storage,lookup,notify:async()=>{}});
  assert.equal(calls,1);
  await setMonitoringEnabled({storage,alarms:scheduler},true);
  const notifications=[];
  await checkForChanges({storage,lookup:async()=>({ipv4:'203.0.113.2',ipv6:null}),notify:async m=>notifications.push(m)});
  assert.deepEqual(notifications,[]);
});

test('failed checks do not replace baseline', async () => {
  const { storage,scheduler }=fixture();
  await setMonitoringEnabled({storage,alarms:scheduler},true);
  await checkForChanges({storage,lookup:async()=>({ipv4:'203.0.113.1',ipv6:null}),notify:async()=>{}});
  await assert.rejects(()=>checkForChanges({storage,lookup:async()=>{throw Error('offline')},notify:async()=>{}}),/offline/);
  const notifications=[];
  await checkForChanges({storage,lookup:async()=>({ipv4:'203.0.113.3',ipv6:null}),notify:async m=>notifications.push(m)});
  assert.equal(notifications.length,1);
});
