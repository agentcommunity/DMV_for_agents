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

  show(formData, instant = false) {
    this.drawCard(formData);
    this.texture.needsUpdate = true;
    this.mesh.visible = true;

    if (instant) {
      this.material.opacity = 1;
    } else {
      gsap.fromTo(this.material, { opacity: 0 }, {
        opacity: 1,
        duration: 1.2,
        ease: 'power2.out',
      });
    }
  }

  toPNG() {
    return this.canvas.toDataURL('image/png');
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
    ctx.font = '14px "Courier New", monospace';
    ctx.fillStyle = '#88ffcc';
    ctx.textBaseline = 'top';
    ctx.fillText('MACHINE IDENTITY CERTIFICATE', 28, 28);

    // Divider
    ctx.fillStyle = '#1a5a3a';
    ctx.fillRect(28, 48, w - 56, 1);

    // Agent name — big and prominent
    const agentName = (data.agentName || 'agent') + '.agent';
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.fillStyle = '#33ff88';
    ctx.shadowColor = '#33ff88';
    ctx.shadowBlur = 8;
    ctx.fillText(agentName, 28, 68);
    ctx.shadowBlur = 0;

    // Certificate ID
    const certId = data.certificateId || 'NOVA-000-000X';
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.fillStyle = '#88ffcc';
    ctx.shadowColor = '#88ffcc';
    ctx.shadowBlur = 4;
    ctx.fillText(certId, 28, 110);
    ctx.shadowBlur = 0;

    // Divider
    ctx.fillStyle = '#1a5a3a';
    ctx.fillRect(28, 144, w - 56, 1);

    // Pre-registration note
    ctx.font = '11px "Courier New", monospace';
    ctx.fillStyle = '#1a5a3a';
    ctx.fillText('Pre-registration certificate.', 28, h - 48);

    // DMV branding at bottom
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = '#1a5a3a';
    ctx.fillText('DEPT. OF MACHINE VERIFICATION', 28, h - 28);

    // Scanline overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    for (let sy = 0; sy < h; sy += 3) {
      ctx.fillRect(0, sy, w, 1);
    }
  }
}
