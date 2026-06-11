import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CRTTerminal } from './CRTTerminal.js?v=22';

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

    // Card zoom
    this.cardMesh = null;
    this.isCardZoomed = false;
    this.savedCameraState = null;

    // About zoom
    this.aboutMesh = null;
    this.isAboutZoomed = false;
    this.savedAboutCameraState = null;

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
    this.modelLoaded = false;
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
    // Fit target for card/about zoom framing (CRT screen dimensions).
    this.tvFitSize = { width: 2.8, height: 2.4 };
    // Fit target for scroll-zoom framing (derived from screen + bezel padding).
    this.tvFrameSize = { width: 2.8 * 1.45, height: 2.4 * 1.45 };
    this.viewportProfiles = [
      // Tuned against common mobile widths:
      // 320-360 (small phones), 375-390 (mid phones), 412-430 (large phones)
      {
        name: 'small-phone',
        maxWidth: 360,
        scrollMargin: 1.16,
        scrollExtraZ: 0.25,
        scrollY: 0.30,
        scrollLookY: 0.32,
        cardMargin: 1.62,
        cardYOffset: 0.56,
        aboutMargin: 1.16,
      },
      {
        name: 'phone',
        maxWidth: 390,
        scrollMargin: 1.14,
        scrollExtraZ: 0.2,
        scrollY: 0.35,
        scrollLookY: 0.37,
        cardMargin: 1.54,
        cardYOffset: 0.50,
        aboutMargin: 1.14,
      },
      {
        name: 'large-phone',
        maxWidth: 430,
        scrollMargin: 1.12,
        scrollExtraZ: 0.15,
        scrollY: 0.40,
        scrollLookY: 0.42,
        cardMargin: 1.48,
        cardYOffset: 0.46,
        aboutMargin: 1.12,
      },
      {
        name: 'tablet',
        maxWidth: 768,
        scrollMargin: 1.10,
        scrollExtraZ: 0.08,
        scrollY: 0.46,
        scrollLookY: 0.48,
        cardMargin: 1.40,
        cardYOffset: 0.34,
        aboutMargin: 1.11,
      },
      {
        name: 'desktop',
        maxWidth: Infinity,
        scrollMargin: 1.08,
        scrollExtraZ: 0,
        scrollY: 0.5,
        scrollLookY: 0.5,
        cardMargin: 1.3,
        cardYOffset: 0.2,
        aboutMargin: 1.1,
      },
    ];

    this.raycaster = new THREE.Raycaster();

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/');
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    this._animationEndCallbacks = [];
    this._renderCallbacks = [];
    this._clock = new THREE.Clock();

    document.addEventListener('mouseleave', (e) => {
      if (e.clientY <= 0 || e.clientX <= 0 ||
          e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        const rect = this.parent.getBoundingClientRect();
        this.setMousePosition(rect.left + this.sizes.width / 2, rect.top + this.sizes.height / 2);
      }
    });
  }

  getScene() {
    return this.scene;
  }

  async init(options = {}) {
    if (!options.skipModel) {
      try { await this.loadModel(); }
      catch (err) { console.error('Error loading model:', err); }
    }
    this.createCamera();
    this.createLights();
    this._render();
  }

  async loadModelDeferred() {
    if (this.modelLoaded) return;
    if (this._modelLoadingPromise) return this._modelLoadingPromise;
    this._modelLoadingPromise = this.loadModel()
      .catch(err => console.error('Error loading model:', err))
      .finally(() => { this._modelLoadingPromise = null; });
    return this._modelLoadingPromise;
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

    // On mobile keep the lamp-pull hit box slightly larger than the visible
    // mesh for fat-finger tolerance, but NOT 3× and NOT recentered on the TV
    // — that turned the whole TV body into a night-mode toggle.
    if (window.innerWidth < 768) {
      this.trigger.scale.set(1.4, 1.4, 1.4);
    }

    return new Promise((resolve, reject) => {
      this.crt.setLoadProgress(0);
      this.gltfLoader.load('/models/tv1.glb', (gltf) => {
        this.crt.loadComplete();
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
        if (this.screen) {
          const screenBounds = new THREE.Box3().setFromObject(this.screen);
          const screenSize = new THREE.Vector3();
          screenBounds.getSize(screenSize);
          if (screenSize.x > 0 && screenSize.y > 0) {
            this.tvFitSize = { width: screenSize.x, height: screenSize.y };
          }
        }
        // Derive bezel/frame size from screen bounds + padding.
        // The TV bezel is roughly 45% wider and taller than the CRT glass.
        this.tvFrameSize = {
          width:  this.tvFitSize.width  * 1.45,
          height: this.tvFitSize.height * 1.45
        };
        this.modelLoaded = true;
        resolve();
      }, (xhr) => {
        if (xhr.lengthComputable && xhr.total > 0) {
          this.crt.setLoadProgress(xhr.loaded / xhr.total);
        }
      }, (err) => {
        this.crt.loadComplete();
        reject(err);
      });
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
    if (!this.camera || this.isCardZoomed || this.isAboutZoomed) return;
    this.mouseTarget.lerp(this.toNDC(), 0.05);
    this.camera.position.x = 0.5 * 14.7 * this.mouseTarget.x * (1 - this.progress);
    // Fit terminal framing dynamically so narrow phones don't over-zoom.
    const { endZ, endY, lookY } = this._getScrollEndCameraState();
    this.camera.position.z = (1 - this.progress) * 20 + this.progress * endZ;
    this.camera.position.y = (1 - this.progress) * -0.5 + this.progress * endY;
    this.camera.lookAt(0, lookY, 0);
  }

  _getScrollEndCameraState() {
    const profile = this._getViewportProfile();
    const aspect = this.sizes.aspect;
    const isPortrait = aspect < 1;
    let margin = profile.scrollMargin;
    if (isPortrait && aspect < 0.55) margin += 0.03;
    if (isPortrait && aspect < 0.5) margin += 0.02;

    // Use full TV frame/bezel bounds so the camera stops with bezel edges
    // aligned to the viewport, rather than zooming past them to show only the screen glass.
    // On portrait phones we intentionally allow light side cropping of the TV shell
    // so the CRT doesn't become too tiny from strict full-width fit.
    const fitWidth = isPortrait ? this.tvFrameSize.width * 0.70 : this.tvFrameSize.width;
    let endZ = this._zoomDistanceToFit(fitWidth, this.tvFrameSize.height, margin);
    endZ += profile.scrollExtraZ;
    if (isPortrait && aspect < 0.45) endZ += 0.1;

    const endY = isPortrait ? profile.scrollY : 0.5;
    const lookY = isPortrait ? profile.scrollLookY : 0.5;
    return { endZ, endY, lookY };
  }

  // Compute camera distance so a rectangle of given world-size fits in viewport
  _zoomDistanceToFit(width, height, margin = 1.15) {
    const fovRad = this.camera.fov * Math.PI / 180;
    const halfTan = Math.tan(fovRad / 2);
    const aspect = this.sizes.aspect;
    const distH = (height / 2) / halfTan;
    const distW = (width / 2) / (halfTan * aspect);
    return Math.max(distH, distW) * margin;
  }

  _getViewportProfile() {
    const width = this.sizes.width || window.innerWidth || 1024;
    for (const profile of this.viewportProfiles) {
      if (width <= profile.maxWidth) return profile;
    }
    return this.viewportProfiles[this.viewportProfiles.length - 1];
  }

  // Position camera along a mesh's facing normal at the given distance
  _zoomTarget(mesh, dist) {
    const pos = mesh.position;
    const ry = mesh.rotation.y;
    return {
      x: pos.x + Math.sin(ry) * dist,
      y: pos.y,
      z: pos.z + Math.cos(ry) * dist,
    };
  }

  // --- Card Zoom ---

  setCardMesh(mesh) {
    this.cardMesh = mesh;
  }

  _getCardZoomPose() {
    const geo = this.cardMesh.geometry?.parameters || { width: 1.7, height: 2.4 };
    const profile = this._getViewportProfile();
    const aspect = this.sizes.aspect;
    let margin = profile.cardMargin;
    if (aspect < 0.55) margin += 0.05;
    if (aspect < 0.48) margin += 0.04;
    const dist = this._zoomDistanceToFit(geo.width, geo.height, margin);
    const target = this._zoomTarget(this.cardMesh, dist);
    target.y -= aspect < 1 ? profile.cardYOffset : 0.2;
    const lookAt = this.cardMesh.position;
    return { target, lookAt };
  }

  _applyCardZoomInstant() {
    if (!this.camera || !this.cardMesh) return;
    const { target, lookAt } = this._getCardZoomPose();
    this.camera.position.set(target.x, target.y, target.z);
    this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
  }

  // Instantly position camera at card (no animation, for permalink mode)
  jumpToCard() {
    if (!this.camera || !this.cardMesh) return;
    this.isCardZoomed = true;
    this.progress = 1; // Prevent rotateCamera from overriding
    this._applyCardZoomInstant();
    // Zoom-out goes to initial far position so new visitors see the full scene
    this.savedCameraState = {
      x: this.cameraPosition.x,
      y: this.cameraPosition.y,
      z: this.cameraPosition.z,
    };
  }

  zoomToCard() {
    if (!this.camera || !this.cardMesh || this.isCardZoomed) return;
    this.isCardZoomed = true;
    this.savedCameraState = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
    const { target, lookAt } = this._getCardZoomPose();

    gsap.to(this.camera.position, {
      x: target.x, y: target.y, z: target.z,
      duration: 0.8, ease: 'power2.inOut',
      onUpdate: () => this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z),
      onComplete: () => this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z),
    });
  }

  zoomOutFromCard() {
    if (!this.camera || !this.isCardZoomed || !this.savedCameraState) return;
    const saved = this.savedCameraState;
    const cardPos = this.cardMesh.position;
    // If returning to the initial far position, use a longer animation
    const isFarZoom = saved.z > 10;
    const duration = isFarZoom ? 1.4 : 0.8;
    // Smoothly transition lookAt from card → scene center
    const lookTarget = isFarZoom ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0.5, z: 0 };
    const look = { x: cardPos.x, y: cardPos.y, z: cardPos.z };
    gsap.to(look, { ...lookTarget, duration, ease: 'power2.inOut' });
    gsap.to(this.camera.position, {
      x: saved.x, y: saved.y, z: saved.z,
      duration, ease: 'power2.inOut',
      onUpdate: () => this.camera.lookAt(look.x, look.y, look.z),
      onComplete: () => {
        this.camera.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);
        this.isCardZoomed = false;
        this.savedCameraState = null;
        // Reset progress so rotateCamera drives from the right state
        if (isFarZoom) this.progress = 0;
      },
    });
  }

  // --- About Zoom ---

  setAboutMesh(mesh) {
    this.aboutMesh = mesh;
  }

  _getAboutZoomPose() {
    const geo = this.aboutMesh.geometry?.parameters || { width: 4, height: 3 };
    const profile = this._getViewportProfile();
    const margin = this.sizes.aspect < 1 ? profile.aboutMargin : 1.1;
    const dist = this._zoomDistanceToFit(geo.width, geo.height, margin);
    const target = this._zoomTarget(this.aboutMesh, dist);
    const lookAt = this.aboutMesh.position;
    return { target, lookAt };
  }

  _applyAboutZoomInstant() {
    if (!this.camera || !this.aboutMesh) return;
    const { target, lookAt } = this._getAboutZoomPose();
    this.camera.position.set(target.x, target.y, target.z);
    this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
  }

  zoomToAbout() {
    if (!this.camera || !this.aboutMesh || this.isAboutZoomed) return;
    this.isAboutZoomed = true;
    this.savedAboutCameraState = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
    const { target, lookAt } = this._getAboutZoomPose();

    gsap.to(this.camera.position, {
      x: target.x, y: target.y, z: target.z,
      duration: 0.8, ease: 'power2.inOut',
      onUpdate: () => this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z),
      onComplete: () => this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z),
    });
  }

  zoomOutFromAbout() {
    if (!this.camera || !this.isAboutZoomed || !this.savedAboutCameraState) return;
    const saved = this.savedAboutCameraState;
    const aboutPos = this.aboutMesh.position;
    // Smoothly transition lookAt from about poster → TV center
    const look = { x: aboutPos.x, y: aboutPos.y, z: aboutPos.z };
    gsap.to(look, { x: 0, y: 0.5, z: 0, duration: 0.8, ease: 'power2.inOut' });
    gsap.to(this.camera.position, {
      x: saved.x, y: saved.y, z: saved.z,
      duration: 0.8, ease: 'power2.inOut',
      onUpdate: () => this.camera.lookAt(look.x, look.y, look.z),
      onComplete: () => {
        this.camera.lookAt(0, 0.5, 0);
        this.isAboutZoomed = false;
        this.savedAboutCameraState = null;
      },
    });
  }

  toggleNightModeTV() {
    let target, triggerPos;
    if (this.renderer.toneMappingExposure < 1) {
      target = this.toneMappingExposureMax;
      triggerPos = 0;
      this.scene.fog.color.setHex(this.fogColor);
      this.renderer.setClearColor(this.fogColor, 1);
      this.isNightMode = false;
    } else {
      target = this.toneMappingExposureMin;
      triggerPos = 0.45;
      this.scene.fog.color.setHex(this.fogColorDark);
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
    const targets = [this.trigger];
    // The CRT glass is the explicit zoom target — click it to slow-zoom in.
    // (Avoids the "tap anywhere on the TV" ambiguity.)
    if (this.screen) targets.push(this.screen);
    // Include card mesh if visible
    if (this.cardMesh && this.cardMesh.visible) {
      targets.push(this.cardMesh);
    }
    this._intersects = this.raycaster.intersectObjects(targets);
  }

  getIntersects() {
    this._intersect();
    if (this._intersects.length === 0) return ['none'];
    const results = [];
    for (const hit of this._intersects) {
      if (hit.object === this.cardMesh) {
        results.push('card');
      } else if (hit.object === this.trigger) {
        results.push('button');
      } else if (hit.object === this.screen) {
        results.push('screen');
      }
    }
    return results.length > 0 ? results : ['none'];
  }

  getIntersectsAt(clientX, clientY) {
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      this.setMousePosition(clientX, clientY);
    }
    return this.getIntersects();
  }

  getMeshIntersectionAt(mesh, clientX, clientY) {
    if (!mesh || !this.camera) return null;
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      this.setMousePosition(clientX, clientY);
    }
    this.raycaster.setFromCamera(this._NDC, this.camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    return hits.length > 0 ? hits[0] : null;
  }

  getMeshIntersectionAtNDC(mesh, ndcX = 0, ndcY = 0) {
    if (!mesh || !this.camera) return null;
    const x = Number.isFinite(ndcX) ? ndcX : 0;
    const y = Number.isFinite(ndcY) ? ndcY : 0;
    this.raycaster.setFromCamera({ x, y }, this.camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    return hits.length > 0 ? hits[0] : null;
  }

  getCRTSurfacePointAt(clientX, clientY) {
    if (!this.screen || !this.crt || !this.crtTexture) return null;
    const hit = this.getMeshIntersectionAt(this.screen, clientX, clientY);
    if (!hit?.uv) return null;

    const uv = hit.uv.clone
      ? hit.uv.clone()
      : new THREE.Vector2(hit.uv.x, hit.uv.y);

    this.crtTexture.updateMatrix();
    uv.applyMatrix3(this.crtTexture.matrix);

    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const u = clamp01(uv.x);
    const v = clamp01(uv.y);

    return {
      x: u * this.crt.w,
      y: (1 - v) * this.crt.h,
      altY: v * this.crt.h,
    };
  }

  onRender(cb) {
    this._renderCallbacks.push(cb);
  }

  _render() {
    const dt = this._clock.getDelta();

    // Update CRT terminal canvas (only uploads texture when content changed)
    this.crt.update();
    if (this.crt.needsTextureUpload) {
      this.crtTexture.needsUpdate = true;
      this.crt.needsTextureUpload = false;
    }

    // Fire render callbacks (used by HoloCard etc.)
    for (const cb of this._renderCallbacks) cb(dt);

    if (this.camera) {
      this.renderer.render(this.scene, this.camera);
      this._setLabelPosition();
      this.rotateCamera();
    }
    requestAnimationFrame(() => {
      if (document.hidden) {
        const resume = () => {
          document.removeEventListener('visibilitychange', resume);
          this._clock.getDelta(); // discard accumulated delta
          this._render();
        };
        document.addEventListener('visibilitychange', resume);
        return;
      }
      this._render();
    });
  }

  setMousePosition(x, y) {
    const rect = this.parent.getBoundingClientRect();
    this.mouse.x = x - rect.left;
    this.mouse.y = y - rect.top;
    this._NDC = this.toNDC();
  }

  toNDC() {
    const width = this.sizes.width || 1;
    const height = this.sizes.height || 1;
    return {
      x: (this.mouse.x / width) * 2 - 1,
      y: -(this.mouse.y / height) * 2 + 1
    };
  }

  resize() {
    if (!this.camera) return;
    const box = this.parent.getBoundingClientRect();
    this.sizes.width = box.width;
    this.sizes.height = box.height;
    this._setRendererSizes();
    this.camera.aspect = this.sizes.aspect;
    this.camera.updateProjectionMatrix();
    if (this.isCardZoomed) {
      this._applyCardZoomInstant();
    }
    if (this.isAboutZoomed) {
      this._applyAboutZoomInstant();
    }
  }

  on(event, cb) {
    if (event === 'animationEnd') this._animationEndCallbacks.push(cb);
  }
}
