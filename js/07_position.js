// 07_position.js — Position handling shared by real GPS + simulator, and the drive simulator itself
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Main position handling (shared by real GPS and simulator) ----------
// ---------- Main position handling (shared by real GPS and simulator) ----------
async function handlePosition(lat, lon, source) {
  lastKnownPos = { lat, lon };

  gpsDot.className = 'dot live';
  gpsText.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}${source === 'sim' ? ' (simulated)' : ''}`;

  updateDirection(lat, lon);

  const now = Date.now();
  if (now - lastHighwayCheck > HIGHWAY_RECHECK_MS) {
    lastHighwayCheck = now;
    const mySeq = ++highwayCheckSeq;
    const snap = await snapToHighway(lat, lon);
    // Only drop this response if a LATER request already finished and got
    // applied — not merely because a later request was fired. Overpass's
    // round-trip time can exceed HIGHWAY_RECHECK_MS under load, and if we
    // required mySeq to still equal the live (ever-incrementing) counter,
    // every response would arrive "outdated" by definition and the lock
    // would never update again. Comparing against the last APPLIED seq
    // instead means a slow-but-still-newest-so-far response still lands.
    if (mySeq > highwayCheckAppliedSeq) {
    highwayCheckAppliedSeq = mySeq;
    const snapKeys = snap.normalizedList; // e.g., ["I-40", "US-74"]

    if (snapKeys.length === 0) {
      // No confident match or API error this round — do nothing and keep current lock
      setDebug({ overpassError: snap.error || "No ways found within radius" });
    } else if (!currentHighway) {
      // 1. First lock of the drive — accept immediately
      currentHighway = snapKeys;
      highwayText.textContent = currentHighway.join(' / ');
      updateHighwayShields(getShieldRefs(currentHighway));
    } else if (currentHighway.some(h => snapKeys.includes(h))) {
      // 2. STABILITY CHECK: We are still on our currently locked highway/multiplex.
      // Update the array and UI immediately to match any changes (like dropping/adding a route).
      currentHighway = snapKeys; 
      highwayText.textContent = currentHighway.join(' / ');
      updateHighwayShields(getShieldRefs(currentHighway));
      pendingHighway = null;
      pendingHighwayCount = 0;
    } else {
      // 3. ROUTE TRANSITION: We are genuinely on a completely different road
      // (dropping/adding a concurrent route is handled above and switches
      // instantly — this only fires when NONE of the old refs remain).
      // Switch immediately; there's no confirm-count delay here anymore.
      // Overpass/interchange jitter mostly shows up as a brief EXTRA ref
      // appearing alongside the real one, which the overlap branch above
      // already absorbs without ever reaching this branch.
      currentHighway = snapKeys;
      highwayText.textContent = currentHighway.join(' / ');
      updateHighwayShields(getShieldRefs(currentHighway));
      pendingHighway = null;
      pendingHighwayCount = 0;

      // Clear route-specific tracking so it recalculates for the new highway
      currentMilepost = null;
      lastMilepostCheck = 0;
      highwayDirectionLabel = null;
    }

    setDebug({
      rawRef: snap.rawName,
      normalizedList: snap.normalizedList,
      overpassError: snap.error,
      locked: currentHighway,
      pending: pendingHighway,
      pendingCount: pendingHighwayCount
    });
    }
  }

  if (!browseActive) {
    liveUpdate();
  }
  updateScanBarState();

  await updateMilepostAndDirection(lat, lon);
  updateMessageBanner(lat, lon);

  const debugScored = getScoredCameras(lat, lon, -SWAP_BUFFER_M, MAX_SEARCH_DIST_M);
  debugContent.textContent = JSON.stringify({
    highway: currentHighway,
    direction: currentDirectionLabel,
    bearing: lastStableBearing ? Math.round(lastStableBearing) : null,
    browseActive,
    candidates: debugScored.map(s => ({ id: s.cam.id, dist: Math.round(s.dist), loc: s.cam.location }))
  }, null, 2);
}

function onPositionError(err) {
  gpsDot.className = 'dot';
  gpsText.textContent = `GPS error: ${err.message}`;
}

function onRealPosition(position) {
  if (simTimer) return; // ignore real GPS while a simulation is running
  handlePosition(position.coords.latitude, position.coords.longitude, 'real');
}

// ---------- Drive simulator ----------
let simTimer = null;

function parseLatLon(str) {
  const parts = str.split(',').map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  return { lat: parts[0], lon: parts[1] };
}

function startSimulation() {
  stopSimulation();

  const start = parseLatLon(document.getElementById('sim-start').value);
  const end = parseLatLon(document.getElementById('sim-end').value);
  const mph = parseFloat(document.getElementById('sim-speed').value) || 60;
  const multiplier = parseFloat(document.getElementById('sim-multiplier').value) || 1;

  if (!start || !end) {
    alert('Enter valid "lat,lon" for both start and end.');
    return;
  }

  // Reset tracking state so the sim starts clean
  posHistory = [];
  lastStableBearing = null;
  pendingBearing = null;
  pendingBearingCount = 0;
  currentHighway = null;
  pendingHighway = null;
  pendingHighwayCount = 0;
  lastHighwayCheck = 0;
  highwayCheckSeq = 0;
  highwayCheckAppliedSeq = 0;
  highwayText.textContent = '—';
  browseActive = false;
  browseList = [];
  browseIndex = 0;
  lastKnownPos = null;
  currentMilepost = null;
  lastMilepostCheck = 0;
  highwayDirectionLabel = null;
  shieldGroupRefs = null;
  shieldDirEls = {};
  messageSigns = [];
  lastMsgSignFetch = 0;
  activeSignId = null;
  lastSpokenMessage = null;
  shieldGroupEl.innerHTML = '';
  highwayText.style.display = '';
  mmSignEl.style.display = 'none';
  speedValueEl.textContent = '—';
  msgBannerEl.style.display = 'none';
  slotOrder.forEach(el => {
    destroySlotEl(el);
    el.dataset.camId = '';
  });

  const totalDist = haversineMeters(start.lat, start.lon, end.lat, end.lon);
  const speedMs = mph * 0.44704; // mph -> m/s
  const totalTimeSec = totalDist / speedMs;
  const TICK_SEC = 2; // each tick advances 2 seconds of simulated driving time
  const totalTicks = Math.max(1, Math.ceil(totalTimeSec / TICK_SEC));
  const realTickMs = (TICK_SEC * 1000) / multiplier; // real wall-clock delay per tick

  let tick = 0;
  gpsText.textContent = `Simulating: ${(totalDist / 1609.34).toFixed(1)} mi @ ${mph} mph (${multiplier}x, ~${Math.round(totalTimeSec / multiplier)}s real time)`;

  simTimer = setInterval(() => {
    tick++;
    const frac = Math.min(1, tick / totalTicks);
    const lat = start.lat + (end.lat - start.lat) * frac;
    const lon = start.lon + (end.lon - start.lon) * frac;

    handlePosition(lat, lon, 'sim');

    if (frac >= 1) {
      stopSimulation();
      gpsText.textContent += ' — simulation complete';
    }
  }, realTickMs);
}

function stopSimulation() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
}
