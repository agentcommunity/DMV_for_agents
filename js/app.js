import { TV } from './TV.js?v=22';
import { AboutPoster } from './AboutPoster.js?v=16';
import { HoloCard } from './HoloCard.js?v=23';
import { WallSign } from './WallSign.js?v=2';
import { insertRegistration } from './supabase.js?v=15';

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

const container = document.getElementById('canvasWrapper');
const label = document.getElementById('modeLabel');
const hiddenInput = document.getElementById('hiddenInput');
const aboutToggleLink = document.getElementById('aboutToggleLink');
const aboutCursorHost = container;
const cardShareBar = document.getElementById('cardShareBar');
const cardShareBtn = document.getElementById('cardShareBtn');
const cardCopyBtn = document.getElementById('cardCopyBtn');
const cardShareTicker = document.getElementById('cardShareTicker');
const appFavicon = document.getElementById('appFavicon');
const cliSnippet = document.getElementById('cliSnippet');
const terminalStatusBar = document.getElementById('terminalStatusBar');
const terminalStatusText = document.getElementById('terminalStatusText');
const crtAnnouncements = document.getElementById('crtAnnouncements');

const tv = new TV(container, label);
await tv.init();

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
setTimeout(() => { const cta = document.getElementById('centerCta'); if (cta) cta.classList.add('is-visible'); }, 2100);

function applyOuterUITheme(isNightMode) {
  const dark = Boolean(isNightMode);
  document.documentElement.classList.toggle('ui-dark', dark);
  if (appFavicon) {
    appFavicon.href = dark ? 'images/favicon_dark.ico?v=1' : 'images/favicon.ico?v=1';
  }
  aboutPoster.setTheme(dark ? 'dark' : 'light');
  wallSign.setTheme();
}

applyOuterUITheme(tv.isNightMode);

if (cliSnippet) {
  cliSnippet.addEventListener('click', () => {
    navigator.clipboard.writeText(cliSnippet.textContent.trim()).then(() => {
      const original = cliSnippet.textContent;
      cliSnippet.textContent = 'copied — have your agent choose its own name';
      setTimeout(() => { cliSnippet.textContent = original; }, 3000);
    });
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
  return `https://dmv.agentcommunity.org/c/${encodeURIComponent(certId)}/${name}`;
}

function buildSharePayload(certId, data = {}) {
  const agentName = data.agentName || 'agent';
  const shareUrl = buildPermalinkUrl(certId, agentName);
  const text = encodeURIComponent(
    `I just registered ${agentName}.agent at the Department of Machine Verification.\n\n` +
    `Get yours -> ${shareUrl}`
  );
  return { text, shareUrl };
}

function shareCertificateOnX(certId, data = {}) {
  if (!certId) return;
  const { text } = buildSharePayload(certId, data);
  window.open(`https://x.com/intent/tweet?text=${text}`, '_blank');
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
  try {
    if (navigator.clipboard?.writeText) {
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
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(helper);
    return ok;
  } catch (err) {
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
  shareCertificateOnX(latestCardData.certificateId, latestCardData);
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
  3: 'Select account type: individual or organization',
  4: 'Form input',
  5: 'Review your information',
  6: 'Processing registration',
  7: 'Registration complete',
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

// Permalink mode: keep CTA flow, no right-side info panel
if (permalink) {
  latestCardData = { ...permalink };
  holoCard.show(permalink, true);
  tv.jumpToCard();

  const overlay = document.getElementById('permalinkOverlay');
  const agentLabel = document.getElementById('permalinkAgent');
  const certLabel = document.getElementById('permalinkCert');
  const ctaBtn = document.getElementById('permalinkCta');
  const shareBtn = document.getElementById('permalinkShare');

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
    const shareUrl = buildPermalinkUrl(certId, permalink.agentName);
    const agentPart = permalink.agentName ? `${permalink.agentName}.agent` : 'an agent';
    const text = encodeURIComponent(
      `Check out ${agentPart} - verified at the Department of Machine Verification.\n\n` +
      `Get yours -> ${shareUrl}`
    );
    window.open(`https://x.com/intent/tweet?text=${text}`, '_blank');
  });

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

  document.querySelector('.start-screen__footer')?.style.setProperty('display', 'none');
}

// ─── Demo mode: ?demo — rapid card testing without CRT form ────
const demoMode = !permalink && new URLSearchParams(location.search).has('demo');
if (demoMode) {
  const { CardDNA, PALETTES, HOLOS, RARITIES, generateCertId } = await import('./card-draw.js?v=22');
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
tv.crt.onComplete = async (data) => {
  let current = { ...data };
  latestCardData = current;
  setShareHash(current.certificateId, current.agentName);
  holoCard.show(current);

  try {
    const { data: persisted } = await insertRegistration(current, 'ui');
    if (persisted?.certificate_id) {
      current = {
        ...current,
        certificateId: persisted.certificate_id,
        agentName: persisted.agent_name || current.agentName,
      };
      latestCardData = current;
      tv.crt.setCertificateId(current.certificateId);
      setShareHash(current.certificateId, current.agentName);
      holoCard.show(current, true);
    }
  } catch (err) {
    console.warn('Registration persistence failed:', err);
  }
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
  shareCertificateOnX(certId, data);
};

if (!permalink && aboutToggleLink) {
  aboutToggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (aboutPoster.visible) {
      closeAbout();
      return;
    }
    openAbout();
  });
}

const audio = new Audio(encodeURI('audio/pat102 - electro dance.mp3'));
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
    lastScrollProgress = Math.min(progress, 0.95);
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
}, { passive: true });

window.addEventListener('wheel', (e) => {
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
});

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
