import * as THREE from 'three';

/**
 * Big "42" on the left side of the TV chassis.
 * Homage to The Hitchhiker's Guide to the Galaxy.
 */
export class WallNumber {
  constructor(scene) {
    this.scene = scene;

    // Canvas — 4K for crisp text on the 3D surface
    this.W = 4096;
    this.H = 4096;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');

    // Texture — max anisotropy for sharp text at oblique angles
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    // Plane sized to fit the TV's side panel
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.8),
      this.material
    );
    // Face outward from the TV's left side, slightly tilted like a sticker
    this.mesh.rotation.y = -Math.PI / 2;
    this.mesh.rotation.z = 0.12;  // ~7° tilt
    // Left face of TV body is at x = -1.695. Nudge just outside.
    this.mesh.position.set(-1.70, -0.1, 0.6);
    scene.add(this.mesh);

    this.draw();
  }

  /** Redraw for theme changes. */
  setTheme() {
    this.draw();
  }

  /** Render "42" onto the canvas. */
  draw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    const root = getComputedStyle(document.documentElement);
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 2800px "PPSupplyMonoRegular", monospace';
    ctx.fillText('42', W / 2, H / 2);

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
