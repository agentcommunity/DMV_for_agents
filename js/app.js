import { TV } from './TV.js?v=8';
import { AboutPoster } from './AboutPoster.js?v=8';
import { HoloCard } from './HoloCard.js?v=8';
import { insertRegistration } from './supabase.js?v=8';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;

// Formats: #/CERT-ID or #/CERT-ID/agentname (agent name optional)
function parsePermalink() {
  const hash = window.location.hash;
  if (!hash || !hash.startsWith('#/')) return null;
  const parts = hash.slice(2).split('/').filter(Boolean);
  if (parts.length < 1) return null;
  return {
    certificateId: decodeURIComponent(parts[0]),
    agentName: parts[1] ? decodeURIComponent(parts[1]) : '',
  };
}

function setShareHash(certificateId) {
  history.replaceState(null, '', `#/${encodeURIComponent(certificateId)}`);
}

const permalink = parsePermalink();

const container = document.getElementById('canvasWrapper');
const label = document.getElementById('modeLabel');
const startScreen = document.getElementById('startScreen');
const hiddenInput = document.getElementById('hiddenInput');
const aboutToggleLink = document.getElementById('aboutToggleLink');
const aboutCursorHost = container;
const cardShareBar = document.getElementById('cardShareBar');
const cardShareBtn = document.getElementById('cardShareBtn');
const cardCopyBtn = document.getElementById('cardCopyBtn');
const cardShareTicker = document.getElementById('cardShareTicker');

const tv = new TV(container, label);
await tv.init();

const holoCard = new HoloCard();
holoCard.addToScene(tv.getScene());
tv.setCardMesh(holoCard.getMesh());

const aboutPoster = new AboutPoster(tv.getScene());
tv.setAboutMesh(aboutPoster.mesh);

let latestCardData = null;
let isCardShareVisible = false;
let cardShareTickerTimeout = null;
let lastScrollProgress = 0;
let gyroEnabled = false;
let gyroAttempted = false;
const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
const mobileViewportQuery = window.matchMedia('(max-width: 767px)');

const isCoarsePointer = () => coarsePointerQuery.matches;
const isMobileViewport = () => mobileViewportQuery.matches;

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

function buildSharePayload(certId, data = {}) {
  const agentName = data.agentName || 'agent';
  const shareUrl = `https://dmv.agentcommunity.org/#/${encodeURIComponent(certId)}`;
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
  isCardShareVisible = visible;
  cardShareBar.hidden = !visible;
  cardShareBar.style.display = visible ? '' : 'none';
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
  const cardFocusSamples = [
    [0, 0],
    [0.18, 0],
    [-0.18, 0],
    [0, 0.18],
    [0, -0.18],
  ];
  let isCardInView = false;
  if (cardMesh && tv.getMeshIntersectionAtNDC) {
    for (const [x, y] of cardFocusSamples) {
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

tv.onRender((dt) => {
  holoCard.update(dt);
  syncCardShareBar();
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
    history.replaceState(null, '', window.location.pathname);
    window.location.reload();
  });

  shareBtn?.addEventListener('click', () => {
    const certId = permalink.certificateId;
    const shareUrl = `https://dmv.agentcommunity.org/#/${encodeURIComponent(certId)}`;
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

// Persist completion; no floating card/info panel
tv.crt.onComplete = async (data) => {
  let current = { ...data };
  latestCardData = current;
  setShareHash(current.certificateId);
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
      setShareHash(current.certificateId);
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

window.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (!t) return;
  maybeEnableGyro();
  updatePointer(t.clientX, t.clientY);
  aboutPoster.clearHoveredLink();
  if (aboutCursorHost) aboutCursorHost.style.cursor = '';
}, { passive: true });

window.addEventListener('wheel', (e) => {
  if (!aboutPoster.visible) return;
  aboutPoster.scrollBy(e.deltaY);
  e.preventDefault();
}, { passive: false });

let aboutTouchY = null;
window.addEventListener('touchstart', (e) => {
  if (!aboutPoster.visible) return;
  const t = e.touches[0];
  if (!t) return;
  aboutTouchY = t.clientY;
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (!aboutPoster.visible) return;
  const t = e.touches[0];
  if (!t) return;
  if (aboutTouchY == null) {
    aboutTouchY = t.clientY;
    return;
  }
  const delta = aboutTouchY - t.clientY;
  aboutTouchY = t.clientY;
  aboutPoster.scrollBy(delta * 1.2);
  e.preventDefault();
}, { passive: false });

window.addEventListener('touchend', () => {
  aboutTouchY = null;
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
    tv.toggleNightModeTV();
    startScreen.classList.toggle('night-mode', tv.isNightMode);
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
