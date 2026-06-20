/**
 * volumetric-pass.js
 * Reusable volumetric god-ray pass, ported verbatim from prototype-volumetric.html.
 *
 * API:
 *   createVolumetricPass(THREE, opts?) → { fsQuad, volMat, sun, group, ready,
 *     setReady(b), updateUniforms(sceneRT, camera), driveArc(a, p), dispose() }
 *
 * opts:
 *   subject  — THREE.Vector3, default (0, 0.3, 0.4)
 *
 * The caller (TV.js / Task 3) is responsible for:
 *   - Creating the colour+depth WebGLRenderTarget (sceneRT) and passing it to updateUniforms()
 *   - Adding `group` to the scene
 *   - Calling renderer.setRenderTarget(null) + fsQuad.render(renderer) each frame
 *
 * Import path (via importmap):
 *   import { createVolumetricPass } from './js/volumetric-pass.js?v=1';
 *
 * FullScreenQuad is loaded from the same three/addons importmap entry used by TV.js.
 */

import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const WARM = 0xffb86b;

export function createVolumetricPass(THREE, opts = {}) {
  const SUBJECT = opts.subject
    ? opts.subject.clone()
    : new THREE.Vector3(0, 0.3, 0.4);

  // ─────────────────────────────────────────────────────────────────────────
  // volMat — verbatim port of prototype passMat ShaderMaterial
  // INCLUDING: soft shadow test (1.0 - smoothstep), occMask / foreground rank-2
  // occlusion gate, and 1.0 - exp(-glow) exposure rolloff.
  // ─────────────────────────────────────────────────────────────────────────
  const volMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse:      { value: null },
      tDepth:        { value: null },
      uInvProj:      { value: new THREE.Matrix4() },
      uCamWorld:     { value: new THREE.Matrix4() },
      uCamPos:       { value: new THREE.Vector3() },
      uMode:         { value: 1 }, // 1 = debug worldpos, 0 = passthrough (kept for parity)
      uShadowMap:    { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uLightColor:   { value: new THREE.Color(WARM) },
      uDensity:      { value: 0.8 },
      uIntensity:    { value: 1.0 },
      uMaxDist:      { value: 50.0 },   // default 50 (main cam far=100); prototype used 60 with far=400
      uSteps:        { value: 56.0 },
      uLightDir:     { value: new THREE.Vector3() },
      uG:            { value: 0.6 },
    },

    // Vertex shader — verbatim
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,

    // Fragment shader — verbatim copy from prototype-volumetric.html passMat
    fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec3 uCamPos; uniform int uMode;
    uniform sampler2D uShadowMap; uniform mat4 uShadowMatrix;
    uniform vec3 uLightColor; uniform float uDensity; uniform float uIntensity; uniform float uMaxDist;
    uniform float uSteps; uniform vec3 uLightDir; uniform float uG;
    float bayer4(vec2 p){
      // 4x4 ordered dither, returns [0,1)
      int x = int(mod(p.x,4.0)); int y = int(mod(p.y,4.0));
      int idx = x + y*4;
      float m[16];
      m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;
      m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
      float v=0.0; for(int i=0;i<16;i++){ if(i==idx) v=m[i]; }
      return v/16.0;
    }
    float hg(float cosT, float g){
      float g2=g*g; float denom=1.0+g2-2.0*g*cosT;
      return (1.0-g2)/(4.0*3.14159265*pow(max(denom,1e-3),1.5));
    }
    vec3 worldFromDepth(vec2 uv, float rawDepth){
      // NDC (note three depth texture stores [0,1])
      vec4 ndc = vec4(uv*2.0-1.0, rawDepth*2.0-1.0, 1.0);
      vec4 view = uInvProj * ndc; view /= view.w;        // view space
      vec4 world = uCamWorld * view;                      // world space
      return world.xyz;
    }
    float sampleShadow(vec3 worldPos){
      vec4 sc = uShadowMatrix * vec4(worldPos, 1.0); sc /= sc.w; // three's matrix → [0,1] uv + depth
      // VOLUMETRIC beam membership: a directional light scatters in ALL open air, which washes the
      // whole sky to white. Confine scattering to the light's frustum (the beam) so the silhouette's
      // shadow shaft reads against a dark sky. Outside the frustum = not in the beam = no scatter.
      if (sc.x<0.0||sc.x>1.0||sc.y<0.0||sc.y>1.0||sc.z>1.0) return 0.0;
      float occ = texture2D(uShadowMap, sc.xy).x;                       // stored nearest depth [0,1]
      float lit = 1.0 - smoothstep(0.0, 0.0015, (sc.z - 0.0015) - occ);  // soft shadow test (de-bands the rays)
      vec2 e = smoothstep(0.0, 0.18, sc.xy) * smoothstep(0.0, 0.18, 1.0 - sc.xy); // soft beam edges
      return lit * e.x * e.y;
    }
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float d = texture2D(tDepth, vUv).x;

      // ray from camera through this pixel, out to the scene hit (or uMaxDist for sky)
      vec3 hit;
      if (d >= 1.0){ hit = uCamPos + normalize(worldFromDepth(vUv, 0.999) - uCamPos) * uMaxDist; }
      else { hit = worldFromDepth(vUv, d); }
      vec3 ro = uCamPos;
      vec3 rd = hit - ro;
      float marchLen = min(length(rd), uMaxDist);
      rd = normalize(rd);

      float fsteps = clamp(uSteps, 8.0, 96.0);
      float stepSize = marchLen / fsteps;
      float jitter = bayer4(gl_FragCoord.xy);            // break banding
      float accum = 0.0;
      vec3 p = ro + rd * stepSize * jitter;
      for (int i=0;i<96;i++){
        if (float(i) >= fsteps) break;
        float lit = sampleShadow(p);
        // distance fog falloff so near-camera haze doesn't dominate
        float fog = exp(-length(p - ro) * 0.02);
        accum += lit * fog;
        p += rd * stepSize;
      }
      float phase = hg(dot(rd, normalize(uLightDir)), uG); // forward scatter toward the lamp
      // 0.02 maps the ~35-unit lit-air integral back into a sane [0,1]-ish range so density~1 reads
      // as a soft beam rather than a blown-white wall.
      accum *= stepSize * uDensity * 0.02 * (0.4 + 1.6 * phase);
      vec3 glow = uLightColor * accum * uIntensity;
      glow = vec3(1.0) - exp(-glow);                       // exposure rolloff: saturate gracefully, never hard-clip
      // Screen-space source-halo occlusion (the missing camera-side gate). In-scatter from lit haze between
      // the camera and the monitor screen-projects OVER the near-black silhouette and reads as rays. Sky
      // pixels (d>=1) keep full glow (the backdrop beams); over solid foreground, fade glow by the underlying
      // pixel brightness so the dark silhouette + its shadow-shaft stay clean while the lit ledge keeps glow.
      // Uses col (already has clean baked shadows) — no extra shadow fetch, no acne, camera-distance-agnostic.
      float occMask = smoothstep(0.02, 0.14, dot(col, vec3(0.299, 0.587, 0.114)));
      float foreground = step(d, 0.9999);
      glow *= mix(1.0, occMask, foreground);
      gl_FragColor = vec4(col + glow, 1.0);
    }`,

    depthTest: false,
    depthWrite: false,
  });

  const fsQuad = new FullScreenQuad(volMat);

  // ─────────────────────────────────────────────────────────────────────────
  // Sun (hero shadow-casting DirectionalLight) — verbatim from prototype
  // ─────────────────────────────────────────────────────────────────────────
  const sun = new THREE.DirectionalLight(WARM, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -7; sc.right = 7; sc.top = 7; sc.bottom = -7;
  sc.near = 1; sc.far = 120;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;

  // Initial position — matches prototype's starting pose before driveArc is called
  sun.position.set(2, 4, -9);
  sun.target.position.copy(SUBJECT);

  // group holds sun + sun.target; caller adds this group to the scene
  const group = new THREE.Group();
  group.add(sun, sun.target);

  // ready flag — Task 3 sets this to true once the GLB + shadow map are initialized
  let ready = false;

  // ─────────────────────────────────────────────────────────────────────────
  // Internal state — light color tracked separately so driveArc can tint it
  // ─────────────────────────────────────────────────────────────────────────
  const _lightColor = new THREE.Color(WARM);

  // ─────────────────────────────────────────────────────────────────────────
  // smooth helper — verbatim from prototype
  // ─────────────────────────────────────────────────────────────────────────
  function _smooth(x, a, b) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /** Flip the ready flag. Task 3 calls setReady(true) once the shadow map is live. */
  function setReady(b) {
    ready = b;
  }

  /**
   * updateUniforms(sceneRT, camera)
   * Per-frame: write tDiffuse / tDepth from sceneRT, camera matrices, shadow data.
   * Ported from prototype's renderFrame() uniform-write block.
   *
   * @param {THREE.WebGLRenderTarget} sceneRT  — owned by TV.js (has .texture + .depthTexture)
   * @param {THREE.Camera}            camera   — the scene camera
   */
  function updateUniforms(sceneRT, camera) {
    volMat.uniforms.tDiffuse.value  = sceneRT.texture;
    volMat.uniforms.tDepth.value    = sceneRT.depthTexture;
    volMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    volMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    volMat.uniforms.uCamPos.value.copy(camera.position);
    if (sun.shadow.map) {
      volMat.uniforms.uShadowMap.value = sun.shadow.map.texture;
    }
    volMat.uniforms.uShadowMatrix.value.copy(sun.shadow.matrix);
    volMat.uniforms.uLightColor.value.copy(_lightColor);
    volMat.uniforms.uLightDir.value.copy(SUBJECT).sub(sun.position).normalize();
  }

  /**
   * driveArc(a, p)
   * Ported verbatim from prototype driveArc(a), extended to read tunables from p
   * instead of DOM slider values.
   *
   * @param {number} a  — arc progress [0, 1]
   * @param {object} p  — tunables: { density, intensity, steps, maxDist, color }
   *   density   — multiplier for uDensity  (default 1.8 from prototype slider default)
   *   intensity — multiplier for uIntensity (default 2.0 from prototype slider default)
   *   steps     — uSteps (default 96 from prototype slider default)
   *   maxDist   — uMaxDist (default 50, main-scene value; prototype used 60 with far=400)
   *   color     — hex number or THREE.Color for sun + uLightColor (default WARM = 0xffb86b)
   */
  function driveArc(a, p = {}) {
    const density   = p.density   != null ? p.density   : 1.8;
    const intensity = p.intensity != null ? p.intensity : 2.0;
    const steps     = p.steps     != null ? p.steps     : 96;
    const maxDist   = p.maxDist   != null ? p.maxDist   : 50.0;
    const color     = p.color     != null ? p.color     : WARM;

    // lamp arc: behind-low (silhouette) → over → high front (reveal), always aimed at the monitor
    const th = THREE.MathUtils.degToRad(202 + (38 - 202) * a);
    sun.position.set(SUBJECT.x + 1.0, SUBJECT.y + Math.sin(th) * 6.5, SUBJECT.z + Math.cos(th) * 9);
    sun.target.position.copy(SUBJECT);
    sun.target.updateMatrixWorld();

    // lamp brightness: weak sunrise → strong; modest peak so the reveal never blows out
    sun.intensity = (0.2 + 0.8 * a) * 2.6;

    // light color — drives both the lamp (scene shading) and the volumetric glow
    _lightColor.set(color);
    sun.color.set(color);

    // volumetric: glows up for the silhouette, peaks mid-arc (beams), thins for the clean reveal
    const up    = _smooth(a, 0.05, 0.30);
    const front = _smooth(a, 0.55, 0.95);

    volMat.uniforms.uDensity.value   = density   * up * (1.0 - 0.7 * front);
    volMat.uniforms.uIntensity.value = intensity * (0.3 + 0.7 * up);
    volMat.uniforms.uSteps.value     = steps;
    volMat.uniforms.uMaxDist.value   = maxDist;
  }

  /**
   * dispose()
   * Release GPU resources: volMat, fsQuad, shadow map; remove group from parent.
   */
  function dispose() {
    volMat.dispose();
    fsQuad.dispose();
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
    }
    if (group.parent) {
      group.parent.remove(group);
    }
  }

  return { fsQuad, volMat, sun, group, ready, setReady, updateUniforms, driveArc, dispose };
}
