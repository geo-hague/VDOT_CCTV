// 01_state.js — Shared mutable state and cached DOM element references
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- State ----------
let allCameras = [];
let currentHighway = null;      // array of normalized refs currently locked, e.g. ["I-85"] or ["I-40","I-85"]
let pendingHighway = null;
let pendingHighwayCount = 0;
let currentDirectionLabel = null; // "Northbound" | "Southbound" | "Eastbound" | "Westbound"
let lastStableBearing = null;
let pendingBearing = null;
let pendingBearingCount = 0;
let posHistory = [];            // [{lat,lon,t}]
let lastHighwayCheck = 0;
let highwayCheckSeq = 0; // bumped on every new snapToHighway request
let highwayCheckAppliedSeq = 0; // seq of the last response we actually applied;
                          // a response only gets discarded if a newer one already
                          // beat it to being applied, not just because a newer
                          // request was fired while this one was still in flight
let overpassFailStreak = 0; // consecutive Overpass failures (network error, non-2xx, incl. 429) — drives exponential backoff so a rate-limit doesn't just get hammered again 6s later

// Mile marker / state-DOT-convention direction (Eastbound/Northbound/etc, derived
// from ascending/descending mileposts) — separate from currentDirectionLabel
// above, which is a raw compass bearing used only for camera ahead/behind math.
let currentMilepost = null;
let lastMilepostRef = null; // which ref (e.g. "I-95") currentMilepost belongs to — trend comparison
                             // between readings is only meaningful on the same ref
let lastMilepostCheck = 0;
let highwayDirectionLabel = null; // "Eastbound" | "Northbound" | "Southbound" | "Westbound"
let shieldGroupRefs = null;      // normalized ref list the shield group currently shows
let shieldDirEls = {};           // ref -> its direction-label element, so direction text
                                  // can be refreshed without rebuilding/re-fetching shields

// Message signs (DMS)
let messageSigns = [];
let lastMsgSignFetch = 0;
let activeSignId = null;
let lastSpokenMessage = null;

// ---------- DOM ----------
const gpsDot = document.getElementById('gps-dot');
const gpsText = document.getElementById('gps-text');
const speedValueEl = document.getElementById('speed-value');
const highwayText = document.getElementById('highway-text');
const shieldGroupEl = document.getElementById('shield-group');
const mmSignEl = document.getElementById('mile-marker-sign');
const mmValueEl = document.getElementById('mm-value');
const msgBannerEl = document.getElementById('msg-sign-banner');
const slotEls = [document.getElementById('slot-0'), document.getElementById('slot-1')];
const debugContent = document.getElementById('debug-content');

// setDebug merges into a persistent debugState rather than replacing the
// panel outright — several independent subsystems (highway tracking, DMS,
// etc.) call this on their own schedules, and an overwrite-based version
// meant whichever one last ran won, silently hiding the others' output
// (e.g. DMS's once-per-30s debug getting stomped within a second or two by
// the much more frequent highway/camera tracking debug).
let debugState = {};
function setDebug(obj) {
  Object.assign(debugState, obj);
  debugContent.textContent = JSON.stringify(debugState, null, 2);
}

