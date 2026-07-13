// 04_messagesigns.js — VDOT DMS (message sign) fetching, matching, banner + speech
// Part of the VA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- DMS message signs (via proxy) ----------
async function fetchMessageSignsIfNeeded() {
  const now = Date.now();
  if (now - lastMsgSignFetch < MSG_SIGN_POLL_MS) return;
  lastMsgSignFetch = now;
  if (!MSG_SIGN_PROXY_URL || MSG_SIGN_PROXY_URL.includes('YOUR-WORKER-SUBDOMAIN')) {
    setDebug({ messageSigns: 'DMS not configured yet — VA SmarterRoads dataset/proxy pending' });
    return;
  }
  try {
    const resp = await fetch(MSG_SIGN_PROXY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    messageSigns = await resp.json();
    if (!Array.isArray(messageSigns)) throw new Error('unexpected response shape: ' + JSON.stringify(messageSigns).slice(0, 200));
  } catch (err) {
    setDebug({ messageSigns: `proxy fetch failed: ${err.message}` });
  }
}

// Some DMS entries report DirectionOfTravel as "Unknown" (or omit it
// entirely) even though the sign's own Name encodes it, e.g. "DMS13-I40-60W"
// is westbound. Only used as a fallback — DirectionOfTravel is trusted
// whenever it actually says something. Only Name is checked — other fields
// like Id can also contain "DMS" without actually encoding direction.
function directionFromSignId(s) {
  const map = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound' };
  if (typeof s.Name !== 'string') return null;
  const m = /([NSEW])\s*[)\]]*\s*$/i.exec(s.Name.trim());
  return m ? map[m[1].toUpperCase()] : null;
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
