import { TV } from './TV.js';
import { CardPoster } from './CardPoster.js';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;

// DOM refs
const container = document.getElementById('canvasWrapper');
const label = document.getElementById('modeLabel');
const startScreen = document.getElementById('startScreen');
const hiddenInput = document.getElementById('hiddenInput');

// Init TV
const tv = new TV(container, label);
await tv.init();

// Init CardPoster
const cardPoster = new CardPoster(tv.getScene());

// Wire up form completion -> card poster
tv.crt.onComplete = (data) => cardPoster.show(data);

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

// Scroll
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

// Mouse parallax
window.addEventListener('mousemove', (e) => {
  tv.setMousePosition(e.clientX, e.clientY);
});

// Click: night mode toggle OR focus terminal input
window.addEventListener('click', () => {
  const intersects = tv.getIntersects();
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

// Route keystrokes to CRT terminal
window.addEventListener('keydown', (e) => {
  if (!tv.crt.inputActive) return;
  if (e.key === 'Backspace' || e.key === 'Enter') {
    e.preventDefault();
    tv.crt.handleKey(e.key);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    tv.crt.handleKey(e.key);
  }
});

// Resize
window.addEventListener('resize', () => tv.resize());
