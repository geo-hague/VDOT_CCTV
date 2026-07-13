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

    const msgText = textOf(rec, 'dms-current-message-text');
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

function pickActiveMessageSign(lat, lon) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length) return null;

  const dirMatches = (s) => {
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
  };

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
        dirMatched: dirMatches(x.s),
        roadwayMatched: currentHighway.some(h => (x.s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
          || (x.s.Roadway || '').toUpperCase().includes(h)),
        distMi: Math.round(x.dist / 160.934) / 10,
      }));
    if (nearbyForDebug.length) {
      console.log('[DMS debug] our direction:', highwayDirectionLabel, 'currentHighway:', currentHighway, nearbyForDebug);
    }
  }

  const candidates = messageSigns
    .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
    .filter(s => dirMatches(s))
    .filter(s => currentHighway.some(h => (s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
      || (s.Roadway || '').toUpperCase().includes(h)))
    .map(s => {
      const straightDist = haversineMeters(lat, lon, s.Latitude, s.Longitude);
      const bearingToSign = bearingDeg(lat, lon, s.Latitude, s.Longitude);
      const dist = lastStableBearing === null
        ? straightDist
        : straightDist * Math.cos(toRad(angleDiff(bearingToSign, lastStableBearing)));
      return { sign: s, dist };
    })
    .filter(c => c.dist >= -SWAP_BUFFER_M && c.dist <= MSG_SIGN_RANGE_M);

  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.length ? candidates[0] : null;
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
  const active = pickActiveMessageSign(lat, lon);

  if (!active) {
    msgBannerEl.style.display = 'none';
    activeSignId = null;
    return;
  }

  const msgText = active.sign.Messages.join(' • ');
  msgBannerEl.innerHTML = '';
  const main = document.createElement('div');
  main.textContent = msgText;
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = `${formatDistance(Math.max(0, active.dist))} ahead`;
  msgBannerEl.appendChild(main);
  msgBannerEl.appendChild(meta);
  msgBannerEl.style.display = 'block';

  // Speak only when this is a genuinely new sign/message, not every poll.
  const signKey = active.sign.Id + '::' + msgText;
  if (signKey !== activeSignId && msgText !== lastSpokenMessage) {
    speakMessage(msgText);
    lastSpokenMessage = msgText;
  }
  activeSignId = signKey;
}
