import { TV } from './TV.js?v=6';
import { HoloCard } from './HoloCard.js?v=6';
import { AboutPoster } from './AboutPoster.js?v=6';
import { insertRegistration } from './supabase.js?v=6';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;

// --- Permalink detection ---
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
const permalink = parsePermalink();

// DOM refs
const container = document.getElementById('canvasWrapper');
const label = document.getElementById('modeLabel');
const startScreen = document.getElementById('startScreen');
const hiddenInput = document.getElementById('hiddenInput');

// Init TV
const tv = new TV(container, label);
await tv.init();

// Init HoloCard
const holoCard = new HoloCard();
holoCard.addToScene(tv.getScene());

// Init AboutPoster
const aboutPoster = new AboutPoster(tv.getScene());
tv.setAboutMesh(aboutPoster.mesh);

// Register card mesh for raycasting
tv.setCardMesh(holoCard.mesh);

// HoloCard update loop + mouse-to-card tilt mapping
tv.onRender((dt) => {
  holoCard.update(dt);
});

// --- Permalink mode: skip scroll, show card directly ---
if (permalink) {
  // Show card instantly and jump camera to it
  holoCard.show(permalink, true);
  tv.jumpToCard();

  // Show the "Get yours" overlay
  const overlay = document.getElementById('permalinkOverlay');
  const agentLabel = document.getElementById('permalinkAgent');
  const certLabel = document.getElementById('permalinkCert');
  const ctaBtn = document.getElementById('permalinkCta');

  agentLabel.textContent = permalink.agentName ? permalink.agentName + '.agent' : '';
  certLabel.textContent = permalink.certificateId;
  overlay.style.display = '';

  ctaBtn.addEventListener('click', () => {
    // Clear hash and reload to normal registration mode
    history.replaceState(null, '', window.location.pathname);
    window.location.reload();
  });

  // Share on X button
  const shareBtn = document.getElementById('permalinkShare');
  shareBtn.addEventListener('click', () => {
    const certId = permalink.certificateId;
    const shareUrl = `dmv.agentcommunity.org/#/${encodeURIComponent(certId)}`;
    const agentPart = permalink.agentName ? `${permalink.agentName}.agent` : 'an agent';
    const text = encodeURIComponent(
      `Check out ${agentPart} — verified at the Department of Machine Verification.\n\n` +
      `Get yours \u2192 ${shareUrl}`
    );
    window.open(`https://x.com/intent/tweet?text=${text}`, '_blank');
  });

  // Swap header "About" link to "Get Yours" in permalink mode
  const headerLink = document.querySelector('.header-link');
  headerLink.textContent = 'Get Yours';
  headerLink.classList.add('header-cta');
  headerLink.removeAttribute('href');
  headerLink.style.opacity = '1';
  headerLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    history.replaceState(null, '', window.location.pathname);
    window.location.reload();
  });

  // Hide entire footer in permalink mode (prevents overlap with overlay)
  document.querySelector('.start-screen__footer')?.style.setProperty('display', 'none');
}

// Wire up form completion -> card poster + generate permalink + persist
tv.crt.onComplete = (data) => {
  holoCard.show(data);
  // Set the hash so the URL becomes shareable (cert ID is sufficient)
  const hash = `#/${encodeURIComponent(data.certificateId)}`;
  history.replaceState(null, '', hash);
  // Persist to Supabase (fire-and-forget, behind feature flag)
  insertRegistration(data, 'ui');
};

// Wire up View / Share callbacks from CRT done phase
tv.crt.onViewCert = () => {
  if (!tv.isCardZoomed) tv.zoomToCard();
};
tv.crt.onShareCert = (certId, data) => {
  const agentName = data.agentName || 'agent';
  const shareUrl = `dmv.agentcommunity.org/#/${encodeURIComponent(certId)}`;
  const text = encodeURIComponent(
    `I just registered ${agentName}.agent at the Department of Machine Verification.\n\n` +
    `Certificate: ${certId}\n\n` +
    `Get yours \u2192 ${shareUrl}`
  );
  window.open(`https://x.com/intent/tweet?text=${text}`, '_blank');
};

// About toggle — show poster + zoom camera
// Handles transition from any state: card-zoomed, normal, or about-zoomed
// (Skipped in permalink mode — header link is repurposed as "Get Yours")
if (!permalink) {
  const aboutLink = document.querySelector('.header-link');
  aboutLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (aboutPoster.visible) {
      aboutPoster.hide();
      tv.zoomOutFromAbout();
    } else {
      // If card is zoomed, unzoom first then zoom to about after animation
      if (tv.isCardZoomed) {
        tv.zoomOutFromCard();
        setTimeout(() => {
          aboutPoster.show();
          tv.zoomToAbout();
        }, 900); // slightly longer than card zoom-out duration
      } else {
        aboutPoster.show();
        tv.zoomToAbout();
      }
    }
  });
}

// Sound toggle
const audio = new Audio('audio/music.mp3');
audio.loop = true;
let soundOn = false;
const soundToggle = document.getElementById('soundToggle');
const soundThumb = document.getElementById('soundThumb');
soundToggle.addEventListener('click', () => {
  soundOn = !soundOn;
  soundToggle.classList.toggle('active', soundOn);
  if (soundOn) { audio.play(); } else { audio.pause(); }
});

// Clock
function updateClock() {
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  document.getElementById('clockEl').textContent =
    `${String(h).padStart(2, '0')} : ${m} ${ampm}`;
}
updateClock();
setInterval(updateClock, 10000);

// Scroll — always wired (permalink visitors can explore after unzooming)
gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.create({
  scroller: '#scroller',
  trigger: '.start-screen-wrapper',
  start: 'top top',
  end: 'bottom bottom',
  onUpdate: ({ progress }) => {
    if (window.innerWidth < 768) label.classList.add('hidden');
    tv.animateCameraPosition(Math.min(progress, 0.95));
  }
});

// Mouse parallax + HoloCard tilt
window.addEventListener('mousemove', (e) => {
  tv.setMousePosition(e.clientX, e.clientY);
  // Map mouse to normalized -1..1 for card tilt
  const nx = (e.clientX / window.innerWidth) * 2 - 1;
  const ny = -((e.clientY / window.innerHeight) * 2 - 1);
  holoCard.setPointer(nx, ny);
});

// Mobile gyro → HoloCard tilt
if (window.DeviceOrientationEvent) {
  let gyroBase = null;
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null || e.beta == null) return;
    if (!gyroBase) gyroBase = { g: e.gamma, b: e.beta };
    const gx = Math.max(-1, Math.min(1, (e.gamma - gyroBase.g) / 20));
    const gy = Math.max(-1, Math.min(1, -(e.beta - gyroBase.b) / 20));
    holoCard.setPointer(gx, gy);
  });
}

// Click: dismiss about zoom, card zoom, night mode toggle, or focus terminal
window.addEventListener('click', (e) => {
  // Dismiss about zoom on any click (except the about link itself)
  if (tv.isAboutZoomed && !e.target.closest('.header-link')) {
    aboutPoster.hide();
    tv.zoomOutFromAbout();
    return;
  }

  const intersects = tv.getIntersects();

  // Card zoom/unzoom — works in both normal and permalink mode
  if (intersects.includes('card')) {
    if (tv.isCardZoomed) {
      tv.zoomOutFromCard();
    } else {
      tv.zoomToCard();
    }
    return;
  }

  // In permalink mode, clicking outside the card (but not on overlay buttons) unzooms
  if (permalink) {
    if (e.target.closest('.permalink-overlay')) return; // don't unzoom when using overlay
    if (e.target.closest('.start-header')) return; // don't unzoom when using header
    if (tv.isCardZoomed) tv.zoomOutFromCard();
    return;
  }

  if (intersects.includes('button')) {
    tv.toggleNightModeTV();
    startScreen.classList.toggle('night-mode', tv.isNightMode);
  }
  // Focus hidden input to capture keystrokes when CRT is active
  if (tv.crt.inputActive) {
    hiddenInput.focus();
  }
});

// Auto-focus when terminal becomes interactive
const checkFocus = setInterval(() => {
  if (tv.crt.inputActive) {
    hiddenInput.focus();
    clearInterval(checkFocus);
  }
}, 200);

// Keys that should pass through to CRT terminal
const passthroughKeys = new Set([
  'Backspace', 'Enter',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Escape',
]);

// Route keystrokes to CRT terminal
window.addEventListener('keydown', (e) => {
  // Dismiss about zoom on any key
  if (tv.isAboutZoomed) {
    e.preventDefault();
    aboutPoster.hide();
    tv.zoomOutFromAbout();
    return;
  }

  // Escape while card is zoomed → unzoom
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
});

// Resize
window.addEventListener('resize', () => tv.resize());
