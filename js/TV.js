import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CRTTerminal } from './CRTTerminal.js';

const gsap = window.gsap;

export class TV {
  constructor(parentDOM, label) {
    this.toneMappingExposureMax = 3.0;
    this.toneMappingExposureMin = 0.6;
    this.parent = parentDOM;
    this.isNightMode = false;
    this.label = label;

    // CRT terminal
    this.crt = new CRTTerminal(1024, 1024);
    this.crtTexture = new THREE.CanvasTexture(this.crt.canvas);
    this.crtTexture.encoding = THREE.sRGBEncoding;
    this.crtTexture.repeat.set(1.7, 1.7);
    this.crtTexture.offset.set(-0.64, -0.42);
    this.crtTexture.flipY = false;

    // Mouse
    this.mouseTarget = new THREE.Vector2(0, 0);
    this._NDC = { x: 0, y: 0 };
    this._intersects = [];

    // Sizes
    this.sizes = {
      width: this.parent.getBoundingClientRect().width,
      height: this.parent.getBoundingClientRect().height,
      get aspect() { return this.width / this.height; }
    };
    this.mouse = new THREE.Vector2(this.sizes.width / 2, this.sizes.height / 2);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.physicallyCorrectLights = true;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMappingExposure = this.toneMappingExposureMax;
    this.renderer.toneMapping = THREE.CineonToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._setRendererSizes();

    this.fogColor = 0x7a7a7a;
    this.fogColorDark = 0x454546;
    this.renderer.setClearColor(this.fogColor, 1);

    this.canvas = this.renderer.domElement;
    this.parent.prepend(this.canvas);

    this.model = null;
    this.triggerEl = null;
    this.screen = null;
    this.trigger = null;
    this.fakeTrigger = null;
    this.progress = 0;
    this.crtBooted = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(this.fogColor, 27, 29);

    this.camera = null;
    this.cameraPosition = { x: 0, y: -0.5, z: 20 };

    this.raycaster = new THREE.Raycaster();

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/');
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    this._animationEndCallbacks = [];

    document.addEventListener('mouseleave', (e) => {
      if (e.clientY <= 0 || e.clientX <= 0 ||
          e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        this.setMousePosition(this.sizes.width / 2, this.sizes.height / 2);
      }
    });
  }

  getScene() {
    return this.scene;
  }

  async init() {
    try { await this.loadModel(); }
    catch (err) { console.error('Error loading model:', err); }
    this.createCamera();
    this.createLights();
    this._render();
  }

  loadModel() {
    this.trigger = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.8, 1.8),
      new THREE.MeshBasicMaterial({ color: 0xff0000 })
    );
    this.fakeTrigger = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.8, 1.8),
      new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    );
    this.scene.add(this.trigger);
    this.trigger.visible = false;
    this.fakeTrigger.visible = false;
    this.trigger.position.set(-1.41, -1.71, 1.66);
    this.fakeTrigger.position.set(-1.41, -1.71, 1.66);

    if (window.innerWidth < 768) {
      this.trigger.position.set(0, 0, 2);
      this.trigger.scale.set(3, 3, 3);
    }

    return new Promise((resolve, reject) => {
      this.gltfLoader.load('hle_mirror/hle.io/models/tv1.glb', (gltf) => {
        this.model = gltf.scene;
        this.triggerEl = this.model.getObjectByName('Cube001');
        this.screen = this.model.getObjectByName('Glass');

        // CRT canvas texture on the screen
        if (this.screen) {
          this.screen.material = new THREE.MeshBasicMaterial({ map: this.crtTexture });
        }
        if (this.triggerEl) {
          this.triggerEl.material = new THREE.MeshBasicMaterial({ color: 0x33ff88 });
        }
        this.scene.add(gltf.scene);
        resolve();
      }, undefined, reject);
    });
  }

  createCamera() {
    this.camera = new THREE.PerspectiveCamera(45, this.sizes.aspect, 0.1, 100);
    this.camera.position.set(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);
  }

  createLights() {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);
    this.pointLight = new THREE.PointLight(0xffffff, 0.5);
    this.pointLight.position.set(0, 3, 0.5);
    this.scene.add(this.pointLight);
  }

  _setRendererSizes() {
    this.renderer.setSize(this.sizes.width, this.sizes.height);
  }

  _setLabelPosition() {
    if (!this.fakeTrigger || !this.camera) return;
    const point = this.fakeTrigger.position.clone();
    point.project(this.camera);
    const translate = {
      x: point.x * this.sizes.width * 0.5 - 40,
      y: -point.y * this.sizes.height * 0.5 - 4
    };
    this.label.style.transform = `translate(${translate.x}px, ${translate.y}px)`;
  }

  animateCameraPosition(progress) {
    this.progress = progress;
    // Boot the CRT when user scrolls close enough
    if (progress > 0.6 && !this.crtBooted) {
      this.crtBooted = true;
      this.crt.turnOn();
    }
    if (progress > 0.99) {
      this._animationEndCallbacks.forEach(cb => cb());
      this._animationEndCallbacks = [];
    }
  }

  rotateCamera() {
    if (!this.camera) return;
    this.mouseTarget.lerp(this.toNDC(), 0.05);
    this.camera.position.x = 0.5 * 14.7 * this.mouseTarget.x * (1 - this.progress);
    this.camera.position.z = (1 - this.progress) * 20 + this.progress * 3.6;
    this.camera.position.y = (1 - this.progress) * -0.5 + this.progress * 0.5;
    this.camera.lookAt(0, 0.5, 0);
  }

  toggleNightModeTV() {
    let target, triggerPos;
    if (this.renderer.toneMappingExposure < 1) {
      target = this.toneMappingExposureMax;
      triggerPos = 0;
      this.scene.fog = new THREE.Fog(this.fogColor, 27, 29);
      this.renderer.setClearColor(this.fogColor, 1);
      this.isNightMode = false;
    } else {
      target = this.toneMappingExposureMin;
      triggerPos = 0.45;
      this.scene.fog = new THREE.Fog(this.fogColorDark, 27, 29);
      this.renderer.setClearColor(this.fogColorDark, 1);
      this.isNightMode = true;
    }
    gsap.to(this.renderer, { toneMappingExposure: target, duration: 0.4, overwrite: true });
    if (this.triggerEl) {
      gsap.to(this.triggerEl.position, { x: triggerPos, duration: 0.4, overwrite: true });
    }
    this.crt.setColorScheme(this.isNightMode ? 'orange' : 'green');
    if (this.triggerEl) {
      this.triggerEl.material.color.setHex(this.isNightMode ? 0xcc6622 : 0x33ff88);
    }
  }

  _intersect() {
    if (!this.camera || !this.trigger) return;
    this.raycaster.setFromCamera(this._NDC, this.camera);
    this._intersects = this.raycaster.intersectObjects([this.trigger]);
  }

  getIntersects() {
    this._intersect();
    return this._intersects.length > 0 ? ['button'] : ['none'];
  }

  _render() {
    // Update CRT terminal canvas every frame
    this.crt.update();
    this.crtTexture.needsUpdate = true;

    if (this.camera) {
      this.renderer.render(this.scene, this.camera);
      this._setLabelPosition();
      this.rotateCamera();
    }
    requestAnimationFrame(() => this._render());
  }

  setMousePosition(x, y) {
    this.mouse.x = x;
    this.mouse.y = y;
    this._NDC = this.toNDC();
  }

  toNDC() {
    return {
      x: (this.mouse.x / this.sizes.width) * 2 - 1,
      y: -(this.mouse.y / this.sizes.height) * 2 + 1
    };
  }

  resize() {
    const box = this.parent.getBoundingClientRect();
    this.sizes.width = box.width;
    this.sizes.height = box.height;
    this._setRendererSizes();
    this.camera.aspect = this.sizes.aspect;
    this.camera.updateProjectionMatrix();
  }

  on(event, cb) {
    if (event === 'animationEnd') this._animationEndCallbacks.push(cb);
  }
}
