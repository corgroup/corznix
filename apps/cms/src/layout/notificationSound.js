// Short alert sounds for the notification bell, synthesised with Web Audio so
// there is no audio file to ship or fail to load. Browsers keep audio locked
// until the page has had a click or key press: unlockNotificationSound() runs
// on the first one, and a sound due before that stays silent.

const PREF_KEY = 'cms.notifications.sound';
const LAST_KEY = 'cms.notifications.sound.last';

// Each note is [frequency Hz, start s, length s].
const TONES = {
  // New order: bright rising pair (E5 → B5).
  order: { type: 'triangle', gain: 0.25, notes: [[659.25, 0, 0.14], [987.77, 0.12, 0.3]] },
  // New message: short soft pop (A5 → D6).
  message: { type: 'sine', gain: 0.28, notes: [[880, 0, 0.1], [1174.66, 0.09, 0.18]] },
  // Service alert: low two-tone, played twice (C5 / G4).
  service: { type: 'square', gain: 0.07, notes: [[523.25, 0, 0.16], [392, 0.18, 0.16], [523.25, 0.4, 0.16], [392, 0.58, 0.24]] },
};

let ctx = null;
function audioContext() {
  if (ctx) return ctx;
  const AudioCtor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!AudioCtor) return null;
  ctx = new AudioCtor();
  return ctx;
}

export function unlockNotificationSound() {
  const c = audioContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function soundEnabled() {
  try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; }
}

export function setSoundEnabled(on) {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* kept for this page only */ }
}

function schedule(c, tone) {
  const t0 = c.currentTime + 0.02;
  for (const [freq, at, len] of tone.notes) {
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = tone.type;
    osc.frequency.setValueAtTime(freq, t0 + at);
    amp.gain.setValueAtTime(0.0001, t0 + at);
    amp.gain.exponentialRampToValueAtTime(tone.gain, t0 + at + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
    osc.connect(amp).connect(c.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + len + 0.02);
  }
}

/**
 * Plays one alert. `onceFor` (a notification id) keeps several open CMS tabs
 * from all playing the same notification: the first tab to see it plays it.
 */
export function playNotificationSound(kind, { onceFor = null } = {}) {
  const tone = TONES[kind];
  const c = audioContext();
  if (!tone || !c) return;
  if (onceFor) {
    try {
      if (localStorage.getItem(LAST_KEY) === onceFor) return;
      localStorage.setItem(LAST_KEY, onceFor);
    } catch { /* no storage: this tab plays it */ }
  }
  if (c.state === 'running') { schedule(c, tone); return; }
  c.resume().then(() => { if (c.state === 'running') schedule(c, tone); }).catch(() => {});
}
