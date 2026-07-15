// 03_highway.js — Overpass highway snapping, direction-of-travel tracking, highway shields, mile markers
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Highway snap via Overpass (returns real route "ref" tags,
// e.g. "I-40", not the scenic/local "name" tag like "Dan K. Moore Freeway".
// Restricted to motorway/trunk (excludes _link/ramp ways, primary roads, and any
// crossing road at overpasses) and searched within a tight radius so we
// don't accidentally grab a road passing underneath/above.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_FETCH_TIMEOUT_MS = 6000; // hard client-side cap per mirror attempt — the query's
                                          // own [timeout:10] only bounds Overpass's own server-side
                                          // processing, not how long our fetch() waits for a response,
                                          // so a hung/slow mirror could otherwise stall highway lock
                                          // far longer than necessary before ever trying the 2nd mirror
const SNAP_RADIUS_M = 60; // how close a way must be to count as "you're on it" —
                           // loose enough to tolerate the test simulator's straight-line
                           // path drifting off the actual (curved) road; real GPS traces
                           // will sit right on the road so this won't hurt real accuracy.

async function snapToHighway(lat, lon) {
  const query = `
    [out:json][timeout:10];
    way(around:${SNAP_RADIUS_M},${lat},${lon})
      [highway~"^(motorway|trunk)$"];
    out tags;
  `;

  let lastError = null;
  for (const baseUrl of OVERPASS_URLS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(baseUrl, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} from ${baseUrl}`;
        continue; // try next mirror
      }
      const data = await resp.json();
      if (!data.elements || !data.elements.length) {
        return { rawName: null, normalizedList: [], error: null };
      }
      // IMPORTANT: don't just look at elements[0]. Divided highways are
      // almost always split into separate way segments in OSM (one per
      // carriageway direction, plus ramps/merges), and several can sit
      // within the search radius at once — Overpass's ordering of them
      // is arbitrary, not proximity-ranked. At a concurrency (e.g. I-26
      // running with US-74), taking only the first element risks picking
      // a segment tagged with just one of the two refs. So union refs
      // across every nearby element instead.
      const refSet = new Set();
      let nameFallback = null;
      for (const el of data.elements) {
        const t = el.tags || {};
        if (t.ref) {
          t.ref.split(';').map(s => s.trim()).filter(Boolean).forEach(r => refSet.add(r));
        } else if (!nameFallback && t.name) {
          nameFallback = t.name.trim();
        }
      }
      const sources = refSet.size ? [...refSet] : (nameFallback ? [nameFallback] : []);
      if (!sources.length) return { rawName: null, normalizedList: [], error: null };

      const normalizedList = sources.map(normalizeHighwayName).filter(Boolean);
      return { rawName: sources.join(' / '), normalizedList, error: null };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err.name === 'AbortError'
        ? `${baseUrl}: timed out after ${OVERPASS_FETCH_TIMEOUT_MS}ms`
        : `${baseUrl}: ${err.message}`;
    }
  }
  console.warn('Overpass snap failed on all mirrors:', lastError);
  return { rawName: null, normalizedList: [], error: lastError };
}

// ---------- Direction of travel (with hysteresis) ----------
function updateDirection(lat, lon) {
  const now = Date.now();
  posHistory.push({ lat, lon, t: now });
  // keep last ~8 points
  if (posHistory.length > 8) posHistory.shift();
  if (posHistory.length < 2) return;

  const first = posHistory[0];
  const last = posHistory[posHistory.length - 1];
  const dist = haversineMeters(first.lat, first.lon, last.lat, last.lon);

  // Speed: average over the same short window used for bearing (last ~8
  // GPS fixes). Updates every position tick, independent of the bearing's
  // own displacement threshold below, so it still reads ~0 mph when stopped
  // instead of freezing at the last moving value.
  const dtSec = (last.t - first.t) / 1000;
  if (dtSec >= 1) {
    const mph = (dist / 1609.34) / (dtSec / 3600);
    speedValueEl.textContent = Math.round(mph);
  }

  if (dist < MIN_DISPLACEMENT_M) return; // not enough movement to trust a bearing

  const newBearing = bearingDeg(first.lat, first.lon, last.lat, last.lon);

  if (lastStableBearing === null) {
    lastStableBearing = newBearing;
    currentDirectionLabel = bearingToCompassLabel(newBearing);
    return;
  }

  const diff = angleDiff(newBearing, lastStableBearing);
  if (diff < BEARING_DISAGREE_DEG) {
    // agrees with current direction, reset any pending flip
    lastStableBearing = newBearing;
    pendingBearing = null;
    pendingBearingCount = 0;
  } else {
    // disagrees - only flip after repeated confirmation
    if (pendingBearing !== null && angleDiff(newBearing, pendingBearing) < BEARING_DISAGREE_DEG) {
      pendingBearingCount++;
    } else {
      pendingBearing = newBearing;
      pendingBearingCount = 1;
    }
    if (pendingBearingCount >= BEARING_CONFIRM_COUNT) {
      lastStableBearing = newBearing;
      currentDirectionLabel = bearingToCompassLabel(newBearing);
      pendingBearing = null;
      pendingBearingCount = 0;
    }
  }
}

// ---------- Highway ref parsing + shield lookup ----------
function parseHighwayRef(ref) {
  if (!ref) return null;
  const m = ref.match(/^(I|US|VA)-(\d+)$/);
  if (!m) return null;
  return { type: m[1], number: parseInt(m[2], 10), isEven: parseInt(m[2], 10) % 2 === 0 };
}

// When multiple routes are concurrent (e.g. I-26 running with US-74),
// VDOT's mile markers and exit numbers follow the Interstate designation,
// not whichever ref happened to sort first out of Overpass. Used for
// milepost lookups and the shield — NOT for the on-screen "I-26 / US-74"
// text, which still shows the full concurrency, and NOT for camera
// matching, which already checks against every ref in the list.
function primaryHighwayRef(list) {
  if (!list || !list.length) return null;
  const priority = { I: 0, US: 1, VA: 2 };
  return [...list].sort((a, b) => {
    const pa = parseHighwayRef(a), pb = parseHighwayRef(b);
    return (pa ? priority[pa.type] : 99) - (pb ? priority[pb.type] : 99);
  })[0];
}

// Which ref(s) to show a shield+direction for. Two (or more) concurrent
// Interstates is the one case where there's genuinely no single "correct"
// choice — e.g. I-40/I-85 near Durham/Hillsborough is signed and
// mile-marked as I-85 in one stretch and as I-40 in another depending on
// which route "owns" that segment, and that ownership isn't something we
// can determine from OSM tag order. So instead of guessing one, show every
// Interstate ref concurrently present, each with its own GPS-bearing-
// derived direction. Non-Interstate concurrencies (e.g. I-26/US-74) still
// collapse to a single primary ref as before.
function getShieldRefs(list) {
  if (!list || !list.length) return [];
  const interstates = list.filter(r => {
    const p = parseHighwayRef(r);
    return p && p.type === 'I';
  });
  if (interstates.length >= 2) return interstates;
  const primary = primaryHighwayRef(list);
  return primary ? [primary] : [];
}

// Display-only shortening ("Northbound" -> "North"). The full word is kept
// in highwayDirectionLabel itself since the DMS feed's DirectionOfTravel field
// uses the full "Northbound"/"Eastbound"/etc. and dirMatches() compares
// against it directly.
function shortDirection(label) {
  return label ? label.replace(/bound$/i, '') : '';
}

// Try a short list of plausible Wikimedia Commons filenames for a route
// shield, falling back through the list via onerror. Special:FilePath
// redirects directly to the image so no API round-trip is needed.
function shieldCandidates(parsed) {
  const n = parsed.number;
  if (parsed.type === 'I') return [`I-${n}.svg`, `Interstate ${n}.svg`, `I-${n} (VA).svg`];
  if (parsed.type === 'US') return [`US ${n}.svg`, `US Highway ${n}.svg`, `US ${n} (VA).svg`];
  if (parsed.type === 'VA') return [`Virginia ${n}.svg`, `VA ${n}.svg`, `VA-${n}.svg`];
  return [];
}

// Builds one .shield-wrap (direction label + shield img, falling back to
// plain text) per ref passed in. Normally just the primary ref, but when
// driving a multi-interstate concurrency (e.g. I-40/I-85) we're told to
// show every interstate's own shield and its own GPS-bearing-derived
// direction side by side, since either could be the one signed/mile-marked
// at this exact spot and there's no single "correct" one to pick.
function updateHighwayShields(refs) {
  const key = refs.join('|');
  if (shieldGroupRefs === key) return;
  shieldGroupRefs = key;

  shieldGroupEl.innerHTML = '';
  shieldDirEls = {};
  refs.forEach(ref => {
    const parsed = parseHighwayRef(ref);
    const wrap = document.createElement('div');
    wrap.className = 'shield-wrap';

    const dirEl = document.createElement('div');
    dirEl.className = 'direction-label';
    // highwayDirectionLabel must be checked FIRST — it's the corrected value
    // (bearing normally, but overridden by mile-marker ascending/descending
    // trend when the road's local bearing disagrees with its true signed
    // direction, e.g. I-85 Gastonia-Charlotte). The raw bearing guess is
    // only a fallback for before we have any milepost data yet (e.g. right
    // after a fresh highway lock, before the first mile-marker query
    // resolves) — checking it first would silently overwrite the
    // correction on every single call, which is exactly what was showing
    // the wrong direction here even after updateMilepostAndDirection() had
    // already computed the right one.
    const dir = highwayDirectionLabel || bearingToTravelDirection(lastStableBearing, parsed);
    dirEl.textContent = shortDirection(dir);
    wrap.appendChild(dirEl);
    shieldDirEls[ref] = dirEl;

    if (!parsed) {
      const textEl = document.createElement('div');
      textEl.className = 'highway';
      textEl.textContent = ref;
      wrap.appendChild(textEl);
      shieldGroupEl.appendChild(wrap);
      return;
    }

    const img = document.createElement('img');
    img.className = 'highway-shield';
    img.alt = ref;
    const textFallback = document.createElement('div');
    textFallback.className = 'highway';
    textFallback.textContent = ref;
    textFallback.style.display = 'none';

    const candidates = shieldCandidates(parsed);
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) {
        img.style.display = 'none';
        textFallback.style.display = '';
        return;
      }
      img.onerror = tryNext;
      img.onload = () => {
        img.style.display = 'inline-block';
        textFallback.style.display = 'none';
      };
      img.src = COMMONS_FILEPATH + encodeURIComponent(candidates[i]);
      i++;
    };
    tryNext();

    wrap.appendChild(img);
    wrap.appendChild(textFallback);
    shieldGroupEl.appendChild(wrap);
  });
  // The old dedicated highway-text element is redundant once every ref has
  // its own fallback text baked into its shield-wrap; keep it hidden.
  highwayText.style.display = 'none';
}

// Updates each currently-shown shield's direction text from the latest
// bearing without touching the shield images themselves (those only need
// to change when the set of refs changes, not every time direction ticks).
function refreshShieldDirections() {
  Object.keys(shieldDirEls).forEach(ref => {
    const parsed = parseHighwayRef(ref);
    // Same priority as updateHighwayShields() above — highwayDirectionLabel
    // (mile-marker-corrected) must win over the raw bearing guess.
    const dir = highwayDirectionLabel || bearingToTravelDirection(lastStableBearing, parsed);
    if (dir) shieldDirEls[ref].textContent = shortDirection(dir);
  });
}

// ---------- Mile marker lookup ----------
// VDOT's HTRIS_DEF field packs route number + direction into one
// zero-padded string rather than splitting them into separate fields, e.g.
// something like "00006400" + a value + a trailing letter — exact width is
// unconfirmed since we haven't seen live sample rows, but VDOT route
// numbers never start with 0, so: strip leading zeros to find the numeric
// route number, and treat any non-digit characters left over (usually at
// the end) as the direction code. Single letters (N/S/E/W) and two-letter
// codes (NB/SB/EB/WB) are both handled.
function parseHtrisRoute(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  const m = s.match(/^[A-Z]*0*(\d+)([A-Z]*)$/); // optional letter prefix, zero-padding, digits, optional direction suffix
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, dirCode: m[2] || '' };
}

const HTRIS_DIR_CODES = {
  N: 'Northbound', NB: 'Northbound',
  S: 'Southbound', SB: 'Southbound',
  E: 'Eastbound', EB: 'Eastbound',
  W: 'Westbound', WB: 'Westbound',
};

// DIR is a proper field (alias "Direction") but its reliability across the
// whole dataset is unconfirmed — prefer it when it's a recognizable compass
// value, otherwise fall back to decoding the HTRIS_DEF suffix.
function resolveMileMarkerDirection(dirField, htrisDef) {
  const fromField = HTRIS_DIR_CODES[String(dirField || '').trim().toUpperCase()];
  if (fromField) return fromField;
  const parsed = parseHtrisRoute(htrisDef);
  return parsed ? (HTRIS_DIR_CODES[parsed.dirCode] || null) : null;
}

// Route matching against HTRIS_DEF is done by number only (not type letter)
// since we haven't confirmed whether/how HTRIS_DEF encodes route type —
// this mirrors the previous "just the bare number" fallback and is the
// safest match against an unconfirmed format.
function routeNameMatches(routeName, parsedRef) {
  if (!routeName || !parsedRef) return false;
  const parsed = parseHtrisRoute(routeName);
  return parsed ? parsed.number === parsedRef.number : false;
}

async function queryNearestMileMarkers(lat, lon) {
  if (!MILEMARKER_QUERY_URL) return { features: [] };
  const params = new URLSearchParams({
    f: 'json',
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(MILEMARKER_SEARCH_RADIUS_M),
    units: 'esriSRUnit_Meter',
    outFields: 'HTRIS_DEF,DIR,NUM_SG_VAL,LATITUDE,LONGITUDE',
    returnGeometry: 'false',
  });
  try {
    const resp = await fetch(`${MILEMARKER_QUERY_URL}?${params.toString()}`);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const data = await resp.json();
    if (data.error) return { error: JSON.stringify(data.error) };
    return { features: data.features || [] };
  } catch (err) {
    return { error: err.message };
  }
}

// Direction is derived from our actual GPS travel bearing, not from
// "whichever mile marker happens to be closest" — on a divided highway
// the opposite-direction carriageway's marker is often only a few dozen
// feet away across the median, so distance alone flips constantly.
// Route parity (even/odd) tells us which axis the route runs on; the
// bearing tells us which way along that axis we're actually moving.
function bearingToTravelDirection(bearing, parsedRef) {
  if (bearing == null || !parsedRef) return null;
  const rad = toRad(bearing);
  return parsedRef.isEven
    ? (Math.sin(rad) >= 0 ? 'Eastbound' : 'Westbound')   // even routes run E-W
    : (Math.cos(rad) >= 0 ? 'Northbound' : 'Southbound'); // odd routes run N-S
}

const MM_SNAP_RADIUS_M = 160.9; // 0.1 mile — within this, use the sign's exact value instead of interpolating

// Uses the two nearest matching-route-AND-matching-direction signs to
// linearly interpolate the driver's position to a tenth of a mile. Signs
// on the opposite carriageway are excluded entirely via the bearing-derived
// direction, which also fixes direction flip-flopping.
async function updateMilepostAndDirection(lat, lon) {
  const now = Date.now();
  if (now - lastMilepostCheck < MILEMARKER_RECHECK_MS) return;
  lastMilepostCheck = now;
  if (!currentHighway || !currentHighway.length) return;

  const { features, error } = await queryNearestMileMarkers(lat, lon);
  if (error) { setDebug({ milepostLookup: error }); return; }
  if (!features.length) { setDebug({ milepostLookup: 'no mile markers within search radius' }); return; }

  const withMeta = features.map(f => {
    const a = f.attributes || {};
    const mp = a.NUM_SG_VAL;
    const dist = (a.LATITUDE != null && a.LONGITUDE != null)
      ? haversineMeters(lat, lon, a.LATITUDE, a.LONGITUDE)
      : Infinity;
    return { mp, dist, lat: a.LATITUDE, lon: a.LONGITUDE, routeName: a.HTRIS_DEF, direction: resolveMileMarkerDirection(a.DIR, a.HTRIS_DEF) };
  });

  // Try every candidate ref (both Interstates of a multiplex, or just the
  // single primary ref otherwise) and use whichever one actually has mile
  // markers here — rather than committing to one ref up front by guesswork
  // and having the whole lookup silently fail if that guess is the one
  // The DOT doesn't mile-mark at this particular spot (e.g. I-40/I-85: the
  // markers switch between belonging to I-40 and I-85 depending on where
  // you are, regardless of which ref sorts "primary").
  const tryRefs = getShieldRefs(currentHighway);
  let matched = null;
  for (const ref of tryRefs) {
    const parsedForRef = parseHighwayRef(ref);
    if (!parsedForRef) continue;
    const bearingDirection = bearingToTravelDirection(lastStableBearing, parsedForRef);
    const routeCandidates = withMeta.filter(f => f.mp != null && routeNameMatches(f.routeName, parsedForRef));
    if (!routeCandidates.length) continue;

    // Reject opposite-carriageway markers whenever we know our direction and
    // the marker declares its own. Markers with no RouteDirection attribute
    // are kept as a fallback pool only if nothing direction-matches.
    let candidates = routeCandidates;
    const dirGuess = bearingDirection || highwayDirectionLabel;
    if (dirGuess) {
      const sameDirection = routeCandidates.filter(f => f.direction === dirGuess);
      if (sameDirection.length) candidates = sameDirection;
      else candidates = routeCandidates.filter(f => !f.direction);
    }
    if (!candidates.length) continue;

    matched = { ref, parsedForRef, bearingDirection, candidates };
    break;
  }

  if (!matched) {
    setDebug({ milepostLookup: 'no matching-route markers in our direction of travel', sampleRouteNames: features.slice(0, 5).map(f => f.attributes && f.attributes.HTRIS_DEF) });
    return;
  }

  // Bearing not stable yet (e.g. right after GPS lock) — fall back to
  // whatever direction we last had, rather than guessing from distance.
  highwayDirectionLabel = matched.bearingDirection || highwayDirectionLabel;

  const candidates = matched.candidates;
  candidates.sort((a, b) => a.dist - b.dist);
  let interpolated;
  if (candidates[0].dist <= MM_SNAP_RADIUS_M) {
    // Close enough to a real sign — use its exact printed value.
    interpolated = candidates[0].mp;
  } else if (candidates.length >= 2) {
    const [a, b] = candidates;
    const total = a.dist + b.dist;
    interpolated = total > 0 ? (a.mp * b.dist + b.mp * a.dist) / total : a.mp;
  } else {
    interpolated = candidates[0].mp;
  }
  currentMilepost = newMilepost;

  // ---- Mile-marker ascending/descending check ----
  // Single-poll calculation: find the nearest matched marker AHEAD of us
  // and the nearest one BEHIND us (via bearing projection — same technique
  // used for camera scoring elsewhere in this file), then just compare
  // their MP values directly. No need to wait across multiple polls for
  // this, unlike a naive "compare this reading to the last one" approach.
  //
  // This matters because some highway segments physically curve away from
  // their nominal compass direction — e.g. I-85 between Gastonia and
  // Charlotte, NC is signed "northbound" the whole way, but the road there
  // runs east-southeast, which a bearing-only check reads as southbound.
  // Mile markers always increase in the highway's true SIGNED direction
  // regardless of local road geometry, so once we can tell which marker is
  // ahead vs behind, this is authoritative: odd-numbered routes run
  // nominally north-south (ascending = Northbound, descending =
  // Southbound); even-numbered ones run nominally east-west (ascending =
  // Eastbound, descending = Westbound).
  //
  // Uses whatever bearing estimate we have, even a not-yet-"stable"
  // (unconfirmed) one — this is a one-shot direction check, not the
  // ahead/behind camera math that genuinely needs stability to avoid
  // flicker, so there's no reason to wait for full bearing confirmation.
  const bearingGuess = lastStableBearing != null ? lastStableBearing : pendingBearing;
  if (bearingGuess != null) {
    const withProjection = candidates
      .filter(c => c.lat != null && c.lon != null)
      .map(c => {
        const bearingToMarker = bearingDeg(lat, lon, c.lat, c.lon);
        const angle = angleDiff(bearingToMarker, bearingGuess);
        return { ...c, proj: c.dist * Math.cos(toRad(angle)) }; // + ahead, - behind
      });
    const ahead = withProjection.filter(c => c.proj > 0).sort((a, b) => a.proj - b.proj)[0];
    const behind = withProjection.filter(c => c.proj <= 0).sort((a, b) => b.proj - a.proj)[0];
    if (ahead && behind && ahead.mp !== behind.mp) {
      const ascending = ahead.mp > behind.mp;
      highwayDirectionLabel = matched.parsedForRef.isEven
        ? (ascending ? 'Eastbound' : 'Westbound')
        : (ascending ? 'Northbound' : 'Southbound');
    }
  }

  mmValueEl.textContent = currentMilepost.toFixed(1);
  mmSignEl.style.display = 'flex';
  updateHighwayShields(tryRefs);
  refreshShieldDirections();
  setDebug({
    milepost: currentMilepost,
    milepostRef: matched.ref,
    direction: highwayDirectionLabel,
    directionSource: matched.bearingDirection ? 'GPS bearing' : 'carried over (bearing not stable)',
    bearing: lastStableBearing,
    candidateCount: candidates.length,
    snapped: candidates[0].dist <= MM_SNAP_RADIUS_M,
  });
}
