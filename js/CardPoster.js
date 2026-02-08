import * as THREE from 'three';

const gsap = window.gsap;

export class CardPoster {
  constructor(scene) {
    this.scene = scene;

    // Card canvas
    this.cardWidth = 512;
    this.cardHeight = 320;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cardWidth;
    this.canvas.height = this.cardHeight;
    this.ctx = this.canvas.getContext('2d');

    // Texture
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;

    // Material (transparent until shown)
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });

    // Plane — positioned to the right of the TV
    const aspect = this.cardWidth / this.cardHeight;
    const planeHeight = 2.0;
    const planeWidth = planeHeight * aspect;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(planeWidth, planeHeight),
      this.material
    );
    this.mesh.position.set(4, 1, -0.5);
    this.mesh.rotation.y = -0.2;
    this.mesh.visible = false;

    this.scene.add(this.mesh);
  }

  show(formData) {
    this.drawCard(formData);
    this.texture.needsUpdate = true;
    this.mesh.visible = true;

    gsap.fromTo(this.material, { opacity: 0 }, {
      opacity: 1,
      duration: 1.2,
      ease: 'power2.out',
    });
  }

  drawCard(data) {
    const ctx = this.ctx;
    const w = this.cardWidth;
    const h = this.cardHeight;

    // Dark background
    ctx.fillStyle = '#0a0d0a';
    ctx.fillRect(0, 0, w, h);

    // Border
    ctx.strokeStyle = '#33ff88';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, w - 12, h - 12);

    // Inner border
    ctx.strokeStyle = '#1a5a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, 12, w - 24, h - 24);

    // Header
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.fillStyle = '#88ffcc';
    ctx.textBaseline = 'top';
    ctx.fillText('DMV VERIFICATION CERTIFICATE', 28, 28);

    // Divider
    ctx.fillStyle = '#1a5a3a';
    ctx.fillRect(28, 56, w - 56, 1);

    // Fields
    ctx.font = '14px "Courier New", monospace';
    const fields = [
      ['NAME', data.userName || '—'],
      ['AGENT', (data.agentName || '—') + '.agent'],
      ['EMAIL', data.email || '—'],
      ['TYPE', data.type || '—'],
      ['ORG', data.orgName || '—'],
    ];

    let y = 72;
    for (const [label, value] of fields) {
      // Label
      ctx.fillStyle = '#1a5a3a';
      ctx.fillText(label, 28, y);
      // Value
      ctx.fillStyle = '#33ff88';
      ctx.fillText(value, 130, y);
      y += 28;
    }

    // Serial at bottom
    const serial = 'DMV-' + new Date().getFullYear() + '-' +
      String(Math.floor(Math.random() * 99999)).padStart(5, '0');
    ctx.fillStyle = '#1a5a3a';
    ctx.font = '12px "Courier New", monospace';
    ctx.fillText(serial, 28, h - 30);

    // Scanline overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    for (let sy = 0; sy < h; sy += 3) {
      ctx.fillRect(0, sy, w, 1);
    }
  }
}
