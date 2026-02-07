__webpack_require__.r(__webpack_exports__);
/* harmony export (binding) */ __webpack_require__.d(__webpack_exports__, "TV", function() { return TV; });
/* harmony import */ var _babel_runtime_helpers_esm_asyncToGenerator__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! @babel/runtime/helpers/esm/asyncToGenerator */ "./node_modules/@babel/runtime/helpers/esm/asyncToGenerator.js");
/* harmony import */ var _babel_runtime_helpers_esm_classCallCheck__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @babel/runtime/helpers/esm/classCallCheck */ "./node_modules/@babel/runtime/helpers/esm/classCallCheck.js");
/* harmony import */ var _babel_runtime_helpers_esm_createClass__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @babel/runtime/helpers/esm/createClass */ "./node_modules/@babel/runtime/helpers/esm/createClass.js");
/* harmony import */ var regenerator_runtime_runtime_js__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! regenerator-runtime/runtime.js */ "./node_modules/regenerator-runtime/runtime.js");
/* harmony import */ var regenerator_runtime_runtime_js__WEBPACK_IMPORTED_MODULE_3___default = /*#__PURE__*/__webpack_require__.n(regenerator_runtime_runtime_js__WEBPACK_IMPORTED_MODULE_3__);
/* harmony import */ var core_js_modules_es_string_repeat_js__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! core-js/modules/es.string.repeat.js */ "./node_modules/core-js/modules/es.string.repeat.js");
/* harmony import */ var core_js_modules_es_string_repeat_js__WEBPACK_IMPORTED_MODULE_4___default = /*#__PURE__*/__webpack_require__.n(core_js_modules_es_string_repeat_js__WEBPACK_IMPORTED_MODULE_4__);
/* harmony import */ var core_js_modules_es_object_to_string_js__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! core-js/modules/es.object.to-string.js */ "./node_modules/core-js/modules/es.object.to-string.js");
/* harmony import */ var core_js_modules_es_object_to_string_js__WEBPACK_IMPORTED_MODULE_5___default = /*#__PURE__*/__webpack_require__.n(core_js_modules_es_object_to_string_js__WEBPACK_IMPORTED_MODULE_5__);
/* harmony import */ var core_js_modules_es_array_concat_js__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! core-js/modules/es.array.concat.js */ "./node_modules/core-js/modules/es.array.concat.js");
/* harmony import */ var core_js_modules_es_array_concat_js__WEBPACK_IMPORTED_MODULE_6___default = /*#__PURE__*/__webpack_require__.n(core_js_modules_es_array_concat_js__WEBPACK_IMPORTED_MODULE_6__);
/* harmony import */ var three__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(/*! three */ "./node_modules/three/build/three.module.js");
/* harmony import */ var gsap__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(/*! gsap */ "./node_modules/gsap/index.js");
/* harmony import */ var three_examples_jsm_loaders_GLTFLoader_js__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(/*! three/examples/jsm/loaders/GLTFLoader.js */ "./node_modules/three/examples/jsm/loaders/GLTFLoader.js");
/* harmony import */ var three_examples_jsm_loaders_DRACOLoader_js__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(/*! three/examples/jsm/loaders/DRACOLoader.js */ "./node_modules/three/examples/jsm/loaders/DRACOLoader.js");












var EventEmitter = __webpack_require__(/*! events */ "./node_modules/events/events.js"); // function mapping(x, newX, progress) {
//   return x + (newX - x) * progress
// }


function lerp(t, a, b) {
  return (1 - t) * a + b;
}

var fogColor = 0x7a7a7a; // const fogColor = 0x454546

var fogColorDark = 0x454546;

var TV = /*#__PURE__*/function () {
  function TV(parentDOM) {
    var _this = this;

    var label = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
    var video = arguments.length > 2 ? arguments[2] : undefined;

    Object(_babel_runtime_helpers_esm_classCallCheck__WEBPACK_IMPORTED_MODULE_1__["default"])(this, TV);

    this.toneMappingExposureMax = 3.0;
    this.toneMappingExposureMin = 0.6; // parent

    this.parent = parentDOM;
    this.video = video;
    this.videoTexture = new three__WEBPACK_IMPORTED_MODULE_7__["VideoTexture"](video);
    this.videoTexture.encoding = three__WEBPACK_IMPORTED_MODULE_7__["sRGBEncoding"];
    this.videoTexture.repeat.set(1.7, 1.7);
    this.videoTexture.offset.x = -0.64;
    this.videoTexture.offset.y = -0.42;
    this.videoTexture.flipY = false; // label

    this.label = label; // mouse position

    this.mouseTarget = new three__WEBPACK_IMPORTED_MODULE_7__["Vector2"](0, 0);
    this.time = 0; // NDC

    this._NDC = {
      x: 0,
      y: 0
    }; // intersects

    this._intersects = []; // sizes

    this.sizes = {
      width: this.parent.getBoundingClientRect().width,
      height: this.parent.getBoundingClientRect().height,

      get aspect() {
        return this.width / this.height;
      }

    };
    this.mouse = new three__WEBPACK_IMPORTED_MODULE_7__["Vector2"](this.sizes.width / 2, this.sizes.height / 2); // renderer

    this.renderer = new three__WEBPACK_IMPORTED_MODULE_7__["WebGLRenderer"]({
      alpha: true,
      antialias: true
    });
    this.renderer.physicallyCorrectLights = true;
    this.renderer.outputEncoding = three__WEBPACK_IMPORTED_MODULE_7__["sRGBEncoding"];
    this.renderer.toneMappingExposure = this.toneMappingExposureMax;
    this.renderer.toneMapping = three__WEBPACK_IMPORTED_MODULE_7__["CineonToneMapping"];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this._setRendererSizes();

    this.renderer.setClearColor(fogColor, 1); // canvas

    this.canvas = this.renderer.domElement;
    this.parent.prepend(this.canvas); // geometry, material, mesh

    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this.progress = 0; // model

    this.model = null;
    this.modelPosition = null; // scene

    this.scene = new three__WEBPACK_IMPORTED_MODULE_7__["Scene"]();
    this.scene.fog = new three__WEBPACK_IMPORTED_MODULE_7__["Fog"](fogColor, 27, 29); // camera

    this.camera = null;
    this.cameraPosition = {
      x: 0,
      y: -0.5,
      z: 20
    };
    this.cameraPositionEnd = {
      x: 0,
      y: 0,
      z: 3
    }; // light

    this.ambientLight = null;
    this.pointLight = null;
    this.light = null; // raycaster

    this.raycaster = new three__WEBPACK_IMPORTED_MODULE_7__["Raycaster"](); // loader

    this.dracoLoader = new three_examples_jsm_loaders_DRACOLoader_js__WEBPACK_IMPORTED_MODULE_10__["DRACOLoader"]();
    this.dracoLoader.setDecoderPath('/scripts/draco/');
    this.gltfLoader = new three_examples_jsm_loaders_GLTFLoader_js__WEBPACK_IMPORTED_MODULE_9__["GLTFLoader"]();
    this.gltfLoader.setDRACOLoader(this.dracoLoader); // on-off button

    this.button = null;
    this.eventEmitter = new EventEmitter();
    this.event = null;
    document.addEventListener("mouseleave", function (event) {
      if (event.clientY <= 0 || event.clientX <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) {
        _this.setMousePosition(_this.sizes.width / 2, _this.sizes.height / 2);
      }
    });
  }

  Object(_babel_runtime_helpers_esm_createClass__WEBPACK_IMPORTED_MODULE_2__["default"])(TV, [{
    key: "init",
    value: function () {
      var _init = Object(_babel_runtime_helpers_esm_asyncToGenerator__WEBPACK_IMPORTED_MODULE_0__["default"])( /*#__PURE__*/regeneratorRuntime.mark(function _callee() {
        return regeneratorRuntime.wrap(function _callee$(_context) {
          while (1) {
            switch (_context.prev = _context.next) {
              case 0:
                _context.prev = 0;
                _context.next = 3;
                return this.loadModel();

              case 3:
                _context.next = 8;
                break;

              case 5:
                _context.prev = 5;
                _context.t0 = _context["catch"](0);
                console.log('Error on loading model: ', _context.t0);

              case 8:
                this.createCamera();
                this.createLights();

                this._render();

                return _context.abrupt("return", Promise.resolve());

              case 12:
              case "end":
                return _context.stop();
            }
          }
        }, _callee, this, [[0, 5]]);
      }));

      function init() {
        return _init.apply(this, arguments);
      }

      return init;
    }()
  }, {
    key: "toggleNightModeTV",
    value: function toggleNightModeTV() {
      var target;
      var triggerpos;

      if (this.renderer.toneMappingExposure < 1) {
        target = this.toneMappingExposureMax;
        triggerpos = 0;
        this.scene.fog = new three__WEBPACK_IMPORTED_MODULE_7__["Fog"](fogColor, 27, 29);
        this.renderer.setClearColor(fogColor, 1);
      } else {
        target = this.toneMappingExposureMin;
        triggerpos = 0.45;
        this.scene.fog = new three__WEBPACK_IMPORTED_MODULE_7__["Fog"](fogColorDark, 27, 29);
        this.renderer.setClearColor(fogColorDark, 1);
      }

      gsap__WEBPACK_IMPORTED_MODULE_8__["default"].to(this.renderer, {
        toneMappingExposure: target,
        duration: 0.4,
        overwrite: true
      });
      gsap__WEBPACK_IMPORTED_MODULE_8__["default"].to(this.triggerEl.position, {
        x: triggerpos,
        duration: 0.4,
        overwrite: true
      });
    }
  }, {
    key: "loadModel",
    value: function loadModel() {
      var _this2 = this;

      this.trigger = new three__WEBPACK_IMPORTED_MODULE_7__["Mesh"](new three__WEBPACK_IMPORTED_MODULE_7__["BoxBufferGeometry"](0.9, 1.8, 1.8), new three__WEBPACK_IMPORTED_MODULE_7__["MeshBasicMaterial"]({
        color: 0xff0000
      }));
      this.fakeTrigger = new three__WEBPACK_IMPORTED_MODULE_7__["Mesh"](new three__WEBPACK_IMPORTED_MODULE_7__["BoxBufferGeometry"](0.9, 1.8, 1.8), new three__WEBPACK_IMPORTED_MODULE_7__["MeshBasicMaterial"]({
        color: 0x00ff00
      }));
      this.scene.add(this.trigger);
      this.trigger.visible = false;
      this.fakeTrigger.visible = false;
      this.trigger.position.x = this.fakeTrigger.position.x = -1.3;
      this.trigger.position.y = this.fakeTrigger.position.y = -1.7;
      this.trigger.position.z = this.fakeTrigger.position.z = 2;

      if (window.innerWidth < 768) {
        this.trigger.position.x = 0;
        this.trigger.position.y = 0; // this.trigger.position.z = 0

        this.trigger.scale.set(3, 3, 3);
      }

      return new Promise(function (resolve, reject) {
        _this2.gltfLoader.load('/models/tv1.glb', function (gltf) {
          _this2.model = gltf.scene;
          _this2.triggerEl = _this2.model.getObjectByName('Cube001');
          _this2.button = _this2.model.getObjectByName('Cube001');
          _this2.plane = _this2.model.getObjectByName('Plane');
          _this2.tv = _this2.model.getObjectByName('Cube001');
          _this2.screen = _this2.model.getObjectByName('Glass');
          _this2.screen.material = new three__WEBPACK_IMPORTED_MODULE_7__["MeshBasicMaterial"]({
            map: _this2.videoTexture
          });
          _this2.triggerEl.material = new three__WEBPACK_IMPORTED_MODULE_7__["MeshBasicMaterial"]({
            color: 0x000000
          });
          _this2.groupnames = []; // this.screen.material = this.material

          _this2.scene.add(gltf.scene);

          resolve();
        }, function () {// console.log('progress')
        }, function (error) {
          reject(error);
        });
      });
    }
  }, {
    key: "createCamera",
    value: function createCamera() {
      this.camera = new three__WEBPACK_IMPORTED_MODULE_7__["PerspectiveCamera"](45, this.sizes.aspect, 0.1, 100);
      this.camera.position.set(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
      this.camera.lookAt(0, 0, 0);
      this.scene.add(this.camera);
    }
  }, {
    key: "createLights",
    value: function createLights() {
      this.ambientLight = new three__WEBPACK_IMPORTED_MODULE_7__["AmbientLight"](0xffffff, 0.5);
      this.scene.add(this.ambientLight);
      this.pointLight = new three__WEBPACK_IMPORTED_MODULE_7__["PointLight"](0xffffff, 0.5);
      this.pointLight.position.x = 0;
      this.pointLight.position.y = 3;
      this.pointLight.position.z = 0.5;
      this.scene.add(this.pointLight);
    }
  }, {
    key: "_setRendererSizes",
    value: function _setRendererSizes() {
      this.renderer.setSize(this.sizes.width, this.sizes.height);
    }
  }, {
    key: "_setLabelPosition",
    value: function _setLabelPosition() {
      if (!this.trigger) return;
      var point = this.fakeTrigger.position.clone();
      point.project(this.camera);
      var translate = {
        x: point.x * this.sizes.width * 0.5,
        y: -point.y * this.sizes.height * 0.5
      };
      this.label.style.transform = "translate(".concat(translate.x, "px, ").concat(translate.y, "px)");
    }
  }, {
    key: "animateCameraPosition",
    value: function animateCameraPosition(progress) {
      this.progress = progress;
      if (progress > 0.99) this.eventEmitter.emit(this.event);
    }
  }, {
    key: "rotateCamera",
    value: function rotateCamera() {
      this.mouseTarget.lerp(this.toNDC(), 0.05);
      this.camera.position.x = 0.5 * 14.7 * this.mouseTarget.x * (1 - this.progress);
      this.camera.position.y = 0.5 * -2.7 * this.mouseTarget.y * (1 - this.progress) + 0.5;
      this.camera.lookAt(0, 0.5, 0);
      this.camera.position.z = lerp(this.progress, 20, 3.6);
      this.camera.position.y = lerp(this.progress, -0.5, 0.5);
      this.camera.lookAt(0, 0.5, 0);
    }
  }, {
    key: "_intersect",
    value: function _intersect() {
      this.raycaster.setFromCamera(this._NDC, this.camera);
      this._intersects = this.raycaster.intersectObjects([this.trigger]);
    }
  }, {
    key: "getIntersects",
    value: function getIntersects() {
      var onlyNames = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;

      this._intersect();

      if (this._intersects.length > 0) return ['button'];else return ['none'];
    }
  }, {
    key: "setLabel",
    value: function setLabel(element) {
      this.label = element;
    }
  }, {
    key: "_render",
    value: function _render() {
      this.renderer.render(this.scene, this.camera);

      this._setLabelPosition();

      this.rotateCamera();
      requestAnimationFrame(this._render.bind(this));
    }
  }, {
    key: "setMousePosition",
    value: function setMousePosition(x, y) {
      this.mouse.x = x;
      this.mouse.y = y;
      this._NDC = this.toNDC();
    }
  }, {
    key: "toNDC",
    value: function toNDC() {
      return {
        x: this.mouse.x / this.sizes.width * 2 - 1,
        y: -(this.mouse.y / this.sizes.height) * 2 + 1
      };
    }
  }, {
    key: "getNDC",
    value: function getNDC() {
      return this._NDC;
    }
  }, {
    key: "resize",
    value: function resize() {
      var box = this.parent.getBoundingClientRect();
      this.sizes.width = box.width;
      this.sizes.height = box.height;

      this._setRendererSizes();

      this.camera.aspect = this.sizes.aspect;
      this.camera.updateProjectionMatrix();
    }
  }, {
    key: "on",
    value: function on(event, cb) {
      this.event = event;
      this.eventEmitter.once(event, cb);
    }
  }]);

  return TV;
}();

