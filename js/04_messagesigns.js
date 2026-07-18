// 04_messagesigns.js — VDOT DMS (message sign) fetching, matching, banner + speech
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- DMS message signs (via proxy) ----------
// VA's feed is XML (TMDD/IEEE-1512-flavored), not JSON — fetched as text
// and parsed below into the same shape the rest of this file already
// expects: { Id, Name, Roadway, DirectionOfTravel, Latitude, Longitude, Messages }.
async function fetchMessageSignsIfNeeded() {
  const now = Date.now();
  if (now - lastMsgSignFetch < MSG_SIGN_POLL_MS) return;
  lastMsgSignFetch = now;
  if (!MSG_SIGN_PROXY_URL || MSG_SIGN_PROXY_URL.includes('YOUR-WORKER-SUBDOMAIN')) {
    setDebug({ messageSigns: 'DMS proxy not configured yet — deploy messagesigns-worker/ and update the constant' });
    return;
  }
  try {
    const resp = await fetch(MSG_SIGN_PROXY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xmlText = await resp.text();
    messageSigns = parseTmddSigns(xmlText);
  } catch (err) {
    setDebug({ messageSigns: `proxy fetch failed: ${err.message}` });
  }
}

// ---------- TMDD/IEEE-1512 XML parsing ----------
// The feed's real element nesting is only partially confirmed (we've seen
// the im:incidentLoc block — locationName/miDec/travelDirection/lat/lon —
// but not yet a live sample of the flat dms-* message fields alongside it).
// So rather than hard-code an exact path, this walks each record's whole
// subtree looking for each field by local tag name (namespace-prefix
// agnostic), and is defensive about anything coming back missing. If
// messages aren't showing up, check the Debug panel — dmsRecordCount and
// dmsSampleFields below show exactly what was found per record so the
// field lookups here can be corrected against real data.
function localName(el) {
  return el.localName || el.nodeName.split(':').pop();
}

function findDescendant(root, tagLocalName) {
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (localName(all[i]) === tagLocalName) return all[i];
  }
  return null;
}

function textOf(root, tagLocalName) {
  const el = findDescendant(root, tagLocalName);
  return el && el.textContent.trim() !== '' ? el.textContent.trim() : null;
}

// dms-current-message-text is explicitly documented by VDOT as NOT
// including line/page break info — it's every line concatenated with
// nothing between them ("LEFT LANEFOR PASSING..."). The real formatting
// lives in dms-current-message: a base64-encoded NTCIP 1203 MULTI markup
// string, where [nlX]/[np...] mark line/page breaks and other bracketed
// tags ([foX], [jlX], [cwX], etc.) are font/justify/color formatting we
// don't need. Decode that instead and turn line/page breaks into spaces
// for a single-line banner; strip every other bracketed tag entirely.
function decodeMultiMessage(base64) {
  if (!base64) return null;
  let raw;
  try {
    raw = atob(base64.trim());
  } catch (err) {
    return null;
  }
  return raw
    .replace(/\[np\d*\]/gi, ' ')   // new page
    .replace(/\[nl\d*\]/gi, ' ')   // new line
    .replace(/\[[^\]]*\]/g, '')    // any other MULTI tag (font/justify/color/etc.) — strip, not a line break
    .replace(/\s+/g, ' ')
    .trim() || null;
}

const TMDD_DIR_MAP = { north: 'Northbound', south: 'Southbound', east: 'Eastbound', west: 'Westbound' };

function parseTmddSigns(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseErr = doc.getElementsByTagName('parsererror')[0];
  if (parseErr) throw new Error('XML parse error: ' + parseErr.textContent.slice(0, 200));

  // Each sign's record — confirmed from the one sample we've seen (a
  // malfunctioning sign) to be an <im:incidentDescription> block containing
  // im:incidentLoc (location) directly. Assumed, not yet confirmed, that
  // operating signs' dms-* message fields live in the same block.
  const records = Array.from(doc.getElementsByTagName('*')).filter(el => localName(el) === 'incidentDescription');

  const parsed = records.map(rec => {
    const lat = textOf(rec, 'latitude');
    const lon = textOf(rec, 'longitude');
    const dir = textOf(rec, 'travelDirection');
    const locationName = textOf(rec, 'locationName'); // e.g. "I-95N" — route + direction packed together
    const roadway = locationName ? locationName.replace(/[NSEW]$/i, '') : null;

    const msgTextRaw = decodeMultiMessage(textOf(rec, 'dms-current-message'));
    const msgText = msgTextRaw || textOf(rec, 'dms-current-message-text'); // fallback if base64 missing/undecodable — no line breaks in this field, so lines may run together
    const dmsOn = textOf(rec, 'dms-device-status') === 'on';

    return {
      Id: textOf(rec, 'device-id') || textOf(rec, 'device-native-id') || textOf(rec, 'senderIncidentID'),
      Name: textOf(rec, 'device-public-name') || textOf(rec, 'device-name'),
      Roadway: roadway,
      DirectionOfTravel: dir ? (TMDD_DIR_MAP[dir.toLowerCase()] || null) : null,
      Latitude: lat != null ? parseFloat(lat) / 1e6 : null,   // millionths of degrees, per the field docs
      Longitude: lon != null ? parseFloat(lon) / 1e6 : null,
      Messages: (dmsOn && msgText) ? [msgText] : ['NO_MESSAGE'],
      communicationStatus: textOf(rec, 'deviceStatus'),        // kept for debugging, not used for matching
      deviceType: textOf(rec, 'device-type'),                  // "VMS", "LCS", "LUS", "VSL", "Arrow Board"
    };
  }).filter(s => s.Latitude != null && s.Longitude != null)
    // Only real text DMS (VMS) — exclude Variable Speed Limit signs, lane
    // control signals, arrow boards, etc., which show numbers/symbols, not
    // travel advisories. deviceType is missing on some records (unconfirmed
    // field placement, same caveat as elsewhere), so don't drop those —
    // only exclude a record when we positively know it's non-VMS.
    .filter(s => !s.deviceType || s.deviceType.toUpperCase() === 'VMS');

  setDebug({
    dmsRecordCount: records.length,
    dmsParsedCount: parsed.length,
    dmsWithMessages: parsed.filter(s => s.Messages[0] !== 'NO_MESSAGE').length,
    dmsSample: parsed.slice(0, 3), // check this against real sign data if messages don't show up
  });

  return parsed;
}

// Some DMS entries report DirectionOfTravel as "Unknown" (or omit it
// entirely) even though the sign's own Name encodes it, e.g. "DMS13-I40-60W"
// is westbound. Only used as a fallback — DirectionOfTravel is trusted
// whenever it actually says something. Only Name is checked — other fields
// like Id can also contain "DMS" without actually encoding direction.
// VA's device-name/device-public-name spells direction out as a full word
// mid-string (e.g. "I-29 East Marker 148.41"), unlike NC's trailing-letter
// convention (e.g. "DMS13-I40-60W"). Try both: a whole cardinal word first
// (VA's style), then a trailing letter (kept in case some VA signs use it).
function directionFromSignId(s) {
  const map = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound' };
  if (typeof s.Name !== 'string') return null;
  const name = s.Name.trim();
  const wordMatch = /\b(North|South|East|West)\b/i.exec(name);
  if (wordMatch) return map[wordMatch[1][0].toUpperCase()];
  const letterMatch = /([NSEW])\s*[)\]]*\s*$/i.exec(name);
  return letterMatch ? map[letterMatch[1].toUpperCase()] : null;
}

// Extracted from the old inline dirMatches()/roadway-check so both the
// live "closest sign" pick and manual ahead/behind browsing use the exact
// same eligibility rules — otherwise browsing could show a sign live
// detection would never have picked (or vice versa), which would be a
// confusing inconsistency.
function messageSignDirMatches(s) {
  if (!highwayDirectionLabel) return false; // our own direction isn't known yet — can't confirm
                                              // a directional sign applies to us, so don't show it
  const signDir = s.DirectionOfTravel;
  if (signDir && signDir !== 'None' && signDir !== 'Unknown') {
    if (signDir === 'All Directions' || signDir === 'Both Directions') return true;
    return signDir === highwayDirectionLabel;
  }
  // DirectionOfTravel is missing/None/Unknown — fall back to the sign ID's
  // trailing N/S/E/W letter instead of refusing to show the sign at all.
  const inferred = directionFromSignId(s);
  return inferred ? inferred === highwayDirectionLabel : false;
}

function messageSignRoadwayMatches(s) {
  return currentHighway.some(h => (s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
    || (s.Roadway || '').toUpperCase().includes(h));
}

// Direction+roadway-filtered, signed-distance-scored, sorted-nearest-first
// list of active (non-blank) message signs — shared basis for both the
// live "closest" pick and manual browsing. minDist/maxDist let callers use
// a tight window (live: a small negative buffer so a sign doesn't vanish
// the instant you pass it) or the full symmetric range (browsing: can page
// backward the same distance it can page forward), mirroring
// getScoredCameras() in 05_cameras.js.
function getScoredMessageSigns(lat, lon, minDist, maxDist) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length || !highwayDirectionLabel) return [];

  return messageSigns
    .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
    .filter(messageSignDirMatches)
    .filter(messageSignRoadwayMatches)
    .map(s => {
      const straightDist = haversineMeters(lat, lon, s.Latitude, s.Longitude);
      const bearingToSign = bearingDeg(lat, lon, s.Latitude, s.Longitude);
      const dist = lastStableBearing === null
        ? straightDist
        : straightDist * Math.cos(toRad(angleDiff(bearingToSign, lastStableBearing)));
      return { sign: s, dist };
    })
    .filter(c => c.dist >= minDist && c.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist);
}

function pickActiveMessageSign(lat, lon) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length) return null;

  if (highwayDirectionLabel) {
    const nearbyForDebug = messageSigns
      .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
      .map(s => ({ s, dist: haversineMeters(lat, lon, s.Latitude, s.Longitude) }))
      .filter(x => x.dist <= MSG_SIGN_RANGE_M)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map(x => ({
        raw: x.s, // full object — check this if the field name assumptions above are wrong
        Roadway: x.s.Roadway,
        DirectionOfTravel: x.s.DirectionOfTravel,
        inferredDirection: directionFromSignId(x.s),
        dirMatched: messageSignDirMatches(x.s),
        roadwayMatched: messageSignRoadwayMatches(x.s),
        distMi: Math.round(x.dist / 160.934) / 10,
      }));
    if (nearbyForDebug.length) {
      console.log('[DMS debug] our direction:', highwayDirectionLabel, 'currentHighway:', currentHighway, nearbyForDebug);
    }
  }

  const scored = getScoredMessageSigns(lat, lon, -SWAP_BUFFER_M, MSG_SIGN_RANGE_M);
  return scored.length ? scored[0] : null;
}

// ---------- Manual ahead/behind DMS browsing ----------
// Lets you page through message signs further out than the live nearest
// match, without changing what the live auto-detected banner (and its
// one-time speech) shows — mirrors the camera browse pattern in
// 06_browse.js. Snapshots the sign list at the moment you first press a
// button (using your last known position), then Ahead/Behind just walk an
// index through that snapshot. Only ever includes signs with an active
// message (a page full of "no message" signs would be clutter, not
// information) and stays direction-filtered, same eligibility rules as
// live detection via getScoredMessageSigns() above.
let msgBrowseActive = false;
let msgBrowseList = [];
let msgBrowseIndex = 0;

function enterMsgBrowseIfNeeded() {
  if (msgBrowseActive || !lastKnownPos) return false;
  // Uses BROWSE_RANGE_M (same ~50mi range camera browsing uses) rather
  // than the tighter MSG_SIGN_RANGE_M live-detection radius — browsing
  // should be able to scan as far ahead as camera browsing does; live
  // auto-detection stays at its original tighter range so a random sign
  // 50 miles out doesn't trigger the live banner/speech.
  const list = getScoredMessageSigns(lastKnownPos.lat, lastKnownPos.lon, -BROWSE_RANGE_M, BROWSE_RANGE_M);
  if (!list.length) return false;
  // Start browsing from whichever sign is currently closest to your actual
  // position, so the first tap moves logically forward/back from where
  // you already are rather than jumping to the list's edge.
  let closestIdx = 0, closestAbs = Infinity;
  list.forEach((s, i) => { const a = Math.abs(s.dist); if (a < closestAbs) { closestAbs = a; closestIdx = i; } });
  msgBrowseList = list;
  msgBrowseIndex = closestIdx;
  msgBrowseActive = true;
  return true;
}

function moveMsgAhead() {
  const justEntered = enterMsgBrowseIfNeeded();
  if (!msgBrowseActive) return;
  if (!justEntered) msgBrowseIndex = Math.min(msgBrowseIndex + 1, Math.max(0, msgBrowseList.length - 1));
  updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

function moveMsgBehind() {
  const justEntered = enterMsgBrowseIfNeeded();
  if (!msgBrowseActive) return;
  if (!justEntered) msgBrowseIndex = Math.max(msgBrowseIndex - 1, 0);
  updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

function exitMsgBrowse() {
  msgBrowseActive = false;
  msgBrowseList = [];
  msgBrowseIndex = 0;
  if (lastKnownPos) updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

// Shows/hides the small ◀ Closest ▶ controls row. Kept deliberately
// minimal (mobile real estate) — hidden entirely unless there's at least
// one sign to browse to, so it adds zero footprint on quiet stretches of
// highway. The middle button is a static "Closest" label that returns to
// live tracking, matching the camera scan bar's "Closest Cam" button.
function renderMessageBrowseControls(hasBrowsableSigns) {
  const controls = document.getElementById('msg-scan-controls');
  if (!controls) return; // markup not present — degrade silently rather than throw
  const counter = document.getElementById('msg-scan-counter-btn');
  const behindBtn = document.getElementById('msg-scan-behind-btn');
  const aheadBtn = document.getElementById('msg-scan-ahead-btn');

  if (!hasBrowsableSigns && !msgBrowseActive) {
    controls.style.display = 'none';
    return;
  }
  controls.style.display = '';
  counter.textContent = 'Closest';
  counter.classList.toggle('active', msgBrowseActive);
  if (msgBrowseActive) {
    behindBtn.disabled = msgBrowseIndex <= 0;
    aheadBtn.disabled = msgBrowseIndex >= msgBrowseList.length - 1;
  } else {
    behindBtn.disabled = false; // live mode's arrows always just START browsing from here
    aheadBtn.disabled = false;
  }
}

function speakMessage(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel(); // don't stack overlapping announcements
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn('Speech synthesis failed:', err);
  }
}

async function updateMessageBanner(lat, lon) {
  await fetchMessageSignsIfNeeded();

  // Falls back to writing straight into msgBannerEl if the
  // #msg-banner-content wrapper isn't in index.html — browsing controls
  // just won't appear until that markup's in place, but the existing live
  // message display keeps working either way.
  const contentEl = document.getElementById('msg-banner-content') || msgBannerEl;

  let active, isLive, hasBrowsableSigns;
  if (msgBrowseActive) {
    active = msgBrowseList[msgBrowseIndex] || null;
    isLive = false;
    hasBrowsableSigns = msgBrowseList.length > 0;
  } else {
    active = pickActiveMessageSign(lat, lon);
    isLive = true;
    // Same wide BROWSE_RANGE_M used to populate browsing, just to decide
    // whether the arrows are worth showing at all right now.
    hasBrowsableSigns = getScoredMessageSigns(lat, lon, -BROWSE_RANGE_M, BROWSE_RANGE_M).length > 0;
  }

  renderMessageBrowseControls(hasBrowsableSigns);

  if (!active) {
    msgBannerEl.style.display = 'none';
    if (isLive) activeSignId = null;
    return;
  }

  const msgText = active.sign.Messages.join(' • ');
  contentEl.innerHTML = '';
  const main = document.createElement('div');
  main.textContent = msgText;
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = isLive
    ? `${formatDistance(Math.max(0, active.dist))} ahead`
    : `${formatDistance(Math.abs(active.dist))} ${active.dist >= 0 ? 'ahead' : 'behind'}`;
  contentEl.appendChild(main);
  contentEl.appendChild(meta);
  msgBannerEl.style.display = 'block';

  // Speak only for the live, auto-detected sign — never while manually
  // browsing — and only when it's a genuinely new sign/message, not every poll.
  if (isLive) {
    const signKey = active.sign.Id + '::' + msgText;
    if (signKey !== activeSignId && msgText !== lastSpokenMessage) {
      speakMessage(msgText);
      lastSpokenMessage = msgText;
    }
    activeSignId = signKey;
  }
}
