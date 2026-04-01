import * as THREE from 'three';

/**
 * Big "42" on the left side of the TV chassis.
 * Homage to The Hitchhiker's Guide to the Galaxy.
 */
export class WallNumber {
  constructor(scene) {
    this.scene = scene;

    // Canvas — small, matched to the plane size for crisp text
    this.W = 256;
    this.H = 256;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');

    // Texture — no mipmaps, linear filter for sharp text
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.encoding = THREE.sRGBEncoding;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    // Stack a few planes with tiny offset for subtle depth/weight
    this.group = new THREE.Group();
    this.geometry = new THREE.PlaneGeometry(0.585, 0.585);
    const layers = 3;
    const layerGap = 0.003;
    for (let i = 0; i < layers; i++) {
      const plane = new THREE.Mesh(this.geometry, this.material);
      plane.position.z = i * layerGap;
      this.group.add(plane);
    }

    // Face outward from the TV's left side, slightly tilted like a sticker
    this.group.rotation.y = -Math.PI / 2;
    this.group.rotation.z = 0.12;  // ~7° tilt
    // Left face of TV body is at x = -1.695. Nudge just outside.
    this.group.position.set(-1.70, -0.1, 0.6);
    scene.add(this.group);

    this.draw();
  }

  /** Render "42" onto the canvas. Color is intentionally theme-invariant. */
  draw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 175px "PPSupplyMonoRegular", monospace';
    ctx.fillText('42', W / 2, H / 2);

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.group);
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
