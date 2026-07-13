// 08_main.js — Wake lock, layout observer, and app init/wiring
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Keep screen awake ----------
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return; // unsupported browser — fails silently
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    // Common causes: low battery mode, or the tab isn't visible yet.
    console.warn('Wake lock request failed:', err);
  }
}

// The lock is automatically released whenever the tab is hidden (e.g. you
// switch apps to check a map, then come back) — re-acquire it on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

// The sticky group's height changes whenever the shield image finishes
// loading, the mile marker sign appears, or the message banner shows/hides.
// #scan-bar's sticky offset needs to track that exactly, or it'll overlap/
// hide behind the group — which is what was causing the banner and scan
// bar to visually flicker in and out.
function observeTopBarGroupHeight() {
  const group = document.getElementById('top-bar-group');
  if (!group) return;
  const apply = () => {
    document.documentElement.style.setProperty('--top-group-h', `${group.offsetHeight}px`);
  };
  if ('ResizeObserver' in window) {
    new ResizeObserver(apply).observe(group);
  } else {
    window.addEventListener('resize', apply);
  }
  apply();
}

async function init() {
  await loadCameras();
  acquireWakeLock();
  observeTopBarGroupHeight();

  document.getElementById('sim-start-btn').addEventListener('click', startSimulation);
  document.getElementById('sim-stop-btn').addEventListener('click', () => {
    stopSimulation();
    gpsText.textContent = 'Simulation stopped.';
  });

  aheadBtn.addEventListener('click', moveAhead);
  behindBtn.addEventListener('click', moveBehind);
  locateBtn.addEventListener('click', locate);
  updateScanBarState();

  if (!navigator.geolocation) {
    gpsText.textContent = 'Geolocation not supported on this device/browser.';
    return;
  }

  navigator.geolocation.watchPosition(onRealPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000,
  });
}

init();
