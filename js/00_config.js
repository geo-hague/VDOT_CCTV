// 00_config.js — Configuration constants (Overpass, camera feed, DMS proxy, tuning params)
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Config ----------
// Public, unauthenticated GeoJSON feed — the same one 511.vdot.virginia.gov's
// own map calls. No account/API key needed.
const CAMERAS_URL = 'https://511.vdot.virginia.gov/services/map/layers/map/cams';
const MIN_DISPLACEMENT_M = 40;     // min movement before recomputing bearing
const BEARING_DISAGREE_DEG = 45;   // how much new bearing must differ to challenge current direction
const BEARING_CONFIRM_COUNT = 2;   // consecutive disagreeing samples needed to flip direction
const HIGHWAY_RECHECK_MS = 6000;   // re-run highway snap at most this often (base rate — backs off on repeated failures, see overpassFailStreak in 01_state.js)
const HIGHWAY_RECHECK_MAX_MS = 90000; // cap for the exponential backoff below, so we never go longer than 90s between attempts even during a sustained outage/rate-limit
const HIGHWAY_CONFIRM_COUNT = 2;   // consecutive matching reads needed before switching displayed highway
const MAX_SEARCH_DIST_M = 24140.2; // ~15 miles — cameras farther than this on your highway are ignored
const SWAP_BUFFER_M = 402.336;     // 1320 ft (1/4 mile) — a camera stays the displayed
                                    // "nearest"/"next" camera, counting down through negative
                                    // distance, until it's this far behind you
const BROWSE_RANGE_M = 80467;      // ~50 miles — how far the manual ahead/behind scan can look
const MANIFEST_TIMEOUT_MS = 12000; // if a stream hasn't started playing within this long, treat as stalled
const MAX_STREAM_RETRIES = 3;      // automatic retry attempts before showing a manual "tap to retry" button

// ---- Mile marker lookup ----
// VDOT's Mile Marker Signs FeatureServer. Route + direction are both packed
// into HTRIS_DEF (e.g. a route-number string with a trailing direction
// letter, zero-padded) rather than split cleanly like NCDOT's feed — see
// parseHtrisRoute() in 03_highway.js for the decode. There's also a
// separate DIR field that's used preferentially when it holds a real
// compass value, with the HTRIS_DEF suffix as fallback.
const MILEMARKER_QUERY_URL = 'https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services/Mile_Marker_Signs/FeatureServer/0/query';
const MILEMARKER_SEARCH_RADIUS_M = 900;  // ~0.56mi — wide enough to bracket the two nearest signs
const MILEMARKER_RECHECK_MS = 8000;      // how often we re-query for the current milepost

// ---- Highway shield images (Wikipedia / Wikimedia Commons) ----
// Special:FilePath redirects straight to the file, so it works as a plain
// <img src> with no API key or CORS preflight needed. We try a short list
// of likely filenames per route type and fall back silently if none load.
const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

// ---- VDOT SmarterRoads message signs (DMS), via a small proxy ----
// The feed is TMDD/IEEE-1512-flavored XML and needs a token, so — same
// reason as NC's DriveNC key — a static site can't call it directly without
// leaking the token. See messagesigns-worker/ for the Cloudflare Worker to
// deploy (free tier) and messagesigns-worker/README.md for setup. Point
// this at your deployed worker URL once it's live.
const MSG_SIGN_PROXY_URL = 'https://vdotdms.m-c-hunt429.workers.dev/';
const MSG_SIGN_RANGE_M = 16093.4;   // 10 miles
const MSG_SIGN_POLL_MS = 30000;     // re-poll signs this often so a sign 10mi out
                                     // can't silently change message before we reach it

