// 06_browse.js — Manual ahead/behind camera browsing (scan bar)
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Manual ahead/behind browse mode ----------
// Lets you page through cameras further out than the live nearest/next
// window without waiting to physically drive there. Snapshots the camera
// list at the moment you first press a button (using your last known
// position), then Ahead/Behind just walk an index through that snapshot.
// Live GPS tracking (highway lock, direction) keeps running underneath so
// "locate" can snap straight back to an accurate live view.
let lastKnownPos = null;
let browseActive = false;
let browseList = [];
let browseIndex = 0;

const behindBtn = document.getElementById('scan-behind-btn');
const aheadBtn = document.getElementById('scan-ahead-btn');
const locateBtn = document.getElementById('scan-locate-btn');
const camListEl = document.getElementById('cam-list');

function updateScanBarState() {
  camListEl.classList.toggle('browsing', browseActive);
  locateBtn.classList.toggle('active', browseActive);
  behindBtn.disabled = !browseActive && !lastKnownPos;
  aheadBtn.disabled = !browseActive && !lastKnownPos;
  if (browseActive) {
    behindBtn.disabled = browseIndex <= 0;
    aheadBtn.disabled = browseIndex >= browseList.length - 1;
  }
}

function liveUpdate() {
  if (!lastKnownPos) return;
  const scoredFull = getScoredCameras(lastKnownPos.lat, lastKnownPos.lon, -SWAP_BUFFER_M, MAX_SEARCH_DIST_M);
  const prevIds = slotOrder.map(el => el.dataset.camId || null);
  const selected = pickWithHysteresis(scoredFull, prevIds);
  updateDisplay(selected, ['Nearest Camera', 'Next Camera']);
}

function renderBrowse() {
  const pair = [browseList[browseIndex], browseList[browseIndex + 1]].filter(Boolean);
  updateDisplay(pair, ['Browsing', 'Browsing']);
  updateScanBarState();
}

function enterBrowseIfNeeded() {
  if (browseActive || !lastKnownPos || !currentHighway || !currentHighway.length) return false;
  const list = getScoredCameras(lastKnownPos.lat, lastKnownPos.lon, -BROWSE_RANGE_M, BROWSE_RANGE_M);
  if (!list.length) return false;
  // Start browsing from whichever camera is currently closest to your
  // actual position, so the first tap moves logically forward/back from
  // where you already are rather than jumping to the list's edge.
  let closestIdx = 0, closestAbs = Infinity;
  list.forEach((s, i) => { const a = Math.abs(s.dist); if (a < closestAbs) { closestAbs = a; closestIdx = i; } });
  browseList = list;
  browseIndex = closestIdx;
  browseActive = true;
  return true;
}

function moveAhead() {
  const justEntered = enterBrowseIfNeeded();
  if (!browseActive) return;
  if (!justEntered) browseIndex = Math.min(browseIndex + 1, Math.max(0, browseList.length - 1));
  renderBrowse();
}

function moveBehind() {
  const justEntered = enterBrowseIfNeeded();
  if (!browseActive) return;
  if (!justEntered) browseIndex = Math.max(browseIndex - 1, 0);
  renderBrowse();
}

function locate() {
  browseActive = false;
  browseList = [];
  browseIndex = 0;
  liveUpdate();
  updateScanBarState();
}
