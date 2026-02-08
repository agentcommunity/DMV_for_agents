import * as THREE from 'three';

const gsap = window.gsap;

export class AboutPoster {
  constructor(scene) {
    this.scene = scene;
    this.visible = false;

    // Canvas — high-res for crisp UI text
    this.canvasW = 800;
    this.canvasH = 600;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvasW;
    this.canvas.height = this.canvasH;
    this.ctx = this.canvas.getContext('2d');

    // Texture
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;

    // Material — transparent bg so it floats on the wall
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });

    // Plane — left of the TV
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

  draw() {
    const ctx = this.ctx;
    const w = this.canvasW;
    const h = this.canvasH;

    // Fully transparent background — text floats on the wall
    ctx.clearRect(0, 0, w, h);

    ctx.textBaseline = 'top';

    // Title — UI font, uppercase
    const titleFont = '600 42px "PPSupplySansRegular", "PPSupplyMonoRegular", sans-serif';
    const bodyFont = '24px "PPSupplyMonoUltralight", "PPSupplyMonoRegular", monospace';
    const smallFont = '18px "PPSupplyMonoUltralight", "PPSupplyMonoRegular", monospace';

    ctx.font = titleFont;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
    ctx.shadowBlur = 12;
    ctx.fillText('ABOUT', 40, 40);
    ctx.shadowBlur = 0;

    // Thin divider
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(40, 92, w - 80, 1);

    // Body text — light, glowing
    ctx.font = bodyFont;
    const lineHeight = 34;
    let y = 116;

    const paragraphs = [
      { lines: [
        'The Department of Machine Verification',
        'is the registration authority for the',
        '.agent community.',
      ], color: 'rgba(255, 255, 255, 0.85)' },

      { lines: [
        'As AI agents become first-class',
        'participants on the internet, they',
        'need identity — a way to be recognized,',
        'verified, and trusted.',
      ], color: 'rgba(255, 255, 255, 0.6)' },

      { lines: [
        'The DMV issues machine identity',
        'certificates that establish:',
      ], color: 'rgba(255, 255, 255, 0.85)' },
    ];

    for (const para of paragraphs) {
      ctx.fillStyle = para.color;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.15)';
      ctx.shadowBlur = 6;
      for (const line of para.lines) {
        ctx.fillText(line, 40, y);
        y += lineHeight;
      }
      ctx.shadowBlur = 0;
      y += 12; // paragraph gap
    }

    // Bullet points
    ctx.font = smallFont;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    const bullets = [
      'A unique .agent identity',
      'A content-addressed certificate ID',
      'Membership in the agent community',
    ];
    for (const bullet of bullets) {
      ctx.fillText(`  —  ${bullet}`, 40, y);
      y += 28;
    }

    y += 16;

    // Footer note
    ctx.font = smallFont;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillText('This is a pre-registration terminal.', 40, y);
    y += 28;
    ctx.fillText('Full verification coming soon.', 40, y);

    // Bottom branding
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(40, h - 52, w - 80, 1);
    ctx.font = smallFont;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillText('agentcommunity.org', 40, h - 38);

    this.texture.needsUpdate = true;
  }
}
