/**
 * DEV control panel for intro tuning — loaded ONLY under ?tune. Self-contained: it owns the
 * `window.__*` debug handles and a `dispose()` that unhooks everything (so production never
 * touches it). Writes to the shared introConfig; calls intro.rebuild() for structural changes.
 *
 * To remove the whole tuning feature: delete this file + the two grep-tagged `// DEV-TUNE` blocks
 * in app.js (the ?tune localStorage-restore, and the ?tune dynamic-import line). Nothing else.
 *
 * Persistence: every control change saves config to localStorage ('dmv-intro-tune').
 * Replay reloads the page (restoring saved config), giving a true from-the-top replay.
 * Reset clears localStorage and reloads (restores factory defaults).
 */

// ─── flickerPreset helper ────────────────────────────────────────────────────
// Regenerates keyframes + catchAt from a (type, totalLength) pair.
// 'struggle' mirrors the prototype-approved pattern.
function flickerPreset(type, length) {
  const L = Number(length) || 1.5;
  switch (type) {
    case 'steady':
      // Single smooth ramp: one dim attempt, then catch.
      return {
        keyframes: [
          [0.00, 0.0, 0.01],
          [0.20, 0.45],
          [0.40, 0.0],
          [0.80, 1.00],
        ],
        catchAt: L * 0.70,
        catchDur: L * 0.28,
      };
    case 'rapid':
      // Several short blips — rapid-fire stutters.
      return {
        keyframes: [
          [0.00, 0.0, 0.01],
          [0.08, 0.20],
          [0.14, 0.0],
          [0.22, 0.35],
          [0.28, 0.0],
          [0.36, 0.55],
          [0.42, 0.0],
          [0.55, 0.75],
          [0.62, 0.08],
          [0.80, 1.00],
        ],
        catchAt: L * 0.78,
        catchDur: L * 0.20,
      };
    case 'single':
      // One hard catch — no preamble.
      return {
        keyframes: [
          [0.00, 0.0, 0.01],
          [0.60, 1.00],
        ],
        catchAt: L * 0.55,
        catchDur: L * 0.30,
      };
    case 'struggle':
    default:
      // Original prototype-approved pattern (scaled to length).
      return {
        keyframes: [
          [0.00, 0.0, 0.01],
          [L * 0.10, 0.30],
          [L * 0.20, 0.0],
          [L * 0.42, 0.60],
          [L * 0.52, 0.04],
          [L * 0.72, 1.00],
          [L * 0.80, 0.10],
        ],
        catchAt: L * 0.93,
        catchDur: L * 0.26,
      };
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function row(label, control) {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;';
  const lbl = document.createElement('label');
  lbl.style.cssText = 'flex:0 0 120px;font-size:10px;color:#aaa;text-align:right;';
  lbl.textContent = label;
  r.appendChild(lbl);
  r.appendChild(control);
  return r;
}

function header(text) {
  const h = document.createElement('div');
  h.style.cssText = 'margin:10px 0 4px;font-size:9px;letter-spacing:0.12em;color:#666;text-transform:uppercase;border-bottom:1px solid #333;padding-bottom:2px;';
  h.textContent = text;
  return h;
}

function makeSlider(min, max, value, step, onInput) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:5px;flex:1;';
  const s = document.createElement('input');
  s.type = 'range';
  s.min = min; s.max = max; s.step = step; s.value = value;
  s.style.cssText = 'flex:1;height:14px;accent-color:#4af;cursor:pointer;';
  const val = document.createElement('span');
  val.style.cssText = 'font-size:10px;color:#ccc;flex:0 0 44px;text-align:right;font-variant-numeric:tabular-nums;';
  val.textContent = Number(value).toFixed(step < 1 ? 2 : 0);
  s.addEventListener('input', () => {
    val.textContent = Number(s.value).toFixed(step < 1 ? 2 : 0);
    onInput(Number(s.value));
  });
  wrap.appendChild(s);
  wrap.appendChild(val);
  return { wrap, slider: s, valSpan: val };
}

function makeSelect(options, current, onChange) {
  const s = document.createElement('select');
  s.style.cssText = 'flex:1;background:#1a1a1a;color:#ccc;border:1px solid #333;padding:2px 4px;font-family:monospace;font-size:10px;cursor:pointer;';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === current) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function makeColorInput(current, onChange) {
  const c = document.createElement('input');
  c.type = 'color';
  c.value = current;
  c.style.cssText = 'flex:1;height:22px;border:none;background:none;cursor:pointer;padding:0;';
  c.addEventListener('input', () => onChange(c.value));
  return c;
}

function makeToggle(current, onChange) {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = current;
  chk.style.cssText = 'cursor:pointer;accent-color:#4af;';
  chk.addEventListener('change', () => onChange(chk.checked));
  label.appendChild(chk);
  const txt = document.createElement('span');
  txt.style.cssText = 'font-size:10px;color:#ccc;';
  txt.textContent = current ? 'on' : 'off';
  chk.addEventListener('change', () => { txt.textContent = chk.checked ? 'on' : 'off'; });
  label.appendChild(txt);
  return label;
}

function makeButton(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = 'background:#222;color:#ccc;border:1px solid #444;padding:3px 8px;font-family:monospace;font-size:10px;cursor:pointer;margin-right:4px;';
  b.addEventListener('click', onClick);
  return b;
}

// Robust "copy this text" — clipboard API, then execCommand, then ALWAYS show a
// selectable textarea so the user can grab it even when both copy paths are blocked
// (preview proxies are often not a secure/focused context, so clipboard.writeText fails).
function copyTextRobust(text) {
  let copied = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    copied = document.execCommand('copy');
    document.body.removeChild(ta);
  } catch { /* fall through */ }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {}).catch(() => {});
  }
  // Always present it for manual copy as the guaranteed path.
  const old = document.getElementById('introTuneJsonOverlay');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'introTuneJsonOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#111;border:1px solid #333;border-radius:6px;padding:12px;width:min(560px,90vw);font-family:monospace;';
  const msg = document.createElement('div');
  msg.style.cssText = 'color:#4af;font-size:11px;margin-bottom:6px;';
  msg.textContent = (copied ? '✓ Copied to clipboard. ' : '') + 'Select-all + copy below if needed:';
  const ta2 = document.createElement('textarea');
  ta2.value = text; ta2.readOnly = true;
  ta2.style.cssText = 'width:100%;height:300px;background:#0a0a0a;color:#ccc;border:1px solid #333;font-size:11px;resize:vertical;box-sizing:border-box;';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = 'margin-top:8px;background:#222;color:#ccc;border:1px solid #444;padding:4px 10px;cursor:pointer;font-family:monospace;';
  close.onclick = () => ov.remove();
  box.appendChild(msg); box.appendChild(ta2); box.appendChild(close);
  ov.appendChild(box);
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  ta2.focus(); ta2.select();
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function createIntroControlPanel({ config, intro, tv, audio, startIntroAudio, primeAudio }) {
  // Debug handles live HERE, not in app.js — the panel only loads under ?tune, so the production
  // `window` stays clean (no renderer/intro/audio internals exposed to third-party scripts).
  window.__tv = tv; window.__intro = intro;
  window.__audio = audio; window.__startIntroAudio = startIntroAudio; window.__primeAudio = primeAudio;

  // Ensure lamp intensity fields are present (introConfig.lamp ships them as of v2,
  // but guard against stale localStorage blobs that might be missing them).
  if (config.lamp.initialIntensity == null) config.lamp.initialIntensity = 0.52;
  if (config.lamp.midIntensity     == null) config.lamp.midIntensity     = 1.56;
  if (config.lamp.finalIntensity   == null) config.lamp.finalIntensity   = 2.60;

  // Persist entire config to localStorage so reloads (Replay) restore tuned values.
  function save() {
    try { localStorage.setItem('dmv-intro-tune', JSON.stringify(config)); } catch { /* quota/private */ }
  }

  // Panel container.
  const panel = document.createElement('div');
  panel.id = 'introTunePanel';
  panel.style.cssText = [
    'position:fixed;top:12px;right:12px;z-index:99999;',
    'width:344px;max-height:90vh;overflow-y:auto;',
    'background:rgba(10,10,12,0.92);backdrop-filter:blur(8px);',
    '-webkit-backdrop-filter:blur(8px);',
    'border:1px solid #2a2a2e;border-radius:4px;',
    'padding:10px 12px 14px;',
    'font-family:"Courier New",Courier,monospace;',
    'color:#ccc;',
    'box-shadow:0 4px 24px rgba(0,0,0,0.7);',
    'user-select:none;',
  ].join('');

  // Title bar.
  const titleBar = document.createElement('div');
  titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:11px;color:#4af;letter-spacing:0.10em;text-transform:uppercase;font-weight:bold;';
  title.textContent = '?tune  —  intro control panel';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close panel (does not remove ?tune)';
  closeBtn.style.cssText = 'background:none;border:none;color:#555;font-size:12px;cursor:pointer;padding:0 2px;';
  closeBtn.addEventListener('click', () => dispose());
  titleBar.appendChild(title);
  titleBar.appendChild(closeBtn);
  panel.appendChild(titleBar);

  // ── Button flicker ──────────────────────────────────────────────────
  panel.appendChild(header('Button flicker'));

  let currentFlickerType = config.flicker.type || 'struggle';
  let currentFlickerLen = (config.flicker.catchAt || 1.12) / 0.93; // invert the default ratio

  const flickerTypeSelect = makeSelect(
    [['struggle','struggle'],['steady','steady'],['rapid','rapid'],['single','single']],
    currentFlickerType,
    (v) => {
      currentFlickerType = v;
      const preset = flickerPreset(v, currentFlickerLen);
      config.flicker.type = v;
      config.flicker.keyframes = preset.keyframes;
      config.flicker.catchAt = preset.catchAt;
      config.flicker.catchDur = preset.catchDur;
      intro.rebuild();
    }
  );
  panel.appendChild(row('type', flickerTypeSelect));

  const { wrap: flickLenWrap } = makeSlider(0.4, 3.0, currentFlickerLen, 0.05, (v) => {
    currentFlickerLen = v;
    const preset = flickerPreset(currentFlickerType, v);
    config.flicker.keyframes = preset.keyframes;
    config.flicker.catchAt   = preset.catchAt;
    config.flicker.catchDur  = preset.catchDur;
    intro.rebuild();
  });
  panel.appendChild(row('length (s)', flickLenWrap));

  // ── Lamp ────────────────────────────────────────────────────────────
  panel.appendChild(header('Lamp'));

  // Intensity sliders are LIVE: driveArc() reads them each frame via p.initialIntensity etc.
  const { wrap: lampInitWrap } = makeSlider(0, 3, config.lamp.initialIntensity, 0.05, (v) => {
    config.lamp.initialIntensity = v; // live — no rebuild needed
  });
  panel.appendChild(row('initial intensity', lampInitWrap));

  const { wrap: lampMidWrap } = makeSlider(0, 6, config.lamp.midIntensity, 0.1, (v) => {
    config.lamp.midIntensity = v; // live
  });
  panel.appendChild(row('peak intensity', lampMidWrap));

  const { wrap: lampFinalWrap } = makeSlider(0, 6, config.lamp.finalIntensity, 0.1, (v) => {
    config.lamp.finalIntensity = v; // live
  });
  panel.appendChild(row('final intensity', lampFinalWrap));

  const lampColor = makeColorInput(config.lamp.color, (v) => {
    config.lamp.color = v; // LIVE — driveArc reads _volParams() each frame
  });
  panel.appendChild(row('color', lampColor));

  // ── Volumetric ──────────────────────────────────────────────────────
  panel.appendChild(header('Volumetric'));

  const { wrap: densityWrap } = makeSlider(0, 2.5, config.vol.density, 0.05, (v) => {
    config.vol.density = v; // LIVE
  });
  panel.appendChild(row('density', densityWrap));

  const { wrap: intensityWrap } = makeSlider(0, 3, config.vol.intensity, 0.05, (v) => {
    config.vol.intensity = v; // LIVE
  });
  panel.appendChild(row('intensity', intensityWrap));

  const { wrap: stepsWrap } = makeSlider(16, 96, config.vol.steps, 4, (v) => {
    config.vol.steps = v; // LIVE
  });
  panel.appendChild(row('steps', stepsWrap));

  const { wrap: maxDistWrap } = makeSlider(20, 100, config.vol.maxDist, 2, (v) => {
    config.vol.maxDist = v; // LIVE
  });
  panel.appendChild(row('max dist', maxDistWrap));

  const initExposure = tv.renderer ? tv.renderer.toneMappingExposure : 3.0;
  const { wrap: exposureWrap } = makeSlider(0.15, 3, initExposure, 0.05, (v) => {
    if (tv.renderer) tv.renderer.toneMappingExposure = v; // LIVE
  });
  panel.appendChild(row('exposure', exposureWrap));

  // ── Flow & timing ───────────────────────────────────────────────────
  panel.appendChild(header('Flow & timing'));

  const darkToggle = makeToggle(config.dark, (v) => {
    config.dark = v;
    intro.rebuild(); // structural: dark determines pre-black behaviour
  });
  panel.appendChild(row('go dark before menu', darkToggle));

  // Where the track's loud DROP lands relative to the default-scene reveal (the white light coming on).
  // 0 = drop exactly on the reveal; + = drop lands later; − = earlier. Auto-tracks any leg retuning.
  if (config.music.dropVsReveal == null) config.music.dropVsReveal = 0;
  const { wrap: dropSyncWrap } = makeSlider(-2, 2, config.music.dropVsReveal, 0.05, (v) => {
    config.music.dropVsReveal = v;
    intro.rebuild();
  });
  panel.appendChild(row('drop vs reveal (s)', dropSyncWrap));

  const { wrap: signDelayWrap } = makeSlider(
    0, 3, config.signRevealDelay != null ? config.signRevealDelay : 1.0, 0.1,
    (v) => {
      config.signRevealDelay = v;
      intro.rebuild(); // structural: shifts the wall-sign trigger in the timeline
    }
  );
  panel.appendChild(row('sign delay (s)', signDelayWrap));

  // ── Lamp timing ──────────────────────────────────────────────────────
  panel.appendChild(header('Lamp timing'));

  // Ensure timing block and nested leg objects exist (guard against stale localStorage blobs).
  if (!config.timing) config.timing = {};
  if (config.timing.leadIn  == null) config.timing.leadIn  = 0.4;
  if (config.timing.aBehind == null) config.timing.aBehind = 0.30;
  if (config.timing.aTop    == null) config.timing.aTop    = 0.65;
  if (!config.timing.sunrise || typeof config.timing.sunrise !== 'object')
    config.timing.sunrise = { length: 2.5, curve: 'decelerate' };
  if (config.timing.sunrise.length == null) config.timing.sunrise.length = 2.5;
  if (config.timing.sunrise.curve  == null) config.timing.sunrise.curve  = 'decelerate';
  if (!config.timing.rise || typeof config.timing.rise !== 'object')
    config.timing.rise = { length: 3.5, curve: 'constant' };
  if (config.timing.rise.length == null) config.timing.rise.length = 3.5;
  if (config.timing.rise.curve  == null) config.timing.rise.curve  = 'constant';
  if (!config.timing.crest || typeof config.timing.crest !== 'object')
    config.timing.crest = { length: 3.5, curve: 'decelerate' };
  if (config.timing.crest.length == null) config.timing.crest.length = 3.5;
  if (config.timing.crest.curve  == null) config.timing.crest.curve  = 'decelerate';

  const CURVE_OPTIONS = [
    ['constant',   'constant'],
    ['accelerate', 'accelerate'],
    ['decelerate', 'decelerate'],
    ['smooth',     'smooth'],
  ];

  // ① Lead-in
  const { wrap: leadInWrap } = makeSlider(0, 3, config.timing.leadIn, 0.05, (v) => {
    config.timing.leadIn = v;
    intro.rebuild();
  });
  panel.appendChild(row('lead-in (s)', leadInWrap));

  // ②③④ Arc legs — each is a length slider + a speed-curve select (same shape, three legs).
  const addLeg = (key, label) => {
    const leg = config.timing[key];
    const { wrap } = makeSlider(0.3, 10, leg.length, 0.1, (v) => { leg.length = v; intro.rebuild(); });
    panel.appendChild(row(`${label} length`, wrap));
    const sel = makeSelect(CURVE_OPTIONS, leg.curve, (v) => { leg.curve = v; intro.rebuild(); });
    panel.appendChild(row(`${label} curve`, sel));
  };
  addLeg('sunrise', 'sunrise');
  addLeg('rise', 'rise');
  addLeg('crest', 'crest');

  // ── Utility ─────────────────────────────────────────────────────────
  panel.appendChild(header('Utility'));

  // Replay button: persist current config then reload so the full intro plays
  // from the very top with the tuned settings (restore logic runs in app.js).
  const replayBtn = makeButton('Replay', () => {
    save();
    location.reload();
  });

  // Reset button: clear stored config and reload to restore factory defaults.
  const resetBtn = makeButton('Reset', () => {
    try { localStorage.removeItem('dmv-intro-tune'); } catch { /* private mode */ }
    location.reload();
  });
  resetBtn.style.color = '#f88';

  // Scrub arc slider.
  const gsap = window.gsap;
  let scrubbing = false;
  const { wrap: scrubWrap, slider: scrubSlider } = makeSlider(0, 1, 0, 0.005, (v) => {
    if (!scrubbing) return; // guard against programmatic value sets
    if (gsap) gsap.globalTimeline.pause();
    if (intro._S) intro._S.a = v;
  });
  scrubSlider.addEventListener('mousedown', () => { scrubbing = true; });
  scrubSlider.addEventListener('touchstart', () => { scrubbing = true; }, { passive: true });
  scrubSlider.addEventListener('mouseup', () => { scrubbing = false; });
  scrubSlider.addEventListener('touchend', () => { scrubbing = false; }, { passive: true });

  // Sync scrub display when arc changes externally (the GSAP tween drives intro._S.a).
  const scrubSync = () => {
    if (scrubbing) return;
    if (intro._S) scrubSlider.value = intro._S.a;
  };
  if (tv) tv.onRender(scrubSync); // DEV-TUNE: frame-sync scrub display

  // Copy JSON button — robust copy (clipboard → execCommand → always show a selectable textarea).
  const copyBtn = makeButton('Copy JSON', () => {
    copyTextRobust(JSON.stringify(config, null, 2));
  });

  const utilRow = document.createElement('div');
  utilRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';
  utilRow.appendChild(replayBtn);
  utilRow.appendChild(resetBtn);
  utilRow.appendChild(copyBtn);
  panel.appendChild(utilRow);

  const scrubLabel = document.createElement('div');
  scrubLabel.style.cssText = 'margin-top:6px;font-size:9px;color:#666;';
  scrubLabel.textContent = 'Scrub arc (pauses GSAP timeline):';
  panel.appendChild(scrubLabel);
  panel.appendChild(scrubWrap);

  // Bubble-phase listeners: ANY slider/select/toggle/color change auto-persists config.
  // MUST be bubble phase (not capture) so save() runs AFTER each control's own handler
  // mutates config — capture phase would serialize the pre-change value (off-by-one).
  panel.addEventListener('input',  save);
  panel.addEventListener('change', save);

  // Panel appended to body (not intro overlay) so it survives intro completion.
  document.body.appendChild(panel);

  // dispose() unhooks EVERYTHING the panel added: the per-frame scrub-sync render callback (which
  // was previously never removed → ran forever), the panel DOM, and the window debug handles. So
  // closing the panel leaves zero tendrils in the render loop or on `window`.
  function dispose() {
    if (tv) tv.offRender(scrubSync);
    panel.remove();
    delete window.__tv; delete window.__intro;
    delete window.__audio; delete window.__startIntroAudio; delete window.__primeAudio;
  }
  return dispose;
}
