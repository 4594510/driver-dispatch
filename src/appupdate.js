// The newest driver app (APK) on GitHub, so the app can say "a new version is ready" and update itself.
// The "Driver app" workflow publishes each build from main as the release "driver-app", titled "Driver app (build N)";
// N is the app's versionCode. Looked up at most every 15 minutes; a failed lookup keeps what we knew.
const REPO = "4594510/driver-dispatch";
const EVERY_MS = 15 * 60000;

export function createAppRelease({ repo = REPO, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let known = null;
  let checkedAt = -Infinity;
  let pending = null;

  async function check() {
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/driver-app`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "driver-dispatch" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const r = await res.json();
      const version = Number(/build (\d+)/i.exec(r?.name || "")?.[1]);
      const apk = (r?.assets || []).find((a) => /\.apk$/i.test(a?.name || ""));
      if (version > 0 && apk?.browser_download_url) known = { version, url: apk.browser_download_url };
    } catch {
      /* GitHub not reachable: try again later */
    }
  }

  // What we know now (null at first); a lookup runs in the background when it's time.
  function latest() {
    if (!pending && now() - checkedAt >= EVERY_MS) {
      checkedAt = now();
      pending = check().finally(() => (pending = null));
    }
    return known;
  }
  latest.refresh = async () => { checkedAt = now(); await check(); return known; };
  return latest;
}
