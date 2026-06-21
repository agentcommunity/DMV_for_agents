import * as THREE from 'three';

const gsap = window.gsap;

export class WallSign {
  constructor(scene) {
    this.scene = scene;
    this.isOn = false;
    this._ambientInterval = null;

    // Canvas
    this.W = 2048;
    this.H = 384;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');

    // Texture
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;

    // Mesh
    const aspect = this.W / this.H;
    const h = 1.0;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(h * aspect, h),
      this.material
    );
    this.mesh.position.set(0, 3.0, -0.5);
    scene.add(this.mesh);

    // Draw content (invisible until flickerOn)
    this.draw();
  }

  /** Trigger the fluorescent tube startup sequence. */
  flickerOn() {
    if (this.isOn) return;
    this.isOn = true;

    const mat = this.material;
    const tl = gsap.timeline({
      onComplete: () => this._startAmbientFlicker(),
    });

    // A longer, gappier fluorescent struggle — several catch-attempts separated by
    // beats of full darkness, so the sign "shows" then drops out before finally holding.

    // 1. First catch-attempt — a flash, then dies
    tl.to(mat, { opacity: 0.4, duration: 0.06 });
    tl.to(mat, { opacity: 0, duration: 0.08 });

    // 2. Big dark gap
    tl.to(mat, { opacity: 0, duration: 0.4 });

    // 3. Second attempt — stutters and dies
    tl.to(mat, { opacity: 0.6, duration: 0.05 });
    tl.to(mat, { opacity: 0.05, duration: 0.05 });
    tl.to(mat, { opacity: 0.45, duration: 0.05 });
    tl.to(mat, { opacity: 0, duration: 0.06 });

    // 4. Big dark gap
    tl.to(mat, { opacity: 0, duration: 0.32 });

    // 5. Third attempt — rapid sputter cluster
    tl.to(mat, { opacity: 0.7, duration: 0.04 });
    tl.to(mat, { opacity: 0.2, duration: 0.04 });
    tl.to(mat, { opacity: 0.85, duration: 0.05 });
    tl.to(mat, { opacity: 0.1, duration: 0.05 });

    // 6. Short gap, then it catches and holds
    tl.to(mat, { opacity: 0, duration: 0.18 });
    tl.to(mat, { opacity: 1.0, duration: 0.35, ease: 'power2.out' });
  }

  /** Subtle ambient flicker — cheap fluorescent tube feel. */
  _startAmbientFlicker() {
    this._stopAmbientFlicker();
    const dip = () => {
      if (!this.isOn) return;
      gsap.to(this.material, {
        opacity: 0.92,
        duration: 0.04,
        yoyo: true,
        repeat: 1,
      });
    };
    const scheduleNext = () => {
      if (!this.isOn) return;
      const delay = 4000 + Math.random() * 3000; // 4-7s
      this._ambientInterval = setTimeout(() => {
        dip();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  _stopAmbientFlicker() {
    if (this._ambientInterval) {
      clearTimeout(this._ambientInterval);
      this._ambientInterval = null;
    }
  }

  /** Redraw for theme changes. */
  setTheme() {
    this.draw();
  }

  /** Render sign text onto the canvas. */
  draw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    const root = getComputedStyle(document.documentElement);
    const fontSans = root.getPropertyValue('--floating-ui-font-sans').trim()
      || '"PPSupplySansRegular", sans-serif';
    const fontMono = root.getPropertyValue('--floating-ui-font-mono').trim()
      || '"PPSupplyMonoRegular", monospace';
    const primary = root.getPropertyValue('--ui-text-primary').trim()
      || 'rgba(16, 16, 17, 0.95)';
    const secondary = root.getPropertyValue('--ui-text-secondary').trim()
      || 'rgba(16, 16, 17, 0.72)';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Title
    ctx.fillStyle = primary;
    ctx.font = `600 96px ${fontSans}`;
    ctx.letterSpacing = '4px';
    ctx.fillText('DEPT. OF MACHINE VERIFICATION', W / 2, H * 0.38);

    // Subtitle
    ctx.fillStyle = secondary;
    ctx.font = `64px ${fontMono}`;
    ctx.letterSpacing = '3px';
    ctx.fillText('SELF-SERVE KIOSK', W / 2, H * 0.72);

    this.texture.needsUpdate = true;
  }

  dispose() {
    this._stopAmbientFlicker();
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
