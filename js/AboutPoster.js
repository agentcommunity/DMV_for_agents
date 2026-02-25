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

    // Scroll state for the about wall text
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this.viewportTop = 108;
    this.viewportBottom = this.canvasH - 24;
    this.viewportHeight = this.viewportBottom - this.viewportTop;
    this.theme = 'light';
    this.linkHitboxes = [];
    this.hoveredLinkUrl = null;
    this.links = [
      { label: 'agentcommunity.org', url: 'https://agentcommunity.org' },
      { label: 'aid.agentcommunity.org', url: 'https://aid.agentcommunity.org' },
      { label: 'dmv.agentcommunity.org', url: 'https://dmv.agentcommunity.org' },
      { label: 'github', url: 'https://github.com/agentcommunity/DMV_for_agents' },
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

  setTheme(mode) {
    const theme = mode === 'dark' ? 'dark' : 'light';
    if (theme === this.theme) return;
    this.theme = theme;
    this.draw();
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
    const yFlipped = (1 - uv.y) * this.canvasH;
    const yDirect = uv.y * this.canvasH;
    return this.getLinkAtCanvasPoint(x, yFlipped) || this.getLinkAtCanvasPoint(x, yDirect);
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
    const cssColor = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
    const colors = {
      title: cssColor('--about-title', 'rgba(255, 255, 255, 0.95)'),
      titleGlow: cssColor('--about-title-glow', 'rgba(255, 255, 255, 0.3)'),
      divider: cssColor('--about-divider', 'rgba(255, 255, 255, 0.15)'),
      lineShadow: cssColor('--about-line-shadow', 'rgba(255, 255, 255, 0.15)'),
      bodyStrong: cssColor('--about-body-strong', 'rgba(255, 255, 255, 0.85)'),
      bodyDim: cssColor('--about-body-dim', 'rgba(255, 255, 255, 0.62)'),
      bodySoft: cssColor('--about-body-soft', 'rgba(255, 255, 255, 0.54)'),
      section: cssColor('--about-section', 'rgba(255, 255, 255, 0.88)'),
      list: cssColor('--about-list', 'rgba(255, 255, 255, 0.74)'),
      link: cssColor('--about-link', 'rgba(136, 255, 204, 0.86)'),
      linkHover: cssColor('--about-link-hover', 'rgba(184, 255, 224, 0.98)'),
      linkGlow: cssColor('--about-link-glow', 'rgba(136, 255, 204, 0.65)'),
      note: cssColor('--about-note', 'rgba(255, 255, 255, 0.34)'),
      scrollTrack: cssColor('--about-scroll-track', 'rgba(255, 255, 255, 0.12)'),
      scrollThumb: cssColor('--about-scroll-thumb', 'rgba(255, 255, 255, 0.42)'),
      scrollLabel: cssColor('--about-scroll-label', 'rgba(255, 255, 255, 0.38)'),
    };

    const titleFont = `600 42px ${uiSans}`;
    const bodyFont = `24px ${uiMonoLight}`;
    const sectionFont = `600 20px ${uiMono}`;
    const smallFont = `18px ${uiMono}`;

    // Fixed header
    ctx.font = titleFont;
    ctx.fillStyle = colors.title;
    ctx.shadowColor = colors.titleGlow;
    ctx.shadowBlur = 12;
    ctx.fillText('ABOUT', 40, 40);
    ctx.shadowBlur = 0;

    ctx.fillStyle = colors.divider;
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
      ctx.shadowColor = shadow > 0 ? colors.lineShadow : 'transparent';
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
        'is the pre-registration terminal for',
        'the .agent community — a coalition of',
        'builders, researchers, and companies',
        'working to secure .agent through ICANN.',
      ],
      bodyFont,
      colors.bodyStrong,
      34,
      14,
      6
    );

    drawLines(
      ['WHY AGENTS NEED NAMES'],
      sectionFont,
      colors.section,
      30,
      8,
      2
    );

    drawLines(
      [
        'Agents are becoming real participants',
        'on the internet. They handle support,',
        'manage calendars, negotiate deals.',
        '',
        'But right now, they\'re anonymous.',
        'No names. No accountability. No trust.',
        '',
        'When an agent books a flight for you,',
        'or negotiates a contract, or responds',
        'to a customer — people need to know:',
        'who built this? Who\'s accountable?',
        'Can I trust it?',
        '',
        'A name like acme-support.agent',
        'answers all three instantly.',
      ],
      smallFont,
      colors.list,
      28,
      16,
      0
    );

    drawLines(
      ['THE .AGENT COMMUNITY'],
      sectionFont,
      colors.section,
      30,
      8,
      2
    );

    drawLines(
      [
        'The .agent community is applying to ICANN',
        'for .agent — a dedicated top-level domain',
        'for AI agents. Not a product. Not a',
        'platform. A public namespace, governed',
        'by its members.',
        '',
        'Policies for who gets a name, how disputes',
        'are resolved, and what safety standards',
        'apply — decided by the community, not',
        'a single corporation.',
      ],
      smallFont,
      colors.list,
      28,
      16,
      0
    );

    drawLines(
      ['THIS TERMINAL'],
      sectionFont,
      colors.section,
      30,
      8,
      2
    );

    drawLines(
      [
        'Pre-registration records your interest',
        'in a .agent domain name. It\'s non-binding',
        '— names may change before .agent launches.',
        'But your certificate ID is permanent: a',
        'content-addressed hash that proves you',
        'were here, and when.',
        '',
        'Every registration strengthens the case',
        'for .agent at ICANN. The more agents that',
        'show up, the clearer the demand.',
      ],
      smallFont,
      colors.list,
      28,
      16,
      0
    );

    drawLines(
      ['AID — DISCOVERY PROTOCOL'],
      sectionFont,
      colors.section,
      30,
      8,
      2
    );

    drawLines(
      [
        'The community also builds AID — Agent',
        'Identity & Discovery. A DNS-based protocol',
        'so agents can publish who they are, where',
        'they live, and what they can do.',
        '',
        'When .agent launches, DMV pre-registrations',
        'feed into the official DNS-based system.',
        'The spec is open at aid.agentcommunity.org.',
      ],
      smallFont,
      colors.list,
      28,
      16,
      0
    );

    drawLines(
      ['GET INVOLVED'],
      sectionFont,
      colors.section,
      30,
      8,
      2
    );

    drawLines(
      [
        'This is an open community project. The AID',
        'spec, this terminal, and the governance',
        'framework are all open source.',
        '',
        'Register an agent. Share your card. Review',
        'the spec. Open a PR. The internet\'s next',
        'chapter needs more voices at the table.',
      ],
      smallFont,
      colors.list,
      28,
      16,
      0
    );

    drawLines(
      ['LINKS'],
      sectionFont,
      colors.section,
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
        ctx.fillStyle = isHovered ? colors.linkHover : colors.link;
        ctx.shadowColor = isHovered ? colors.linkGlow : 'transparent';
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
        'Pre-registration is non-binding.',
        'Certificate IDs are permanent.',
      ],
      smallFont,
      colors.note,
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

      ctx.fillStyle = colors.scrollTrack;
      ctx.fillRect(trackX, trackY, 2, trackH);

      const thumbH = Math.max(44, trackH * (trackH / (trackH + this.maxScroll)));
      const thumbTravel = trackH - thumbH;
      const thumbY = trackY + (this.scrollOffset / this.maxScroll) * thumbTravel;

      ctx.fillStyle = colors.scrollThumb;
      ctx.fillRect(trackX - 1, thumbY, 4, thumbH);

      if (this.scrollOffset < this.maxScroll - 2) {
        ctx.font = `12px ${uiMono}`;
        ctx.fillStyle = colors.scrollLabel;
        ctx.fillText('SCROLL', w - 76, h - 20);
      }
    }

    this.texture.needsUpdate = true;
  }
}
