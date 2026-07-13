// 05_cameras.js — Camera scoring/selection and HLS video slot rendering
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Candidate camera scoring ----------
// Returns ALL cameras on the locked highway(s) within [minDist, maxDist] of
// signed distance (negative = behind, positive = ahead), sorted ascending.
// Callers decide how much of this list they need — live tracking takes
// just the top two, manual browse mode pages through the whole thing.
function getScoredCameras(lat, lon, minDist, maxDist) {
  if (!currentHighway || !currentHighway.length) return [];

  const candidates = allCameras.filter(c => currentHighway.includes(normalizeHighwayName(c.roadway)));

  const scored = candidates.map(c => {
    const straightLineDist = haversineMeters(lat, lon, c.lat, c.lon);
    const bearingToCam = bearingDeg(lat, lon, c.lat, c.lon);

    // Project the straight-line distance onto our direction of travel:
    // positive = ahead of us, negative = behind us. This lets a camera
    // stay "in view" and count down through zero as you pass it, rather
    // than disappearing the instant its raw bearing crosses 90°.
    let dist;
    if (lastStableBearing === null) {
      dist = straightLineDist; // no travel direction locked yet — treat everything as ahead
    } else {
      const angle = angleDiff(bearingToCam, lastStableBearing);
      dist = straightLineDist * Math.cos(toRad(angle));
    }

    return { cam: c, dist };
  }).filter(s => s.dist >= minDist && s.dist <= maxDist);

  scored.sort((a, b) => a.dist - b.dist);
  return scored;
}

// Picks which two cameras should occupy the Nearest/Next slots, biased
// toward keeping whatever's already displayed unless a different camera
// is a clear (SWAP_MARGIN_M) improvement — this is what stops the display
// from flickering back and forth between two similarly-distanced cameras
// as GPS/bearing noise makes their relative ranking jitter tick to tick.
function pickWithHysteresis(scoredAsc, prevIds) {
  const byId = new Map(scoredAsc.map(s => [String(s.cam.id), s]));
  const result = [null, null];
  const consumed = new Set();

  for (let i = 0; i < 2; i++) {
    const prevId = prevIds[i];
    if (prevId && byId.has(prevId)) {
      result[i] = byId.get(prevId);
      consumed.add(prevId);
    }
  }

  const remaining = scoredAsc.filter(s => !consumed.has(String(s.cam.id)));
  for (let i = 0; i < 2; i++) {
    if (!result[i] && remaining.length) {
      const best = remaining.shift();
      result[i] = best;
      consumed.add(String(best.cam.id));
    }
  }

  // Keeping a camera "stuck" to whichever slot it previously occupied
  // (above) avoids restarting its video — but it says nothing about
  // whether that camera is still actually the nearer of the two. Sort by
  // real distance now so "Nearest" always shows the smaller distance;
  // the id-based DOM matching in updateDisplay() still relocates the
  // physical element rather than rebuilding it, so this reordering is
  // free of video interruption even when it swaps position.
  const filtered = result.filter(Boolean);
  filtered.sort((a, b) => a.dist - b.dist);

  return filtered;
}

// ---------- Video slot rendering ----------
// Each of the two DOM slot elements tracks which camera id it currently
// holds via a data attribute, and its hls.js instance via this Map. When a
// camera needs to move from the "next" position to "nearest" (or vice
// versa), we physically move the DOM element itself — which keeps its
// live <video> node and hls.js binding intact — rather than copying its
// innerHTML into the other slot, which would destroy and recreate the
// video element and silently orphan the still-running hls instance.
const hlsByEl = new Map();
let slotOrder = [slotEls[0], slotEls[1]]; // current top-to-bottom DOM order

function destroySlotEl(el) {
  const hls = hlsByEl.get(el);
  if (hls) {
    try { hls.detachMedia(); hls.destroy(); } catch (e) {}
    hlsByEl.delete(el);
  }
  if (el._manifestTimeout) {
    clearTimeout(el._manifestTimeout);
    el._manifestTimeout = null;
  }
  el._retryCount = 0;
}

function setLoadingState(el, isLoading) {
  const wrapper = el.querySelector('.video-wrapper');
  if (wrapper) wrapper.classList.toggle('loading', isLoading);
}

function showRetryUI(el) {
  const wrapper = el.querySelector('.video-wrapper');
  if (wrapper) wrapper.classList.add('stalled');
}

function hideRetryUI(el) {
  const wrapper = el.querySelector('.video-wrapper');
  if (wrapper) wrapper.classList.remove('stalled');
}

// Attaches (and, on failure, retries/recovers) a stream for the given
// camera into the given slot element. Cellular connections can be slow
// enough that a manifest never arrives or segments stall entirely, so
// this handles three layers of recovery: automatic hls.js error
// recovery, a small number of automatic full reconnect attempts with
// backoff, and finally a manual "tap to retry" button if all of that
// fails — so a slow/dead camera never just sits there black forever
// with no explanation or way to recover.
function attachStream(el, cam) {
  const video = el.querySelector('video');
  setLoadingState(el, true);
  hideRetryUI(el);
  el._retryCount = 0;

  function armManifestTimeout() {
    if (el._manifestTimeout) clearTimeout(el._manifestTimeout);
    el._manifestTimeout = setTimeout(() => {
      handleFailure();
    }, MANIFEST_TIMEOUT_MS);
  }

  function clearManifestTimeout() {
    if (el._manifestTimeout) {
      clearTimeout(el._manifestTimeout);
      el._manifestTimeout = null;
    }
  }

  function handleFailure() {
    clearManifestTimeout();
    setLoadingState(el, false);
    showRetryUI(el);
  }

  function startLoad() {
    destroySlotEl(el); // clear any previous instance/timer for this element
    hideRetryUI(el);
    setLoadingState(el, true);
    armManifestTimeout();

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 6,
        lowLatencyMode: true,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
      });
      hls.loadSource(cam.videoUrl);
      hls.attachMedia(video);
      hlsByEl.set(el, hls);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        clearManifestTimeout();
        setLoadingState(el, false);
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); return; } catch (e) { /* fall through to reconnect */ }
        }
        if (el._retryCount < MAX_STREAM_RETRIES) {
          el._retryCount++;
          const backoffMs = 1500 * el._retryCount;
          setTimeout(startLoad, backoffMs);
        } else {
          handleFailure();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = cam.videoUrl;
      video.addEventListener('loadedmetadata', () => {
        clearManifestTimeout();
        setLoadingState(el, false);
        video.play().catch(() => {});
      }, { once: true });
      video.addEventListener('error', () => {
        if (el._retryCount < MAX_STREAM_RETRIES) {
          el._retryCount++;
          setTimeout(startLoad, 1500 * el._retryCount);
        } else {
          handleFailure();
        }
      }, { once: true });
    } else {
      clearManifestTimeout();
      setLoadingState(el, false);
      handleFailure();
    }
  }

  video.addEventListener('waiting', () => setLoadingState(el, true));
  video.addEventListener('playing', () => { setLoadingState(el, false); hideRetryUI(el); });

  startLoad();

  // Manual retry button click (delegated once per element via a data flag).
  if (!el._retryHandlerBound) {
    el._retryHandlerBound = true;
    el.addEventListener('click', (e) => {
      const wrapper = el.querySelector('.video-wrapper');
      if (wrapper && wrapper.classList.contains('stalled')) {
        startLoad();
      }
    });
  }
}

function renderCameraIntoEl(el, camWithDist, label) {
  if (!camWithDist) {
    destroySlotEl(el);
    el.dataset.camId = '';
    el.className = 'cam-slot empty';
    if (label === 'Browsing') {
      el.textContent = 'No more cameras in this direction.';
    } else if (label === 'Next Camera') {
      el.textContent = '—';
    } else if (!currentHighway || !currentHighway.length) {
      el.textContent = 'Waiting for highway lock…';
    } else {
      const miles = (MAX_SEARCH_DIST_M / 1609.34).toFixed(0);
      el.textContent = `No camera within ${miles} mi ahead on ${currentHighway.join('/')}.`;
    }
    return;
  }

  const { cam, dist } = camWithDist;
  const distText = formatDistance(dist);

  if (el.dataset.camId === String(cam.id)) {
    // Same camera already live in this element — just refresh the label
    // (position may have changed, e.g. Next -> Nearest) and distance.
    const labelEl = el.querySelector('.cam-label');
    const distEl = el.querySelector('.cam-dist');
    if (labelEl) labelEl.textContent = label;
    if (distEl) distEl.textContent = distText;
    return;
  }

  // Genuinely new camera for this element — rebuild the player.
  destroySlotEl(el);
  el.dataset.camId = String(cam.id);
  el.className = 'cam-slot';
  el.innerHTML = `
    <div class="cam-header">
      <span class="cam-label">${label}</span>
      <span class="cam-dist">${distText}</span>
    </div>
    <div class="cam-location">${cam.location || ''}</div>
    <div class="video-wrapper">
      <video muted autoplay playsinline webkit-playsinline></video>
      <div class="video-loading"><div class="spinner"></div><div>Loading stream…</div></div>
      <button class="video-retry" type="button">
        <span class="retry-icon">⟳</span>
        <span>Stream stalled — tap to retry</span>
      </button>
    </div>
  `;

  attachStream(el, cam);
}

function updateDisplay(scoredCams, labels) {
  labels = labels || ['Nearest Camera', 'Next Camera'];
  const desiredIds = scoredCams.map(s => String(s.cam.id));

  // Prefer keeping each camera in the element that already has it live,
  // just at a (possibly) different position — avoids rebuilding video
  // that's already playing correctly, just relocates it.
  const usedEls = new Set();
  const newOrder = [null, null];
  desiredIds.forEach((id, pos) => {
    const match = slotOrder.find(el => el.dataset.camId === id && !usedEls.has(el));
    if (match) { newOrder[pos] = match; usedEls.add(match); }
  });
  const leftover = slotOrder.filter(el => !usedEls.has(el));
  for (let pos = 0; pos < 2; pos++) {
    if (!newOrder[pos]) newOrder[pos] = leftover.shift();
  }

  // Only touch the DOM if the physical order actually needs to change.
  // appendChild() on an element already in the DOM still MOVES it (removes
  // + reinserts) — this ran unconditionally on every position update, even
  // when the order hadn't changed at all, and mobile browsers tend to
  // auto-scroll to bring a freshly re-inserted <video> element into view.
  // That's what was resetting scroll to the top while scrolled down to
  // view the second camera.
  const orderChanged = newOrder.some((el, i) => el !== slotOrder[i]);
  if (orderChanged) {
    const container = document.getElementById('cam-list');
    newOrder.forEach(el => container.appendChild(el));
    slotOrder = newOrder;
  }

  slotOrder.forEach((el, pos) => {
    renderCameraIntoEl(el, scoredCams[pos] || null, labels[pos]);
  });
}
