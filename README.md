# IP Spot

A lightweight Chrome extension that shows your **public IP address**, its **approximate geographic location**, and a short **local history** of recent IP addresses.

![IP Spot v2.1.1](assets/preview.png)

## Features

- View your public IPv4 or IPv6 address, city, region, country, ISP, and ASN.
- Detect changes between consecutive successful IP lookups.
- Cache successful lookups for five minutes; use **Refresh** to bypass the cache.
- See when the current result was last checked.
- Copy the IP or copy all connection details, including timezone and coordinates.
- Save the five most recently observed **distinct** IP addresses locally with their last-known locations and dates.
- Open approximate coordinates in OpenStreetMap.
- Reuse the last-known cached result if the API fails while refreshing.
- Follow the system light/dark theme. No dependencies, accounts, or API keys.
- Show independently detected IPv4 and IPv6 public addresses, including IPv6-only or IPv4-only connections.
- Optionally enable background IP-change notifications; checks run approximately every 30 minutes while Chrome is running.

## Install in Chrome

1. Open the [latest IP Spot release](https://github.com/MohamadrezaKhalvati/ip-spot/releases/latest).
2. Under **Assets**, download the `-chrome.zip` file (for example, `ip-spot-v2.2.0-chrome.zip`).
3. Extract the ZIP into a folder you intend to keep. **Do not select the ZIP itself** when loading the extension.
4. Open `chrome://extensions` in Google Chrome.
5. Enable **Developer mode** in the top-right corner.
6. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
7. Pin **IP Spot** to the toolbar and click its icon to view your public IP and approximate location.

Chrome runs IP Spot directly from the extracted files; no build step is required.

### Update an existing installation

1. Download the newest `-chrome.zip` asset from [Releases](https://github.com/MohamadrezaKhalvati/ip-spot/releases/latest).
2. Extract it over the files in the **same folder** used for the existing unpacked extension.
3. Open `chrome://extensions` and click **Reload** on IP Spot.

Keep the same unpacked extension directory to preserve its Chrome extension identity. Your saved history is tied to that identity; removing and reinstalling the extension or changing its identity can clear or disconnect it.

## Run tests

Requires Node.js 22 or newer.

```bash
npm run verify
```

This runs JavaScript syntax checks and the dependency-free Node.js test suite, including a simulated Manifest V3 service worker. GitHub Actions runs the same command on pushes and pull requests.

### Manual verification before merging

1. Load the branch as an unpacked Chrome extension from a stable folder, then inspect `chrome://extensions` for manifest and service-worker errors.
2. On a known IPv4-only connection, verify IPv4 is shown and IPv6 displays **Unavailable** without blocking geolocation. Repeat using a known dual-stack connection; if available, test an IPv6-only connection too. A failed lookup alone does not establish network capability.
3. Enable alerts and confirm the notification permission prompt appears only when opted in. In Chrome DevTools for the extension service worker, inspect the `ip-spot-ip-check` alarm and verify its 30-minute interval.
4. After the first baseline check, change to a different network or VPN endpoint and wait for the next alarm; verify at most one alert for that observed IP change. Background checks are not immediate and do not run while Chrome is closed.
5. Disable alerts while a check is in progress, restart Chrome, and confirm no new polling occurs while disabled. Re-enable monitoring and confirm the first check establishes a fresh baseline rather than issuing an old alert.
6. Use a network-throttled or offline scenario. Confirm the popup retains previously checked addresses, and monitoring can resume when connectivity returns.

Automated tests mock network responses and Chrome APIs. Real IPv4/IPv6 routing, OS notification delivery, and suspended-worker behavior require the installed-Chrome checks above.

## How it works

- **Manifest:** Chrome Extension Manifest V3.
- **Source:** Standard JavaScript ES modules and CSS; no bundled frameworks or remote code.
- **Lookup:** A request to `https://ipwho.is/` when the popup is opened with no fresh cache, or when you press Refresh.
- **Cache:** Five-minute TTL since the previous successful lookup.
- **History:** Up to five distinct IP addresses in `chrome.storage.local`. Revisiting an IP updates its location, timestamp, and ordering.
- **IP change detection:** The popup compares locations on lookup. Separately, optional background monitoring checks addresses about every 30 minutes when enabled.
- **Maps:** OpenStreetMap links for returned valid geographic coordinates.
- **Dual-stack detection:** IPv4 via `api.ipify.org`; IPv6 via `api6.ipify.org`. **Unavailable** means a family lookup failed or the connection does not expose that family; it is not proof that the network lacks support.
- **Notifications:** Off by default. Enabling alerts requests notification permission, establishes a baseline, and periodically checks both addresses using Chrome alarms. Only changes between two successfully detected IPs trigger notifications. Failed notification delivery is retried on a subsequent successful check; the last observed IP and undelivered alert are persisted locally. Background checks do not collect geolocation or add entries to location history. Alerts may be delayed or skipped while Chrome is closed, the device is asleep, or the network is unavailable.

## Privacy and permissions

IP Spot requires `storage` and `alarms` permissions, host access to `https://ipwho.is/*`, `https://api.ipify.org/*`, and `https://api6.ipify.org/*`, and requests `notifications` as an **optional permission** only when enabled. It does **not** request access to browsing history, tabs, or device GPS.

When a lookup occurs, your public IP and request metadata are visible to `ipwho.is` (geolocation) and ipify (IPv4/IPv6 checks). When monitoring is enabled, periodic requests are sent to ipify; disabling notifications stops these checks. Clicking a map link opens OpenStreetMap, which also receives normal browser request metadata. Cache and history stay in Chrome's **local** extension storage; they are not synced by IP Spot. Chrome clears that storage when the extension is uninstalled. IP-based locations are approximate and can be affected by VPNs, proxies, cloud hosting, and ISP routing.

## Release notes

**v2.2.0**: Added separate public IPv4/IPv6 checks and opt-in background change notifications with permission-on-demand and a 30-minute polling interval.

**v2.1.1**: Added geographic details, last-checked dates, and map links to the recent-IP history, with compatibility for existing v2.1 history entries.

**v2.1.0**: Added IP change detection, a five-minute cache, last-checked time, ASN, copy-all details, and five-entry history.

## License

Licensed under the [MIT License](LICENSE).

