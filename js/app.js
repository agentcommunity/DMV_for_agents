import { TV } from './TV.js?v=25';
import { AboutPoster } from './AboutPoster.js?v=16';
import { HoloCard } from './HoloCard.js?v=24';
import { WallSign } from './WallSign.js?v=2';
import { WallNumber } from './WallNumber.js?v=1';
import { insertRegistration } from './supabase.js?v=18';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;

// Permalink format: /c/CERT-ID/agentname
function parsePermalink() {
  const pathMatch = window.location.pathname.match(/^\/c\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!pathMatch) return null;
  return {
    certificateId: decodeURIComponent(pathMatch[1]),
    agentName: pathMatch[2] ? decodeURIComponent(pathMatch[2]) : '',
  };
}

function setShareHash(certificateId, agentName = '') {
  const name = encodeURIComponent(agentName || 'agent');
  history.replaceState(null, '', `/c/${encodeURIComponent(certificateId)}/${name}`);
}

const permalink = parsePermalink();

// Preload the GLB model only when we'll actually use it (not in permalink mode)
if (!permalink) {
  const preload = document.createElement('link');
  preload.rel = 'preload';
  preload.href = '/models/tv1.glb';
  preload.as = 'fetch';
  preload.crossOrigin = '';
  document.head.appendChild(preload);
}

const container = document.getElementById('canvasWrapper');
const label = document.getElementById('modeLabel');
const hiddenInput = document.getElementById('hiddenInput');
const aboutToggleLink = document.getElementById('aboutToggleLink');
const agentToggleLink = document.getElementById('agentToggleLink');
const agentView = document.getElementById('agentView');
const agentViewSkillContent = document.getElementById('agentViewSkillContent');
const aboutCursorHost = container;
const cardShareBar = document.getElementById('cardShareBar');
const cardShareBtn = document.getElementById('cardShareBtn');
const cardCopyBtn = document.getElementById('cardCopyBtn');
const cardSaveBtn = document.getElementById('cardSaveBtn');
const cardShareTicker = document.getElementById('cardShareTicker');
const appFavicon = document.getElementById('appFavicon');
const cliSnippet = document.getElementById('cliSnippet');
const terminalStatusBar = document.getElementById('terminalStatusBar');
const terminalStatusText = document.getElementById('terminalStatusText');
const crtAnnouncements = document.getElementById('crtAnnouncements');
const cliCommandMeta = document.querySelector('meta[name="agent:cli"]');
const turnstileContainer = document.getElementById('turnstile-container');
const turnstileSiteKeyMeta = document.querySelector('meta[name="dmv-turnstile-site-key"]');

const CANONICAL_ORIGIN = (() => {
  const raw = document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '';
  try {
    return new URL(raw, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
})();

const CLI_REGISTER_COMMAND = cliCommandMeta?.getAttribute('content')?.trim()
  || cliSnippet?.textContent.trim()
  || 'bunx dmv-agent register';
const DMV_TURNSTILE_ACTION = 'dmv_register';
const TURNSTILE_SCRIPT_ID = 'turnstile-api-script';

let turnstileWidgetId = null;
let turnstileApiPromise = null;
let turnstilePendingResolve = null;
let turnstilePendingReject = null;
let turnstilePendingTimeout = null;

function getTurnstileSiteKey() {
  return turnstileSiteKeyMeta?.getAttribute('content')?.trim() || '';
}

function clearTurnstilePending() {
  if (turnstilePendingTimeout) {
    clearTimeout(turnstilePendingTimeout);
    turnstilePendingTimeout = null;
  }
  turnstilePendingResolve = null;
  turnstilePendingReject = null;
}

function rejectTurnstilePending(message) {
  if (!turnstilePendingReject) return;
  const reject = turnstilePendingReject;
  clearTurnstilePending();
  reject(new Error(message));
}

function waitForTurnstileApi() {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (turnstileApiPromise) {
    return turnstileApiPromise;
  }

  turnstileApiPromise = new Promise((resolve, reject) => {
    const script = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (!script) {
      reject(new Error('Verification is unavailable. Please retry.'));
      return;
    }

    const handleLoad = () => {
      script.dataset.loaded = 'true';
      if (window.turnstile) {
        cleanup();
        resolve(window.turnstile);
      }
    };
    const handleError = () => {
      cleanup();
      reject(new Error('Verification failed to load. Please retry.'));
    };
    const cleanup = () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };

    if (script.dataset.loaded === 'true' && window.turnstile) {
      cleanup();
      resolve(window.turnstile);
      return;
    }

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);
  });

  return turnstileApiPromise;
}

async function ensureTurnstileWidget() {
  if (turnstileWidgetId !== null) return turnstileWidgetId;

  const siteKey = getTurnstileSiteKey();
  if (!siteKey) {
    throw new Error('Verification is unavailable. Please retry.');
  }
  if (!turnstileContainer) {
    throw new Error('Verification is unavailable. Please retry.');
  }

  await waitForTurnstileApi();
  turnstileWidgetId = window.turnstile.render(turnstileContainer, {
    sitekey: siteKey,
    action: DMV_TURNSTILE_ACTION,
    execution: 'execute',
    callback: (token) => {
      if (!turnstilePendingResolve) return;
      const resolve = turnstilePendingResolve;
      clearTurnstilePending();
      resolve(token);
    },
    'expired-callback': () => {
      rejectTurnstilePending('Verification expired. Please retry.');
    },
    'error-callback': () => {
      rejectTurnstilePending('Verification failed. Please retry.');
    },
  });

  return turnstileWidgetId;
}

async function executeTurnstile() {
  const widgetId = await ensureTurnstileWidget();

  return new Promise((resolve, reject) => {
    turnstilePendingResolve = resolve;
    turnstilePendingReject = reject;
    turnstilePendingTimeout = setTimeout(() => {
      rejectTurnstilePending('Verification timed out. Please retry.');
    }, 15000);

    try {
      window.turnstile.reset(widgetId);
      window.turnstile.execute(widgetId);
    } catch (err) {
      rejectTurnstilePending('Verification failed. Please retry.');
    }
  });
}

function resetTurnstile() {
  clearTurnstilePending();
  if (turnstileWidgetId !== null && window.turnstile) {
    try {
      window.turnstile.reset(turnstileWidgetId);
    } catch (err) {
      // Ignore widget reset failures — the next execute() will recreate state as needed.
    }
  }
}

const tv = new TV(container, label);
// In permalink mode skip the 2.2MB GLB model — user just wants the card.
// The model will be loaded on demand if the user navigates back to the full experience.
await tv.init({ skipModel: !!permalink });

const holoCard = new HoloCard();
holoCard.addToScene(tv.getScene());
tv.setCardMesh(holoCard.getMesh());

// DOM card click → toggle zoom (card captures clicks when visible via CSS pointer-events)
holoCard.onClick(() => {
  if (tv.isCardZoomed) {
    holoCard.setVisible(false);
    tv.zoomOutFromCard();
  } else if (holoCard.getMesh().visible) {
    tv.zoomToCard();
  }
});

const aboutPoster = new AboutPoster(tv.getScene());
tv.setAboutMesh(aboutPoster.mesh);

const wallSign = new WallSign(tv.getScene());
setTimeout(() => wallSign.flickerOn(), 1200);

const wallNumber = new WallNumber(tv.getScene());
setTimeout(() => { const cta = document.getElementById('centerCta'); if (cta) cta.classList.add('is-visible'); }, 2800);

function applyOuterUITheme(isNightMode) {
  const dark = Boolean(isNightMode);
  document.documentElement.classList.toggle('ui-dark', dark);
  if (appFavicon) {
    appFavicon.href = dark ? '/images/favicon_dark.ico?v=1' : '/images/favicon.ico?v=1';
  }
  aboutPoster.setTheme(dark ? 'dark' : 'light');
  wallSign.setTheme();
}

applyOuterUITheme(tv.isNightMode);

async function copyCliCommand(command = CLI_REGISTER_COMMAND, source = 'cta') {
  try {
    await navigator.clipboard.writeText(command);
    if (source === 'cta' && cliSnippet) {
      cliSnippet.textContent = 'copied — register via cli or mcp';
      setTimeout(() => { cliSnippet.textContent = CLI_REGISTER_COMMAND; }, 3000);
    }
    return true;
  } catch {
    return false;
  }
}

if (cliSnippet) {
  cliSnippet.addEventListener('click', () => {
    copyCliCommand();
  });
}

let latestCardData = null;
let cardShareTickerTimeout = null;
let lastScrollProgress = 0;
let gyroEnabled = false;
let gyroAttempted = false;
const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
const mobileViewportQuery = window.matchMedia('(max-width: 767px)');

const isCoarsePointer = () => coarsePointerQuery.matches;
const isMobileViewport = () => mobileViewportQuery.matches;
const CARD_FOCUS_SAMPLES = [[0, 0], [0.18, 0], [-0.18, 0], [0, 0.18], [0, -0.18]];

function isCRTInteractive() {
  return lastScrollProgress > 0.75 && tv.crt.bootPhase >= 2;
}

function scrollToTop() {
  document.getElementById('scroller').scrollTo({ top: 0, behavior: 'smooth' });
}

function syncTerminalStatusBar() {
  if (!terminalStatusBar) return;
  const isSceneFocused = tv.isCardZoomed || tv.isAboutZoomed;
  const isReading = tv.crt.bootPhase === 5 && tv.crt.reviewReading;
  const mobileZoomed = isMobileViewport() && isCRTInteractive() && !isSceneFocused;
  const shouldShow = isReading || mobileZoomed;
  terminalStatusBar.hidden = !shouldShow;
  if (terminalStatusText) {
    terminalStatusText.textContent = isReading ? '\u2190 BACK' : '\u2191 ZOOM OUT';
  }
}

function syncMobileUICompact(progress = lastScrollProgress) {
  const isSceneFocused = tv.isCardZoomed || tv.isAboutZoomed;
  const shouldCompact = isMobileViewport() && (
    progress > 0.72 ||
    isSceneFocused
  );
  document.body.classList.toggle('scene-focused', isSceneFocused);
  document.body.classList.toggle('mobile-ui-compact', shouldCompact);
}

function syncHiddenInputValueFromCRT() {
  if (!hiddenInput) return;
  const nextValue = tv.crt.bootPhase === 4 ? tv.crt.getCurrentInputValue() : '';
  if (hiddenInput.value !== nextValue) {
    hiddenInput.value = nextValue;
  }
  const caret = hiddenInput.value.length;
  try {
    hiddenInput.setSelectionRange(caret, caret);
  } catch (err) {
    // Selection APIs can throw on some mobile browsers while focus changes.
  }
}

function focusTerminalInput() {
  if (!hiddenInput) return;
  syncHiddenInputValueFromCRT();
  try {
    hiddenInput.focus({ preventScroll: true });
  } catch (err) {
    hiddenInput.focus();
  }
}

function handleDeviceOrientation(event) {
  const gamma = Number(event.gamma);
  const beta = Number(event.beta);
  if (!Number.isFinite(gamma) || !Number.isFinite(beta)) return;

  const nx = Math.max(-1, Math.min(1, gamma / 35));
  const ny = Math.max(-1, Math.min(1, (beta - 42) / 42));
  holoCard.setPointer(nx, -ny);
}

async function maybeEnableGyro() {
  if (gyroEnabled || gyroAttempted || !isCoarsePointer()) return;
  const orientationApi = window.DeviceOrientationEvent;
  if (!orientationApi) return;
  gyroAttempted = true;

  try {
    if (typeof orientationApi.requestPermission === 'function') {
      const permission = await orientationApi.requestPermission();
      if (permission !== 'granted') return;
    }
    window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true });
    gyroEnabled = true;
  } catch (err) {
    // Permission denied or unsupported context.
  }
}

function buildPermalinkUrl(certId, agentName = '') {
  const name = encodeURIComponent(agentName || 'agent');
  return new URL(`/c/${encodeURIComponent(certId)}/${name}`, CANONICAL_ORIGIN).toString();
}

function buildSharePayload(certId, data = {}, variant = 'register') {
  const requestedName = (data.agentName || '').trim();
  const resolvedName = requestedName || 'agent';
  const shareUrl = buildPermalinkUrl(certId, resolvedName);
  const agentPart = `${resolvedName}.agent`;
  const text = variant === 'permalink'
    ? `Check out ${agentPart} — verified at the Department of Machine Verification.\n\nGet yours:`
    : `I just registered ${agentPart} at the Department of Machine Verification.\n\nGet yours:`;
  return { text, shareUrl };
}

function buildXIntentUrl(text, shareUrl) {
  const intent = new URL('https://x.com/intent/tweet');
  intent.searchParams.set('text', text);
  intent.searchParams.set('url', shareUrl);
  return intent.toString();
}

function canUseWebShare(shareData) {
  if (!window.isSecureContext) return false;
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare === 'function') {
    try {
      return navigator.canShare({ url: shareData?.url });
    } catch {
      return false;
    }
  }
  return true;
}

async function tryWebShare(shareData) {
  if (!canUseWebShare(shareData)) return { ok: false, reason: 'unsupported' };
  try {
    await navigator.share(shareData);
    return { ok: true };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, reason: 'aborted' };
    return { ok: false, reason: 'error' };
  }
}

function openInNewTab(url) {
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
    return Boolean(opened);
  } catch {
    return false;
  }
}

function shareCertificate(certId, data = {}, options = {}) {
  if (!certId) return Promise.resolve({ ok: false, method: 'none', reason: 'missing' });
  const variant = options.variant || 'register';
  const { text, shareUrl } = buildSharePayload(certId, data, variant);
  const shareData = { title: 'DMV Certificate', text, url: shareUrl };

  const opened = openInNewTab(buildXIntentUrl(text, shareUrl));
  if (opened) return Promise.resolve({ ok: true, method: 'x' });

  if (canUseWebShare(shareData)) {
    return tryWebShare(shareData).then((nativeShare) => {
      if (nativeShare.ok) return { ok: true, method: 'native' };
      if (nativeShare.reason === 'aborted') return { ok: false, method: 'native', reason: 'aborted' };
      return copyShareLink(certId, data).then((copied) => (
        { ok: copied, method: copied ? 'copy' : 'none', reason: copied ? 'copied' : 'failed' }
      ));
    });
  }

  return copyShareLink(certId, data).then((copied) => (
    { ok: copied, method: copied ? 'copy' : 'none', reason: copied ? 'copied' : 'failed' }
  ));
}

function setCardShareTicker(message, variant = 'ok') {
  if (!cardShareTicker) return;
  if (cardShareTickerTimeout) {
    clearTimeout(cardShareTickerTimeout);
    cardShareTickerTimeout = null;
  }
  cardShareTicker.textContent = message;
  cardShareTicker.hidden = false;
  cardShareTicker.classList.add('is-visible');
  cardShareTicker.classList.toggle('card-share-bar__ticker--warn', variant === 'warn');
  cardShareTickerTimeout = window.setTimeout(() => {
    cardShareTicker.classList.remove('is-visible');
    cardShareTicker.hidden = true;
    cardShareTicker.classList.remove('card-share-bar__ticker--warn');
  }, 1400);
}

async function copyShareLink(certId, data = {}) {
  if (!certId) return false;
  const { shareUrl } = buildSharePayload(certId, data);
  const restoreFocus = (() => {
    const active = document.activeElement;
    return () => {
      if (!active || active === document.body) return;
      if (typeof active.focus !== 'function') return;
      try {
        active.focus({ preventScroll: true });
      } catch {
        active.focus();
      }
    };
  })();
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareUrl);
      return true;
    }
  } catch (err) {
    // fall through to legacy copy path
  }

  try {
    const helper = document.createElement('textarea');
    helper.value = shareUrl;
    helper.setAttribute('readonly', '');
    helper.setAttribute('aria-hidden', 'true');
    helper.tabIndex = -1;
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    helper.style.top = '0';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    try {
      helper.focus({ preventScroll: true });
    } catch {
      helper.focus();
    }
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(helper);
    restoreFocus();
    return Boolean(ok);
  } catch (err) {
    restoreFocus();
    return false;
  }
}

function setCardShareVisible(visible) {
  if (!cardShareBar) return;
  cardShareBar.hidden = !visible;
  if (!visible && cardShareTicker) {
    cardShareTicker.classList.remove('is-visible', 'card-share-bar__ticker--warn');
    cardShareTicker.hidden = true;
  }
}

function syncCardShareBar() {
  if (!cardShareBar) return;
  const canShare = Boolean(latestCardData?.certificateId);
  const cardMesh = holoCard.getMesh();
  if (cardShareBtn) cardShareBtn.disabled = !canShare;
  if (cardCopyBtn) cardCopyBtn.disabled = !canShare;
  if (cardSaveBtn) cardSaveBtn.disabled = !canShare;
  let isCardInView = false;
  if (cardMesh && tv.getMeshIntersectionAtNDC) {
    for (const [x, y] of CARD_FOCUS_SAMPLES) {
      if (tv.getMeshIntersectionAtNDC(cardMesh, x, y)) {
        isCardInView = true;
        break;
      }
    }
  }
  const isCardFocused = tv.isCardZoomed && isCardInView;
  const shouldShow = canShare && !permalink && isCardFocused && cardMesh.visible && !tv.isAboutZoomed;
  setCardShareVisible(shouldShow);
}

cardShareBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!latestCardData?.certificateId) return;
  shareCertificate(latestCardData.certificateId, latestCardData).then((result) => {
    if (result.method === 'copy') {
      setCardShareTicker('Link copied (popup blocked)', 'warn');
    } else if (result.reason === 'aborted') {
      // User canceled native share; no-op.
    } else if (!result.ok && result.reason === 'failed') {
      setCardShareTicker('Copy failed', 'warn');
    } else if (!result.ok) {
      setCardShareTicker('Popup blocked', 'warn');
    }
  });
});

cardCopyBtn?.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!latestCardData?.certificateId) {
    setCardShareTicker('No link yet', 'warn');
    return;
  }
  const copied = await copyShareLink(latestCardData.certificateId, latestCardData);
  setCardShareTicker(copied ? 'Link copied' : 'Copy failed', copied ? 'ok' : 'warn');
});

function downloadCard() {
  const canvas = holoCard.getCanvas();
  if (!canvas) return;
  const name = latestCardData?.agentName || 'agent';
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.agent-card.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

cardSaveBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  downloadCard();
});

terminalStatusBar?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const isReading = tv.crt.bootPhase === 5 && tv.crt.reviewReading;
  if (isReading) {
    tv.crt.handleReviewInput('Escape');
  } else {
    scrollToTop();
  }
});

let prevCardZoomed = false;
let prevCrtPhase = -1;
let prevCrtError = null;
let prevCrtField = -1;

function announce(message) {
  if (!crtAnnouncements || !message) return;
  // Clear then set to ensure repeated identical messages are announced
  crtAnnouncements.textContent = '';
  requestAnimationFrame(() => { crtAnnouncements.textContent = message; });
}

const PHASE_LABELS = {
  2: 'Terminal booting',
  3: 'Select account type: organization, individual, or agent',
  4: 'Form input',
  5: 'Review your information',
  6: 'Processing registration',
  7: 'Registration complete',
  8: 'Agents should self-register via CLI or MCP',
};

tv.onRender((dt) => {
  holoCard.update(dt, tv.camera, tv.renderer);
  // Show DOM card when zoom-in transition detected
  if (tv.isCardZoomed && !prevCardZoomed && holoCard.getMesh().visible) {
    holoCard.setVisible(true);
  }
  prevCardZoomed = tv.isCardZoomed;

  // Announce CRT state changes for screen readers
  const phase = tv.crt.bootPhase;
  if (phase !== prevCrtPhase) {
    const label = PHASE_LABELS[phase];
    if (label) announce(label);
    prevCrtPhase = phase;
    prevCrtField = -1;
  }
  if (phase === 4) {
    const err = tv.crt.validationError;
    if (err && err !== prevCrtError) announce(err);
    prevCrtError = err;
    const fi = tv.crt.currentField;
    if (fi !== prevCrtField && fi >= 0 && tv.crt.fields?.[fi]) {
      announce(tv.crt.fields[fi].prompt);
      prevCrtField = fi;
    }
  }

  syncCardShareBar();
  syncTerminalStatusBar();
  syncMobileUICompact();
});

function setAboutLinkActive(active) {
  if (!aboutToggleLink) return;
  aboutToggleLink.classList.toggle('is-active', active);
  aboutToggleLink.setAttribute('aria-expanded', String(active));
}

function openAbout() {
  if (aboutPoster.visible) return;
  if (tv.isCardZoomed) {
    holoCard.setVisible(false);
    tv.zoomOutFromCard();
    setTimeout(() => {
      if (aboutPoster.visible) return;
      aboutPoster.show();
      tv.zoomToAbout();
      setAboutLinkActive(true);
    }, 860);
    return;
  }
  aboutPoster.show();
  tv.zoomToAbout();
  setAboutLinkActive(true);
}

function closeAbout() {
  if (!aboutPoster.visible) return;
  aboutPoster.clearHoveredLink();
  if (aboutCursorHost) aboutCursorHost.style.cursor = '';
  aboutPoster.hide();
  tv.zoomOutFromAbout();
  setAboutLinkActive(false);
}

function syncAboutHover(clientX, clientY) {
  if (!aboutCursorHost) return;
  if (!tv.isAboutZoomed) {
    aboutPoster.clearHoveredLink();
    aboutCursorHost.style.cursor = '';
    return;
  }
  const aboutHit = tv.getMeshIntersectionAt(aboutPoster.mesh, clientX, clientY);
  const isHoveringLink = aboutHit?.uv ? aboutPoster.setHoveredLinkFromUV(aboutHit.uv) : false;
  if (!aboutHit?.uv) {
    aboutPoster.clearHoveredLink();
  }
  aboutCursorHost.style.cursor = isHoveringLink ? 'pointer' : '';
}

// ─── Agent View (full-page markdown for agents) ───────────────────
let agentViewOpen = false;
let skillMdCache = null;

function setAgentLinkActive(active) {
  if (!agentToggleLink) return;
  agentToggleLink.classList.toggle('is-active', active);
  agentToggleLink.setAttribute('aria-expanded', String(active));
}

function openAgentView() {
  if (agentViewOpen || !agentView) return;

  // Close about if open
  if (aboutPoster.visible) closeAbout();

  // Close card zoom if active and hide share bar
  if (tv.isCardZoomed) {
    holoCard.setVisible(false);
    tv.zoomOutFromCard();
  }
  if (cardShareBar) cardShareBar.hidden = true;

  // Hide 3D scene and overlays
  container.style.display = 'none';
  const footer = document.querySelector('.start-screen__footer');
  const centerCta = document.getElementById('centerCta');
  if (footer) footer.style.display = 'none';
  if (centerCta) centerCta.style.display = 'none';

  // Show view immediately
  agentView.hidden = false;
  agentViewOpen = true;
  setAgentLinkActive(true);

  // Fetch SKILL.md in background (show "Loading..." until ready)
  if (!skillMdCache && agentViewSkillContent) {
    fetch('/packages/dmv-agent/skills/dmv/SKILL.md')
      .then((resp) => resp.ok ? resp.text() : Promise.reject('fetch failed'))
      .then((text) => {
        // Strip YAML frontmatter (--- ... ---)
        skillMdCache = text.replace(/^---[\s\S]*?---\n*/, '');
        agentViewSkillContent.textContent = skillMdCache;
      })
      .catch((err) => {
        console.warn('Failed to load SKILL.md:', err);
        agentViewSkillContent.textContent = '(Failed to load SKILL.md)';
      });
  } else if (skillMdCache && agentViewSkillContent) {
    agentViewSkillContent.textContent = skillMdCache;
  }
}

function closeAgentView() {
  if (!agentViewOpen) return;
  agentView.hidden = true;
  container.style.display = '';
  const footer = document.querySelector('.start-screen__footer');
  const centerCta = document.getElementById('centerCta');
  if (footer) footer.style.display = '';
  if (centerCta) centerCta.style.display = '';
  agentViewOpen = false;
  setAgentLinkActive(false);
}

// Permalink mode: keep CTA flow, no right-side info panel
if (permalink) {
  latestCardData = { ...permalink };
  holoCard.show(permalink, true);
  tv.jumpToCard();

  // When the user zooms out of the card, load the TV model on demand
  // so the full 3D scene is ready if they scroll around.
  const _origZoomOut = tv.zoomOutFromCard.bind(tv);
  tv.zoomOutFromCard = (...args) => {
    if (!tv.modelLoaded) tv.loadModelDeferred();
    return _origZoomOut(...args);
  };

  const overlay = document.getElementById('permalinkOverlay');
  const agentLabel = document.getElementById('permalinkAgent');
  const certLabel = document.getElementById('permalinkCert');
  const ctaBtn = document.getElementById('permalinkCta');
  const shareBtn = document.getElementById('permalinkShare');
  const saveBtn = document.getElementById('permalinkSave');

  if (agentLabel) {
    agentLabel.textContent = permalink.agentName ? `${permalink.agentName}.agent` : '';
  }
  if (certLabel) {
    certLabel.textContent = permalink.certificateId;
  }
  if (overlay) {
    overlay.style.display = '';
  }

  ctaBtn?.addEventListener('click', () => {
    window.location.href = '/';
  });

  shareBtn?.addEventListener('click', () => {
    const certId = permalink.certificateId;
    shareCertificate(certId, permalink, { variant: 'permalink' }).then((result) => {
      const labelEl = shareBtn.querySelector('.permalink-overlay__cta-text');
      const original = labelEl?.textContent || 'Share on X';
      const message = result.method === 'copy'
        ? 'Link copied'
        : result.ok
          ? original
          : 'Popup blocked';
      if (labelEl && message !== original) {
        labelEl.textContent = message;
        window.setTimeout(() => {
          if (labelEl) labelEl.textContent = original;
        }, 1600);
      }
    });
  });

  saveBtn?.addEventListener('click', () => downloadCard());

  if (aboutToggleLink) {
    aboutToggleLink.textContent = 'Get Yours';
    aboutToggleLink.classList.add('header-cta');
    aboutToggleLink.classList.remove('is-active');
    aboutToggleLink.removeAttribute('href');
    aboutToggleLink.style.opacity = '1';
    aboutToggleLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      history.replaceState(null, '', window.location.pathname);
      window.location.reload();
    });
  }

  if (agentToggleLink) {
    agentToggleLink.style.display = 'none';
  }

  document.querySelector('.start-screen__footer')?.style.setProperty('display', 'none');
}

// ─── Demo mode: ?demo — rapid card testing without CRT form ────
const demoMode = !permalink && new URLSearchParams(location.search).has('demo');
if (demoMode) {
  const { CardDNA, PALETTES, HOLOS, RARITIES, generateCertId } = await import('./card-draw.js?v=23');
  const demoNames = [
    'atlas','nova','cipher','echo','pulse','nexus','vortex','helix',
    'prism','flux','orbit','quasar','zenith','onyx','spark','glitch',
    'sonic','rune','axion','phantom','neon','vector','cosmic','ember',
    'jade','terra','bolt','sable','drift','haze','comet','titan',
  ];
  const demoTypes = ['individual', 'organization', 'agent'];
  let demoIdx = 0;
  const showDemoCard = () => {
    const name = demoNames[demoIdx % demoNames.length];
    const type = demoTypes[demoIdx % demoTypes.length];
    const certId = generateCertId(name);
    const fakeData = {
      agentName: name,
      certificateId: certId,
      accountType: type,
    };
    latestCardData = fakeData;
    holoCard.show(fakeData, true);
    const dna = new CardDNA(name);
    const pal = PALETTES[dna.palette];
    const holo = HOLOS[dna.holo];
    const rar = RARITIES[dna.rarity];
    console.log(`[demo] ${name}.agent — ${pal.name} / ${holo.name} / ${rar.name} / ${type} — Space for next`);
    demoIdx++;
  };
  showDemoCard();
  tv.jumpToCard();
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !tv.isAboutZoomed) {
      e.preventDefault();
      showDemoCard();
    }
  });
}

// Persist completion; no floating card/info panel
tv.crt.onSubmit = async (data) => {
  try {
    const token = await executeTurnstile();
    const { data: persisted, error } = await insertRegistration(data, 'ui', token);
    if (error) {
      throw new Error(error.message || 'Registration failed. Please try again.');
    }
    if (!persisted?.certificate_id) {
      throw new Error('Registration failed. Please try again.');
    }
    return {
      certificateId: persisted.certificate_id,
      agentName: persisted.agent_name || data.agentName,
    };
  } finally {
    resetTurnstile();
  }
};

tv.crt.onComplete = async (data) => {
  const current = { ...data };
  latestCardData = current;
  setShareHash(current.certificateId, current.agentName);
  holoCard.show(current);
};

tv.crt.onViewCert = () => {
  if (!holoCard.getMesh().visible) return;
  if (tv.isAboutZoomed || aboutPoster.visible) {
    closeAbout();
    setTimeout(() => {
      if (!tv.isCardZoomed) tv.zoomToCard();
    }, 860);
    return;
  }
  if (!tv.isCardZoomed) tv.zoomToCard();
};

tv.crt.onShareCert = (certId, data) => {
  latestCardData = { ...(latestCardData || {}), ...(data || {}), certificateId: certId };
  shareCertificate(certId, data).then((result) => {
    if (result.method === 'copy') {
      announce('Share link copied to clipboard.');
    } else if (!result.ok && result.reason !== 'aborted') {
      announce('Share failed. Copy the link from the card view.');
    }
  });
};

tv.crt.setAgentRegistrationCommands(CLI_REGISTER_COMMAND, 'bunx dmv-agent');
tv.crt.onCopyAgentCli = () => {
  return copyCliCommand(CLI_REGISTER_COMMAND, 'crt').then((copied) => {
    announce(copied ? 'CLI command copied to clipboard.' : 'Copy failed. Use the command shown on screen.');
    return copied;
  });
};

if (!permalink && aboutToggleLink) {
  aboutToggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    // Close agent view if open
    if (agentViewOpen) closeAgentView();
    if (aboutPoster.visible) {
      closeAbout();
      return;
    }
    openAbout();
  });
}

if (!permalink && agentToggleLink) {
  agentToggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (agentViewOpen) {
      closeAgentView();
      return;
    }
    openAgentView();
  });
}

const audio = new Audio(encodeURI('/audio/pat102 - electro dance.mp3'));
audio.loop = true;
let soundOn = false;
const soundToggle = document.getElementById('soundToggle');
soundToggle?.addEventListener('click', () => {
  soundOn = !soundOn;
  soundToggle.classList.toggle('active', soundOn);
  if (soundOn) {
    audio.play();
  } else {
    audio.pause();
  }
});

function updateClock() {
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const clockEl = document.getElementById('clockEl');
  if (clockEl) {
    clockEl.textContent = `${String(h).padStart(2, '0')} : ${m} ${ampm}`;
  }
}
updateClock();
setInterval(updateClock, 10000);

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.create({
  scroller: '#scroller',
  trigger: '.start-screen-wrapper',
  start: 'top top',
  end: 'bottom bottom',
  onUpdate: ({ progress }) => {
    if (window.innerWidth < 768) label.classList.add('hidden');
    lastScrollProgress = Math.min(progress, 1);
    document.body.classList.toggle('scrolled', lastScrollProgress > 0.02);
    document.documentElement.style.setProperty('--scroll-progress', lastScrollProgress);
    tv.animateCameraPosition(lastScrollProgress);
    syncMobileUICompact(lastScrollProgress);
  }
});
syncMobileUICompact();

function updatePointer(clientX, clientY) {
  tv.setMousePosition(clientX, clientY);
  const nx = (clientX / window.innerWidth) * 2 - 1;
  const ny = -((clientY / window.innerHeight) * 2 - 1);
  holoCard.setPointer(nx, ny);
}

window.addEventListener('pointermove', (e) => {
  updatePointer(e.clientX, e.clientY);
  syncAboutHover(e.clientX, e.clientY);
});

window.addEventListener('pointerdown', (e) => {
  updatePointer(e.clientX, e.clientY);
  syncAboutHover(e.clientX, e.clientY);
});

let touchDragY = null;
let pinchStartDist = null;
const scroller = document.getElementById('scroller');
const PINCH_SCROLL_SPEED = 3; // px of scroll per px of pinch distance change
const CTRL_WHEEL_SCROLL_SPEED = 3;

window.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (!t) return;
  maybeEnableGyro();
  updatePointer(t.clientX, t.clientY);
  aboutPoster.clearHoveredLink();
  if (aboutCursorHost) aboutCursorHost.style.cursor = '';
  // Track Y for drag-scroll in reading mode or about poster
  if ((tv.crt.bootPhase === 5 && tv.crt.reviewReading) || aboutPoster.visible) {
    touchDragY = t.clientY;
  }
  // Track pinch distance for 2-finger zoom-to-scroll
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
  }
}, { passive: true });

window.addEventListener('wheel', (e) => {
  // Ctrl+wheel / trackpad pinch → scroll (browsers fire wheel+ctrlKey for pinch)
  if (e.ctrlKey) {
    if (!tv.isCardZoomed && !tv.isAboutZoomed
        && !(tv.crt.bootPhase === 5 && tv.crt.reviewReading)
        && !aboutPoster.visible) {
      scroller.scrollTop += e.deltaY * CTRL_WHEEL_SCROLL_SPEED;
      e.preventDefault();
      return;
    }
  }
  // Scroll CRT reading view (terms/charter)
  if (tv.crt.bootPhase === 5 && tv.crt.reviewReading) {
    tv.crt.handleReviewInput(e.deltaY > 0 ? 'ArrowDown' : 'ArrowUp');
    e.preventDefault();
    return;
  }
  if (!aboutPoster.visible) return;
  aboutPoster.scrollBy(e.deltaY);
  e.preventDefault();
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  // 2-finger pinch → scroll (zoom-to-scroll)
  if (e.touches.length === 2 && pinchStartDist !== null) {
    if (!tv.isCardZoomed && !tv.isAboutZoomed
        && !(tv.crt.bootPhase === 5 && tv.crt.reviewReading)
        && !aboutPoster.visible) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const delta = dist - pinchStartDist;
      pinchStartDist = dist;
      // Spread fingers = scroll down (zoom camera in), pinch = scroll up
      scroller.scrollTop += delta * PINCH_SCROLL_SPEED;
      e.preventDefault();
      return;
    }
  }

  const t = e.touches[0];
  if (!t) return;

  // Reading mode: touch-drag scrolls CRT reading content
  if (tv.crt.bootPhase === 5 && tv.crt.reviewReading) {
    if (touchDragY === null) { touchDragY = t.clientY; return; }
    const delta = touchDragY - t.clientY;
    touchDragY = t.clientY;
    if (Math.abs(delta) > 2) {
      tv.crt.handleReviewInput(delta > 0 ? 'ArrowDown' : 'ArrowUp');
    }
    e.preventDefault();
    return;
  }

  if (!aboutPoster.visible) return;
  if (touchDragY === null) { touchDragY = t.clientY; return; }
  const delta = touchDragY - t.clientY;
  touchDragY = t.clientY;
  aboutPoster.scrollBy(delta * 1.2);
  e.preventDefault();
}, { passive: false });

window.addEventListener('touchend', () => {
  touchDragY = null;
  pinchStartDist = null;
});

// Safari gesture events (iOS/macOS pinch): prevent native zoom
window.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
window.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
window.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

window.addEventListener('click', (e) => {
  maybeEnableGyro();
  if (e.target.closest('.card-share-bar')) return;
  if (e.target.closest('.permalink-overlay')) return;

  if (tv.isAboutZoomed) {
    const aboutHit = tv.getMeshIntersectionAt(aboutPoster.mesh, e.clientX, e.clientY);
    if (aboutHit?.uv && aboutPoster.openLinkAtUV(aboutHit.uv)) {
      return;
    }
    return;
  }

  if (tv.crt.inputActive && isCoarsePointer() && !tv.isCardZoomed) {
    const crtPoint = tv.getCRTSurfacePointAt(e.clientX, e.clientY);
    if (crtPoint) {
      const handled = tv.crt.handlePointerTap(crtPoint.x, crtPoint.y, crtPoint.altY);
      if (tv.crt.bootPhase === 4) {
        focusTerminalInput();
        return;
      }
      if (handled) return;
    }
  }

  const intersects = tv.getIntersectsAt(e.clientX, e.clientY);
  if (intersects.includes('card')) {
    if (tv.isCardZoomed) {
      tv.zoomOutFromCard();
    } else {
      tv.zoomToCard();
    }
    return;
  }
  if (intersects.includes('button')) {
    if (isCRTInteractive()) return;
    tv.toggleNightModeTV();
    applyOuterUITheme(tv.isNightMode);
    return;
  }

  if (tv.crt.inputActive && !isCoarsePointer()) focusTerminalInput();
});

const checkFocus = setInterval(() => {
  if (tv.crt.inputActive && !isCoarsePointer()) {
    focusTerminalInput();
    clearInterval(checkFocus);
  }
}, 200);

hiddenInput?.addEventListener('input', () => {
  if (!tv.crt.inputActive || tv.crt.bootPhase !== 4) return;
  tv.crt.setCurrentInputValue(hiddenInput.value);
});

hiddenInput?.addEventListener('keydown', (e) => {
  if (!tv.crt.inputActive || tv.crt.bootPhase !== 4) return;
  e.stopPropagation();
  if (e.key !== 'Enter') return;
  e.preventDefault();
  tv.crt.handleKey('Enter');
  if (tv.crt.bootPhase === 4) {
    focusTerminalInput();
    return;
  }
  syncHiddenInputValueFromCRT();
  hiddenInput.blur();
});

const passthroughKeys = new Set([
  'Backspace', 'Enter',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Escape',
]);

window.addEventListener('keydown', (e) => {
  if (agentViewOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAgentView();
    }
    return; // swallow all keys while agent view is open
  }

  if (tv.isAboutZoomed) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAbout();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      aboutPoster.scrollBy(42);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      aboutPoster.scrollBy(-42);
      return;
    }
    if (e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      aboutPoster.scrollBy(140);
      return;
    }
    if (e.key === 'PageUp') {
      e.preventDefault();
      aboutPoster.scrollBy(-140);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      aboutPoster.scrollToTop();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      aboutPoster.scrollToBottom();
      return;
    }
    return;
  }

  if (e.key === 'Escape' && tv.isCardZoomed) {
    e.preventDefault();
    holoCard.setVisible(false);
    tv.zoomOutFromCard();
    return;
  }

  if (!tv.crt.inputActive) return;

  if (passthroughKeys.has(e.key)) {
    e.preventDefault();
    tv.crt.handleKey(e.key);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    tv.crt.handleKey(e.key);
  }

  if (tv.crt.bootPhase === 4) {
    focusTerminalInput();
  }
});

window.addEventListener('resize', () => {
  tv.resize();
  syncMobileUICompact();
});
