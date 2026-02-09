import * as THREE from 'three';

const gsap = window.gsap;

export class AboutPoster {
  constructor(scene) {
    this.scene = scene;
    this.visible = false;

    // Canvas for wall text
    this.canvasW = 800;
    this.canvasH = 600;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvasW;
    this.canvas.height = this.canvasH;
    this.ctx = this.canvas.getContext('2d');

    // Scroll state for the white wall text
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this.viewportTop = 108;
    this.viewportBottom = this.canvasH - 24;
    this.viewportHeight = this.viewportBottom - this.viewportTop;
    this.linkHitboxes = [];
    this.hoveredLinkUrl = null;
    this.links = [
      { label: 'agentcommunity.org', url: 'https://agentcommunity.org' },
      { label: 'aid.agentcommunity.org', url: 'https://aid.agentcommunity.org' },
      { label: 'dmv.agentcommunity.org', url: 'https://dmv.agentcommunity.org' },
    ];

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });

    const aspect = this.canvasW / this.canvasH;
    const planeHeight = 3.0;
    const planeWidth = planeHeight * aspect;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(planeWidth, planeHeight),
      this.material
    );
    this.mesh.position.set(-4.5, 1.2, -0.5);
    this.mesh.rotation.y = 0.2;
    this.mesh.visible = false;

    this.scene.add(this.mesh);
    this.draw();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.mesh.visible = true;
    this.scrollToTop();
    gsap.fromTo(this.material, { opacity: 0 }, {
      opacity: 1,
      duration: 0.6,
      ease: 'power2.out',
    });
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    gsap.to(this.material, {
      opacity: 0,
      duration: 0.4,
      ease: 'power2.in',
      onComplete: () => { this.mesh.visible = false; },
    });
  }

  scrollBy(delta) {
    if (!Number.isFinite(delta) || this.maxScroll <= 0) return false;
    const next = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + delta));
    if (Math.abs(next - this.scrollOffset) < 0.5) return false;
    this.scrollOffset = next;
    this.draw();
    return true;
  }

  scrollToTop() {
    if (this.scrollOffset !== 0) {
      this.scrollOffset = 0;
      this.draw();
      return true;
    }
    return false;
  }

  scrollToBottom() {
    if (this.maxScroll <= 0 || this.scrollOffset === this.maxScroll) return false;
    this.scrollOffset = this.maxScroll;
    this.draw();
    return true;
  }

  getLinkAtCanvasPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const hit of this.linkHitboxes) {
      if (
        x >= hit.x &&
        x <= hit.x + hit.w &&
        y >= hit.y &&
        y <= hit.y + hit.h
      ) {
        return hit.url;
      }
    }
    return null;
  }

  getLinkAtUV(uv) {
    if (!uv) return null;
    const x = uv.x * this.canvasW;
    const yFromTop = (1 - uv.y) * this.canvasH;
    const yRaw = uv.y * this.canvasH;
    return this.getLinkAtCanvasPoint(x, yFromTop) || this.getLinkAtCanvasPoint(x, yRaw);
  }

  setHoveredLinkFromUV(uv) {
    const nextUrl = this.getLinkAtUV(uv);
    if (nextUrl === this.hoveredLinkUrl) {
      return Boolean(nextUrl);
    }
    this.hoveredLinkUrl = nextUrl;
    this.draw();
    return Boolean(nextUrl);
  }

  clearHoveredLink() {
    if (!this.hoveredLinkUrl) return false;
    this.hoveredLinkUrl = null;
    this.draw();
    return true;
  }

  openLinkAtUV(uv) {
    const url = this.getLinkAtUV(uv);
    if (!url) return false;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvasW;
    const h = this.canvasH;

    ctx.clearRect(0, 0, w, h);
    this.linkHitboxes = [];
    ctx.textBaseline = 'top';

    const rootStyle = getComputedStyle(document.documentElement);
    const uiSans = rootStyle.getPropertyValue('--floating-ui-font-sans').trim()
      || '"PPSupplySansRegular", "PPSupplyMonoRegular", sans-serif';
    const uiMono = rootStyle.getPropertyValue('--floating-ui-font-mono').trim()
      || '"PPSupplyMonoRegular", monospace';
    const uiMonoLight = rootStyle.getPropertyValue('--floating-ui-font-mono-light').trim()
      || '"PPSupplyMonoUltralight", "PPSupplyMonoRegular", monospace';

    const titleFont = `600 42px ${uiSans}`;
    const bodyFont = `24px ${uiMonoLight}`;
    const sectionFont = `600 20px ${uiMono}`;
    const smallFont = `18px ${uiMono}`;

    // Fixed header
    ctx.font = titleFont;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
    ctx.shadowBlur = 12;
    ctx.fillText('ABOUT', 40, 40);
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(40, 92, w - 80, 1);

    // Scrollable body region
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.viewportTop, w, this.viewportHeight);
    ctx.clip();

    let y = 120;

    const drawLines = (lines, font, color, lineHeight, gapAfter = 12, shadow = 0) => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.15)';
      ctx.shadowBlur = shadow;
      for (const line of lines) {
        const drawY = y - this.scrollOffset;
        if (drawY > this.viewportTop - 60 && drawY < this.viewportBottom + 40) {
          ctx.fillText(line, 40, drawY);
        }
        y += lineHeight;
      }
      ctx.shadowBlur = 0;
      y += gapAfter;
    };

    drawLines(
      [
        'The Department of Machine Verification',
        'is the registration authority for the',
        '.agent community.',
      ],
      bodyFont,
      'rgba(255, 255, 255, 0.85)',
      34,
      14,
      6
    );

    drawLines(
      [
        'As AI agents become first-class',
        'participants on the internet, they',
        'need identity - a way to be recognized,',
        'verified, and trusted.',
      ],
      bodyFont,
      'rgba(255, 255, 255, 0.62)',
      34,
      14,
      6
    );

    drawLines(
      [
        'The DMV issues machine identity',
        'certificates that establish:',
      ],
      bodyFont,
      'rgba(255, 255, 255, 0.85)',
      34,
      12,
      6
    );

    drawLines(
      [
        '  - A unique .agent identity',
        '  - A content-addressed certificate ID',
        '  - Membership in the agent community',
      ],
      smallFont,
      'rgba(255, 255, 255, 0.54)',
      30,
      18,
      0
    );

    drawLines(
      ['WHAT YOU GET'],
      sectionFont,
      'rgba(255, 255, 255, 0.88)',
      30,
      8,
      2
    );

    drawLines(
      [
        '  - Unique requested .agent name',
        '  - Deterministic certificate ID',
        '  - Badge endpoint for README and websites',
      ],
      smallFont,
      'rgba(255, 255, 255, 0.74)',
      28,
      16,
      0
    );

    drawLines(
      ['HOW IT WORKS'],
      sectionFont,
      'rgba(255, 255, 255, 0.88)',
      30,
      8,
      2
    );

    drawLines(
      [
        'The terminal validates your inputs, normalizes',
        'identity fields, and mints a deterministic',
        'certificate reference tied to your requested',
        'handle and account type.',
        '',
        'You can share the permalink publicly, embed the',
        'badge endpoint, and let others verify your',
        'registration metadata through open endpoints.',
      ],
      smallFont,
      'rgba(255, 255, 255, 0.7)',
      28,
      16,
      0
    );

    drawLines(
      ['LINKS'],
      sectionFont,
      'rgba(255, 255, 255, 0.88)',
      30,
      8,
      2
    );

    ctx.font = smallFont;
    const linkX = 40;
    const linkLineHeight = 28;
    for (const link of this.links) {
      const isHovered = this.hoveredLinkUrl === link.url;
      const drawY = y - this.scrollOffset;
      if (drawY > this.viewportTop - 30 && drawY < this.viewportBottom + 20) {
        ctx.fillStyle = isHovered ? 'rgba(184, 255, 224, 0.98)' : 'rgba(136, 255, 204, 0.86)';
        ctx.shadowColor = isHovered ? 'rgba(136, 255, 204, 0.65)' : 'transparent';
        ctx.shadowBlur = isHovered ? 8 : 0;
        ctx.fillText(link.label, linkX, drawY);
        ctx.shadowBlur = 0;
        const linkW = ctx.measureText(link.label).width;
        const underlineY = drawY + 22;
        ctx.fillRect(linkX, underlineY, linkW, isHovered ? 2 : 1);
        this.linkHitboxes.push({
          x: linkX,
          y: drawY,
          w: linkW,
          h: 24,
          url: link.url,
        });
      }
      y += linkLineHeight;
    }
    y += 12;

    drawLines(
      [
        'This is a pre-registration terminal.',
        'Full verification coming soon.',
      ],
      smallFont,
      'rgba(255, 255, 255, 0.34)',
      28,
      0,
      0
    );

    const contentBottom = y + 12;
    ctx.restore();

    const maxVisibleBottom = this.viewportBottom - 6;
    const nextMax = Math.max(0, contentBottom - maxVisibleBottom);
    this.maxScroll = nextMax;
    if (this.scrollOffset > this.maxScroll) {
      this.scrollOffset = this.maxScroll;
      this.draw();
      return;
    }

    // Scrollbar hint
    if (this.maxScroll > 0) {
      const trackX = w - 14;
      const trackY = this.viewportTop + 8;
      const trackH = this.viewportHeight - 16;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(trackX, trackY, 2, trackH);

      const thumbH = Math.max(44, trackH * (trackH / (trackH + this.maxScroll)));
      const thumbTravel = trackH - thumbH;
      const thumbY = trackY + (this.scrollOffset / this.maxScroll) * thumbTravel;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.fillRect(trackX - 1, thumbY, 4, thumbH);

      if (this.scrollOffset < this.maxScroll - 2) {
        ctx.font = `12px ${uiMono}`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
        ctx.fillText('SCROLL', w - 76, h - 20);
      }
    }

    this.texture.needsUpdate = true;
  }
}
