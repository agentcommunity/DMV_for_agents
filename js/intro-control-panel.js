/**
 * DEV control panel for intro tuning — gated behind ?tune only.
 * Writes to the shared introConfig object; calls intro.rebuild() for structural changes.
 * Delete this file + the single "// DEV-TUNE" line in app.js to remove completely.
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
  val.style.cssText = 'font-size:10px;color:#ccc;min-width:34px;text-align:right;';
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

// ─── Main export ─────────────────────────────────────────────────────────────

export function createIntroControlPanel({ config, intro, tv }) {
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
    'width:300px;max-height:90vh;overflow-y:auto;',
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
  closeBtn.addEventListener('click', () => panel.remove());
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

  const musicSelect = makeSelect(
    [['SUNRISE','at-sunrise'],['at-button-catch','at-button-catch'],['at-reveal','at-reveal']],
    config.music.startAt,
    (v) => {
      config.music.startAt = v;
      intro.rebuild();
    }
  );
  panel.appendChild(row('music start', musicSelect));

  const signSelect = makeSelect(
    [['at_reveal','at-reveal'],['after_delay','after-delay']],
    config.signReveal,
    (v) => {
      config.signReveal = v;
      intro.rebuild();
    }
  );
  panel.appendChild(row('sign reveal', signSelect));

  // ── Lamp arc speed (beat durations) ─────────────────────────────────
  panel.appendChild(header('Lamp arc speed'));

  const { wrap: sunriseWrap } = makeSlider(0.5, 5, config.beats.SUNRISE, 0.1, (v) => {
    config.beats.SUNRISE = v;
    intro.rebuild();
  });
  panel.appendChild(row('sunrise beat', sunriseWrap));

  const { wrap: arcStartWrap } = makeSlider(1, 8, config.beats.ARC_START, 0.1, (v) => {
    config.beats.ARC_START = v;
    intro.rebuild();
  });
  panel.appendChild(row('arc start beat', arcStartWrap));

  const { wrap: arcDurWrap } = makeSlider(1, 14, config.beats.ARC_DUR, 0.1, (v) => {
    config.beats.ARC_DUR = v;
    intro.rebuild();
  });
  panel.appendChild(row('arc duration', arcDurWrap));

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

  // Copy JSON button.
  let copyTimeout = null;
  const copyBtn = makeButton('Copy JSON', () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(config, null, 2)).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.style.color = '#4af';
        if (copyTimeout) clearTimeout(copyTimeout);
        copyTimeout = setTimeout(() => {
          copyBtn.textContent = 'Copy JSON';
          copyBtn.style.color = '';
        }, 1600);
      }).catch(() => {
        copyBtn.textContent = 'Failed';
        if (copyTimeout) clearTimeout(copyTimeout);
        copyTimeout = setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1600);
      });
    } catch {
      copyBtn.textContent = 'Failed';
    }
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
  return panel;
}
