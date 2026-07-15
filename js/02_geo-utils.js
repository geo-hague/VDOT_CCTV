// 02_geo-utils.js — Generic geo math helpers, highway-name normalization, camera list loading
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Geo helpers ----------
function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function bearingToCompassLabel(bearing) {
  // Map to the 4 cardinal "of travel" labels most state DOT feeds use.
  if (bearing >= 315 || bearing < 45) return 'Northbound';
  if (bearing >= 45 && bearing < 135) return 'Eastbound';
  if (bearing >= 135 && bearing < 225) return 'Southbound';
  return 'Westbound';
}

// ---------- Highway name normalization ----------
function formatDistance(meters) {
  const miles = meters / 1609.34;
  return `${miles.toFixed(1)} mi`;
}

function normalizeHighwayName(raw) {
  if (!raw) return null;
  const s = raw.toUpperCase().trim();
  // Interstate: "I-40", "I 40", "Interstate 40"
  let m = s.match(/\bI[-\s]?(\d+)\b/) || s.match(/INTERSTATE\s+(\d+)/);
  if (m) return `I-${m[1]}`;
  // US Highway: "US-74", "US 74", "US Highway 74"
  m = s.match(/\bUS[-\s]?(\d+)\b/);
  if (m) return `US-${m[1]}`;
  // NC Highway: "NC-16", "NC 16"
  m = s.match(/\bNC[-\s]?(\d+)\b/);
  if (m) return `NC-${m[1]}`;
  // VA Highway: "VA-286", "VA 286", "SR-286" (VA 511's camera feed uses
  // "VA-", state DOT feeds sometimes use "SR-" for the same routes)
  m = s.match(/\bVA[-\s]?(\d+)\b/) || s.match(/\bSR[-\s]?(\d+)\b/);
  if (m) return `VA-${m[1]}`;
  // No route-number pattern matched (e.g. "Wade Avenue") — fall back to
  // the literal name, uppercased/trimmed so the VA camera feed's "route"
  // field and OSM's "name" tag compare equal as long as they're spelled
  // the same way.
  return s;
}

// ---------- Load static camera list ----------
// VA 511's feed is GeoJSON (FeatureCollection of Point features), not the
// flat { cameras: [...] } shape NC's static file uses — normalize here so
// every other file (03_highway.js, 05_cameras.js) can stay unchanged and
// just deal with { id, lat, lon, roadway, direction, location, videoUrl }.
async function loadCameras() {
  try {
    const resp = await fetch(CAMERAS_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const geojson = await resp.json();
    const features = geojson.features || [];

    allCameras = features
      .filter(f => {
        const p = f.properties || {};
        return p.active !== false && !p.problem_stream && !!p.https_url;
      })
      .map(f => {
        const p = f.properties || {};
        const coords = (f.geometry && f.geometry.coordinates) || [];
        const lon = parseFloat(coords[0]);
        const lat = parseFloat(coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          id: p.id ?? p.name,
          lat, lon,
          roadway: p.route || '',
          direction: p.direction || '',
          location: p.description || p.name || '',
          videoUrl: p.https_url,   // HLS (.m3u8) — plays via the existing hls.js wiring in 05_cameras.js
        };
      })
      .filter(c => c !== null);

    console.log(`Loaded ${allCameras.length} VA cameras.`);
  } catch (err) {
    // Camera load failing (CORS block, network error, endpoint down, etc.)
    // must NOT stop the rest of the app from starting — init() awaits this
    // function, so an uncaught throw here would silently kill GPS watching
    // and the simulation button along with it. Fail loud in the debug
    // panel instead, and keep going with an empty camera list.
    allCameras = [];
    setDebug({ camerasLoadError: err.message });
    console.error('Failed to load VA cameras:', err);
  }
}

