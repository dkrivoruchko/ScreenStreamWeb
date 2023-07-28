var slice$ = [].slice;
(function () {
  var defaultVertexShader, defaultFragmentShader, ShaderRenderer;
  defaultVertexShader = "precision highp float;\nattribute vec3 position;\nvoid main() {\n  gl_Position = vec4(position, 1.);\n}";
  defaultFragmentShader = "precision highp float;\nvoid main() {\n  gl_FragColor = vec4(0., 0., 0., 1.);\n}";
  ShaderRenderer = function (shader, options) {
    var root, canvas, gl;
    options == null && (options = {});
    import$((this.width = 320, this.height = 240, this.scale = 1, this), options);
    root = this.root;
    if (root) {
      this.root = typeof root === 'string' ? document.querySelector(root) : root;
    }
    this.shader = Array.isArray(shader)
      ? shader
      : [shader];
    this.domElement = canvas = document.createElement('canvas');
    this.gl = gl = null;
    this.inputs = {};
    return this;
  };
  ShaderRenderer.prototype = import$(Object.create(Object.prototype), {
    init: function () {
      var canvas, box, gl, i$, to$, i, program;
      canvas = this.domElement;
      if (this.root) {
        this.root.appendChild(canvas);
        box = this.root.getBoundingClientRect();
        (this.width = box.width, this.height = box.height, this).inited = true;
      }
      this.inited = true;
      this.gl = gl = canvas.getContext('webgl');
      canvas.width = this.width * this.scale;
      canvas.height = this.height * this.scale;
      canvas.style.width = this.width + "px";
      canvas.style.height = this.height + "px";
      gl.viewport(0, 0, gl.drawingBufferWidth * this.scale, gl.drawingBufferHeight * this.scale);
      this.programs = [];
      for (i$ = 0, to$ = this.shader.length; i$ < to$; ++i$) {
        i = i$;
        program = this.makeProgram(this.shader[i], this.programs[i - 1]);
        this.programs.push(program);
      }
      this.buildPipeline();
      return this.resize();
    },
    texture: function (program, uName, img) {
      var gl, ref$, pdata, pobj, map, texture, idx, uTexture;
      gl = this.gl;
      ref$ = [program.data, program.obj], pdata = ref$[0], pobj = ref$[1];
      map = pdata.textureMap;
      ref$ = !map[uName]
        ? (this.texture.idx = (this.texture.idx || 0) + 1, map[uName] = {
          idx: this.texture.idx - 1,
          texture: gl.createTexture()
        })
        : map[uName], texture = ref$.texture, idx = ref$.idx;
      uTexture = this.gl.getUniformLocation(pobj, uName);
      this.gl.uniform1i(uTexture, idx);
      gl.activeTexture(gl.TEXTURE0 + idx);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      if (!img) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width * this.scale, this.height * this.scale, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      }
      return texture;
    },
    input: function () {
      var args, i$, to$, i, results$ = [];
      args = slice$.call(arguments);
      for (i$ = 1, to$ = args.length; i$ <= to$; ++i$) {
        i = i$;
        results$.push(this.setInput(i, args[i - 1]));
      }
      return results$;
    },
    setInput: function (idx, src) {
      return this.inputs["uIn" + idx] = src instanceof ShaderRenderer ? src.domElement : src;
    },
    makeShader: function (code, type) {
      var gl, shader;
      gl = this.gl;
      shader = gl.createShader(type);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.log(gl.getShaderInfoLog(shader));
        console.log(code);
      }
      return shader;
    },
    buildPipeline: function () {
      var ref$, gl, ps, pp, i$, to$, link, i, results$ = [];
      ref$ = [this.gl, this.programs, this.pipeline], gl = ref$[0], ps = ref$[1], pp = ref$[2];
      if (pp) {
        for (i$ = 0, to$ = pp.link; i$ < to$; ++i$) {
          link = i$;
          link[0];
        }
        for (i$ = 0, to$ = ps.length; i$ < to$; ++i$) {
          i = i$;
          if (!in$(i, pp.src)) {
            results$.push(ps[i].data.uIn);
          }
        }
        return results$;
      } else {
        for (i$ = 0, to$ = ps.length - 1; i$ < to$; ++i$) {
          i = i$;
          ps[i].data.fbo = gl.createFramebuffer();
        }
        for (i$ = 1, to$ = ps.length; i$ < to$; ++i$) {
          i = i$;
          ps[i].data.uIn1 = this.texture(ps[i], 'uIn1', null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, ps[i - 1].data.fbo);
          results$.push(gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ps[i].data.uIn1, 0));
        }
        return results$;
      }
    },
    makeProgram: function (shader, pprogram) {
      var gl, ref$, pdata, pobj, program, vs, fs, positionLocation;
      gl = this.gl;
      ref$ = [
        {
          textureMap: {}
        }, gl.createProgram()
      ], pdata = ref$[0], pobj = ref$[1];
      program = {
        data: pdata,
        obj: pobj
      };
      vs = this.makeShader(shader.vertexShader || defaultVertexShader, gl.VERTEX_SHADER);
      fs = this.makeShader(shader.fragmentShader || defaultFragmentShader, gl.FRAGMENT_SHADER);
      gl.attachShader(pobj, vs);
      gl.attachShader(pobj, fs);
      gl.linkProgram(pobj);
      if (!gl.getProgramParameter(pobj, gl.LINK_STATUS)) {
        console.log(gl.getProgramInfoLog(pobj));
      }
      gl.useProgram(pobj);
      if (shader.buffer) {
        shader.buffer(this, program);
      } else {
        pdata.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pdata.buffer);
        pdata.array = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]);
        gl.bufferData(gl.ARRAY_BUFFER, pdata.array, gl.STATIC_DRAW);
        positionLocation = gl.getAttribLocation(pobj, "position");
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
      }
      return program;
    },
    animate: function (cb, options) {
      var _, this$ = this;
      _ = function (t) {
        requestAnimationFrame(function (t) {
          return _(t * 0.001);
        });
        if (cb) {
          cb(t);
        }
        return this$.render(t, options);
      };
      return _(0);
    },
    render: function (t, options) {
      var gl, i$, to$, i, ref$, pdata, pobj, shader, uTime, k, v, u, that, results$ = [];
      t == null && (t = 0);
      options == null && (options = {});
      if (!this.inited) {
        this.init();
      }
      gl = this.gl;
      for (i$ = 0, to$ = this.programs.length; i$ < to$; ++i$) {
        i = i$;
        ref$ = [this.programs[i].data, this.programs[i].obj, this.shader[i]], pdata = ref$[0], pobj = ref$[1], shader = ref$[2];
        gl.useProgram(pobj);
        uTime = gl.getUniformLocation(pobj, "uTime");
        gl.uniform1f(uTime, t);
        for (k in ref$ = shader.uniforms || {}) {
          v = ref$[k];
          if (v.type === 't') {
            this.texture(pobj, k, v.value);
          } else {
            u = gl.getUniformLocation(pobj, k);
            gl["uniform" + v.type](u, v.value);
          }
        }
        if (i === 0) {
          for (k in ref$ = this.inputs) {
            v = ref$[k];
            this.texture(this.programs[i], k, v);
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, pdata.fbo);
        gl.viewport(0, 0, this.width * this.scale, this.height * this.scale);
        if (that = shader.render) {
          results$.push(that(this, this.programs[i], t));
        } else {
          gl.clearColor(1, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          results$.push(gl.drawArrays(gl.TRIANGLES, 0, 6));
        }
      }
      return results$;
    },
    setSize: function (w, h) {
      var ref$;
      this.width = w;
      this.height = h;
      ref$ = this.domElement;
      ref$.width = w * this.scale;
      ref$.height = h * this.scale;
      this.domElement.style.width = w + "px";
      this.domElement.style.height = h + "px";
      return this.resize();
    },
    resize: function () {
      var i$, to$, i, pobj, uResolution, results$ = [];
      for (i$ = 0, to$ = this.programs.length; i$ < to$; ++i$) {
        i = i$;
        pobj = this.programs[i].obj;
        this.gl.useProgram(pobj);
        uResolution = this.gl.getUniformLocation(pobj, "uResolution");
        results$.push(this.gl.uniform2fv(uResolution, [this.width * this.scale, this.height * this.scale]));
      }
      return results$;
    }
  });
  if (typeof module != 'undefined' && module !== null) {
    return module.exports = ShaderRenderer;
  } else if (typeof window != 'undefined' && window !== null) {
    return window.ShaderRenderer = ShaderRenderer;
  }
})();
function import$(obj, src) {
  var own = {}.hasOwnProperty;
  for (var key in src) if (own.call(src, key)) obj[key] = src[key];
  return obj;
}
function in$(x, xs) {
  var i = -1, l = xs.length >>> 0;
  while (++i < l) if (x === xs[i]) return true;
  return false;
}
(function () {
  var ScriptManager, ModManager, ModRenderer;
  window.ScriptManager = ScriptManager = {
    hash: {},
    load: function (type, src) {
      var this$ = this;
      type == null && (type = 'js');
      return new Promise(function (res, rej) {
        var script;
        if (!this$.hash[src]) {
          this$.hash[src] = {
            promise: {
              res: [],
              rej: []
            },
            loaded: false
          };
        }
        this$.hash[src].promise.res.push(res);
        this$.hash[src].promise.rej.push(rej);
        if (this$.hash[src].promise.res.length > 1) {
          return;
        }
        script = document.createElement('script');
        script.src = src;
        script.onload = function () {
          this$.hash[src].loaded = true;
          return this$.hash[src].promise.res.map(function () {
            return res();
          });
        };
        return document.body.appendChild(script);
      });
    }
  };
  window.ModManager = ModManager = {
    mods: {},
    init: function () { },
    loadLib: function (mod) {
      return Promise.resolve().then(function () {
        var promises;
        if (!mod.lib || mod.lib.inited) {
          return null;
        }
        promises = mod.lib
          ? mod.lib.map(function (it) {
            return ScriptManager.load(it[0], it[1]);
          })
          : [Promise.resolve()];
        return Promise.all(promises).then(function () {
          if (mod.lib != null) {
            return mod.lib.inited = true;
          }
        });
      });
    },
    load: function (name) {
      var this$ = this;
      return new Promise(function (res, rej) {
        var that;
        if (that = this$.mods[name]) {
          return ModManager.loadLib(that).then(function () {
            return res(this$.mods[name]);
          });
        }
        console.log("first time load " + name + ". load it from web...");
        if (!this$.load.target) {
          this$.load.target = {
            clear: function () {
              return this._callback = null, this.name = null, this.node = null, this.res = null, this.rej = null, this;
            },
            callback: function (e, b) {
              var this$ = this;
              this.name = null;
              if (e) {
                return this.rej ? this.rej(e) : null;
              }
              return ModManager.loadLib(b).then(function () {
                if (this$.res) {
                  return this$.res(b);
                }
              });
            }
          };
        }
        if (this$.load.target.timeout) {
          clearTimeout(this$.load.target.timeout);
        }
        import$(this$.load.target, {
          res: res,
          rej: rej,
          name: name,
          timeout: setTimeout(function () {
            var that;
            if (that = this$.load.target.node) {
              that.parentNode.removeChild(that);
            }
            this$.load.target.clear();
            return rej();
          }, 10000),
          node: document.createElement("script")
        });
        this$.load.target.node.src = "/backgrounds/" + name + "/main.js";
        return document.body.appendChild(this$.load.target.node);
      });
    },
    register: function (mod) {
      if (!mod || !mod.name) {
        console.log("register error: ", mod);
        return this.load.target && this.load.target.callback ? this.load.target.callback(true) : void 8;
      }
      this.mods[mod.id] = mod;
      if (!this.load.target) {
        return;
      }
      clearTimeout(this.load.target.timeout);
      return this.load.target.callback(null, mod);
    }
  };
  ModManager.init();
  window.ModRenderer = ModRenderer = function (root, options) {
    options == null && (options = {});
    this.options = import$({
      scale: 1
    }, options);
    this.setContainer(root);
    return this;
  };
  return import$(ModRenderer.prototype, {
    setSize: function (w, h) {
      return this.w = w, this.h = h, this;
    },
    setContainer: function (root) {
      var box;
      this.root = typeof root === typeof '' ? document.querySelector(root) : root;
      if (this.root) {
        box = this.root.getBoundingClientRect();
        return this.w = box.width, this.h = box.height, this;
      }
    },
    prepare: function (w, h) {
      var camera, scene, renderer, controls;
      w = !(w != null && w) ? this.w || window.innerWidth : void 8;
      h = !(h != null && h) ? this.h || window.innerHeight : void 8;
      camera = new THREE.PerspectiveCamera(45, w / h, 1, 10000);
      scene = new THREE.Scene();
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true
      });
      renderer.setSize(w, h);
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enabled = false;
      return {
        camera: camera,
        scene: scene,
        renderer: renderer,
        w: w,
        h: h,
        controls: controls
      };
    },
    getDom: function () {
      return this.mod._renderer.domElement;
    },
    initMod: function (mod) {
      var promise, this$ = this;
      promise = !mod.inited
        ? Promise.resolve().then(function () {
          mod.inited = true;
          return mod.init({
            three: {
              prepare: function () {
                var ret;
                ret = this$.prepare();
                mod._renderer = ret.renderer;
                return ret;
              }
            },
            shaderlib: {
              prepare: function (shaders, option) {
                var renderer;
                option == null && (option = {});
                renderer = new ShaderRenderer(shaders, (option.root = this$.root, option.scale = this$.options.scale, option));
                renderer.init();
                mod._renderer = renderer;
                return {
                  renderer: renderer
                };
              }
            }
          });
        })
        : Promise.resolve();
      return promise.then(function () {
        this$.mod = mod;
        return this$.start();
      });
    },
    running: false,
    render: function (t) {
      return this.mod.step(t != null
        ? t
        : this.time * 0.001);
    },
    start: function () {
      var i$, i, _animate, this$ = this;
      for (i$ = this.root.childNodes.length - 1; i$ >= 0; --i$) {
        i = i$;
        this.root.removeChild(this.root.childNodes[i]);
      }
      this.root.appendChild(this.mod._renderer.domElement);
      if (this.running) {
        return;
      }
      this.running = true;
      _animate = function (t) {
        if (this$.running) {
          requestAnimationFrame(_animate);
        }
        this$.mod.step(t * 0.001);
        return this$.time = t;
      };
      return _animate(0);
    },
    stop: function () {
      return this.running = false;
    }
  });
})();
(function () { function r(e, n, t) { function o(i, f) { if (!n[i]) { if (!e[i]) { var c = "function" == typeof require && require; if (!f && c) return c(i, !0); if (u) return u(i, !0); var a = new Error("Cannot find module '" + i + "'"); throw a.code = "MODULE_NOT_FOUND", a } var p = n[i] = { exports: {} }; e[i][0].call(p.exports, function (r) { var n = e[i][1][r]; return o(n || r) }, p, p.exports, r, e, n, t) } return n[i].exports } for (var u = "function" == typeof require && require, i = 0; i < t.length; i++)o(t[i]); return o } return r })()({
  1: [function (require, module, exports) {
    (function () {
      var glslify, mod;
      glslify = require('glslify');
      mod = {
        id: 'polygon',
        name: "Polygon",
        type: 'background',
        desc: "Morphing polygons with gradient colors",
        tags: ['polygon', 'trianglify', 'gradient', 'green'],
        slug: "green-gradient-polygon",
        license: 'CC0',
        edit: {
          c1: {
            name: "Color 1",
            type: 'color',
            'default': '#073d31'
          },
          c2: {
            name: "Color 2",
            type: 'color',
            'default': '#4b9c48'
          },
          c3: {
            name: "Color 3",
            type: 'color',
            'default': '#ffe9b7'
          },
          size: {
            name: "Grid Size",
            type: 'number',
            'default': 19,
            min: 1,
            max: 100,
            step: 1
          },
          rand: {
            name: "Randomness",
            type: 'number',
            'default': 0.4,
            min: 0.0,
            max: 1,
            step: 0.01
          },
          jam: {
            name: "Jamming",
            type: 'number',
            'default': 0.08,
            min: 0.0,
            max: 1,
            step: 0.01
          },
          shadow: {
            name: "Shadow",
            type: 'number',
            'default': 0.92,
            min: 0,
            max: 2,
            step: 0.01
          }
        },
        support: {},
        watch: function (n, o) {
          var u, i$, ref$, len$, name, results$ = [];
          u = this.shaders[0].uniforms;
          for (i$ = 0, len$ = (ref$ = ['c1', 'c2', 'c3']).length; i$ < len$; ++i$) {
            name = ref$[i$];
            u[name].value = ldColor.rgbfv(n[name]);
          }
          for (i$ = 0, len$ = (ref$ = ['speed', 'size', 'rand', 'jam', 'shadow']).length; i$ < len$; ++i$) {
            name = ref$[i$];
            results$.push(u[name].value = n[name]);
          }
          return results$;
        },
        shaders: [{
          uniforms: {
            c1: { type: '3fv', value: [0, 0.07, 0.11] },
            c2: { type: '3fv', value: [0.0745, 0.1686, 0.2588] },
            c3: { type: '3fv', value: [0, 0.07, 0.11] },
            speed: { type: '1f', value: 0.3 },
            size: { type: '1f', value: 30 },
            rand: { type: '1f', value: 0.5 },
            jam: { type: '1f', value: 0.12 },
            shadow: { type: '1f', value: 1 }
          },
          fragmentShader: glslify(["precision highp float;\n#define GLSLIFY 1\n/* z: pixel size */\nvec3 aspect_ratio_1540259130(vec2 res, int iscover) {\n  // iscover: 0 = contains, 1 = cover, 2 = stretch\n  float r;\n  vec3 ret = vec3((gl_FragCoord.xy / res.xy), 0.);\n  if(iscover == 2) {\n    ret.z = 1. / max(res.x, res.y);\n  } else if(iscover == 0 ^^ res.x > res.y) {\n    r = res.y / res.x;\n    ret.y = ret.y * r - (r - 1.) * 0.5;\n    ret.z = 1. / (iscover == 0 ? res.x : res.y);\n  } else {\n    r = res.x / res.y;\n    ret.x = (ret.x * r) - (r - 1.) * 0.5;\n    ret.z = 1. / (iscover == 0 ? res.y : res.x);\n  } \n  return ret;\n}\n\n/*\nret.y = ret.y * res.y / res.x\nret.x = ret.x * res.x / res.x\nret.xy = ret.xy * res.yx / max(res.x, res.y)\n\nfloat base;\nbase = res.xy / (iscover == 0 ? min(res.x, res.y) : max(res.x, res.y));\nret.z = 1. / base;\nret.xy = ( ret.xy * res.yx / base ) - ret.xy / base;\n*/\n\nfloat hash(float n) { return fract(sin(n) * 1e4); }\nfloat hash(vec2 p) { return fract(1e4 * sin(17.0 * p.x + p.y * 0.1) * (0.1 + abs(sin(p.y * 13.0 + p.x)))); }\n\nfloat noise(float x) {\n        float i = floor(x);\n        float f = fract(x);\n        float u = f * f * (3.0 - 2.0 * f);\n        return mix(hash(i), hash(i + 1.0), u);\n}\n\nfloat noise(vec2 x) {\n        vec2 i = floor(x);\n        vec2 f = fract(x);\n\n        // Four corners in 2D of a tile\n        float a = hash(i);\n        float b = hash(i + vec2(1.0, 0.0));\n        float c = hash(i + vec2(0.0, 1.0));\n        float d = hash(i + vec2(1.0, 1.0));\n\n        // Simple 2D lerp using smoothstep envelope between the values.\n        // return vec3(mix(mix(a, b, smoothstep(0.0, 1.0, f.x)),\n        //                      mix(c, d, smoothstep(0.0, 1.0, f.x)),\n        //                      smoothstep(0.0, 1.0, f.y)));\n\n        // Same code, with the clamps in smoothstep and common subexpressions\n        // optimized away.\n        vec2 u = f * f * (3.0 - 2.0 * f);\n        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;\n}\n\n// This one has non-ideal tiling properties that I'm still tuning\nfloat noise(vec3 x) {\n        const vec3 step = vec3(110, 241, 171);\n\n        vec3 i = floor(x);\n        vec3 f = fract(x);\n \n        // For performance, compute the base input to a 1D hash from the integer part of the argument and the \n        // incremental change to the 1D based on the 3D -> 1D wrapping\n    float n = dot(i, step);\n\n        vec3 u = f * f * (3.0 - 2.0 * f);\n        return mix(mix(mix( hash(n + dot(step, vec3(0, 0, 0))), hash(n + dot(step, vec3(1, 0, 0))), u.x),\n                   mix( hash(n + dot(step, vec3(0, 1, 0))), hash(n + dot(step, vec3(1, 1, 0))), u.x), u.y),\n               mix(mix( hash(n + dot(step, vec3(0, 0, 1))), hash(n + dot(step, vec3(1, 0, 1))), u.x),\n                   mix( hash(n + dot(step, vec3(0, 1, 1))), hash(n + dot(step, vec3(1, 1, 1))), u.x), u.y), u.z);\n}\n\n#define NUM_OCTAVES 5\n\nfloat fbm(float x) {\n  float v = 0.0;\n  float a = 0.5;\n  float shift = float(100);\n  for (int i = 0; i < NUM_OCTAVES; ++i) {\n    v += a * noise(x);\n    x = x * 2.0 + shift;\n    a *= 0.5;\n  }\n  return v;\n}\n\nfloat fbm(vec2 x) {\n  float v = 0.0;\n  float a = 0.5;\n  vec2 shift = vec2(100);\n  // Rotate to reduce axial bias\n  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.50));\n  for (int i = 0; i < NUM_OCTAVES; ++i) {\n    v += a * noise(x);\n    x = rot * x * 2.0 + shift;\n    a *= 0.5;\n  }\n  return v;\n}\n\nfloat fbm(vec3 x) {\n  float v = 0.0;\n  float a = 0.5;\n  vec3 shift = vec3(100);\n  for (int i = 0; i < NUM_OCTAVES; ++i) {\n    v += a * noise(x);\n    x = x * 2.0 + shift;\n    a *= 0.5;\n  }\n  return v;\n}\n\n#define NUM_ITERATION 5.\n\nfloat raster_cloud_1062606552(vec2 uv, float t, vec2 dir, float delta) {\n  float c = 0.;\n  for(float i=1.;i<NUM_ITERATION;i++) {\n    c += fbm(vec2(uv.x * i + t * pow(delta,i) * 0.001 * dir.x, uv.y * i + t * pow(delta, i) * 0.001 * dir.y));\n  }\n  c = c / (NUM_ITERATION - 2.);\n  return c;\n}\n\nfloat vignette(float max, float amount, vec2 uv_0) {\n  return max - length(uv_0 - .5) * amount;\n}\n\nfloat distance_to_line_2281831123(vec2 p, vec2 a, vec2 b) {\n  vec2 pa = p - a;\n  vec2 n = b - a;\n  return length(pa - clamp(dot(pa, n) / dot(n, n), 0., 1.) * n);\n}\n\nuniform float uTime, size, speed, rand, jam, shadow;\nuniform vec2 uResolution;\nuniform vec3 c1, c2, c3;\n\nfloat line(vec2 p, vec2 a, vec2 b) {\n  float d = distance_to_line_2281831123(p, a, b);\n  return clamp(smoothstep(0.02, 0.0, d), 0.0, 0.9);\n}\n\nvec2 getpt(vec2 id, float t) {\n  vec2 pt = vec2(noise(id.x + noise(id.y) * 625.788) * t, noise(id.y + noise(id.x) * 9527.145) * t);\n  pt = vec2(cos(pt.x), sin(pt.y)) * rand;\n  return pt;\n}\n\nvoid main() {\n  float r, f, d, t = (uTime + 2586.9363) * 2. * speed;\n  vec2 auv = gl_FragCoord.xy / uResolution.xy;\n  vec2 duv;\n  if(uResolution.x > uResolution.y) {\n    r = uResolution.x  / uResolution.y;\n    auv.x = auv.x * r - ( r - 1. ) * 0.5;\n    duv = vec2(r, 1.);\n  } else {\n    r = uResolution.y  / uResolution.x;\n    auv.y = auv.y * r - ( r - 1. ) * 0.5;\n    duv = vec2(1., r);\n  }\n  vec2 uv = fract(vec2(auv) * size) - 0.5;\n  vec2 id = floor(vec2(auv) * size);\n  vec2 pt1, pt2, pt3;\n  vec2 p[9], mv;\n  float min = 999.;\n  for(float i=-1.;i<=2.;i+=1.) {\n    for(float j=-1.;j<=2.;j+=1.) {\n      p[int(i * 3. + j + 4.)] = getpt(id + vec2(i, j), t) + vec2(i, j);\n      if(length(uv - p[int(i * 3. + j + 4.)]) < min) {\n        min = length(uv - p[int(i * 3. + j + 4.)]);\n        mv = id + vec2(i, j);\n      }\n    }\n  }\n  d = length(uv - p[4]);\n  f = smoothstep(0.09, 0.08, d);\n  f = pow(mix(pow(\n    clamp((mv.x/size + (r - 1.) * 0.5 ) / r,0.,1.) *\n    clamp((mv.y/size + (r - 1.) * 0.5 ) / r,0.,1.),\n    0.5\n  ), noise(mv), jam), 1.0);\n  f = clamp(f, 0., 1.);\n  f = f - pow((auv.x - mv.x / size) * 2. * shadow, 2.);\n  if(f < 0.5) {\n    gl_FragColor = vec4(mix(c1, c2, f * 2.), 1.);\n  } else {\n    gl_FragColor = vec4(mix(c2, c3, (f - 0.5) * 2.), 1.);\n  }\n}\n"])
        }],
        init: function (arg$) {
          var shaderlib;
          shaderlib = arg$.shaderlib;
          return import$(this, shaderlib.prepare(this.shaders));
        },
        step: function (t) {
          return this.renderer.render(t);
        },
        destroy: function () { }
      };
      if (typeof module != 'undefined' && module !== null) {
        module.exports = mod;
      }
      if (typeof ModManager != 'undefined' && ModManager !== null) {
        ModManager.register(mod);
      }
      return mod;
    })();
    function import$(obj, src) {
      var own = {}.hasOwnProperty;
      for (var key in src) if (own.call(src, key)) obj[key] = src[key];
      return obj;
    }
  }, { "glslify": 2 }], 2: [function (require, module, exports) {
    module.exports = function (strings) {
      if (typeof strings === 'string') strings = [strings]
      var exprs = [].slice.call(arguments, 1)
      var parts = []
      for (var i = 0; i < strings.length - 1; i++) {
        parts.push(strings[i], exprs[i] || '')
      }
      parts.push(strings[i])
      return parts.join('')
    }

  }, {}]
}, {}, [1]);