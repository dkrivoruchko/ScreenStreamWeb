"use strict";

class PolygonBackground {
    constructor(containerSelector) {
        this.container = document.querySelector(containerSelector);
        if (!this.container) {
            console.error("PolygonBackground Error: Container element not found:", containerSelector);
            return;
        }

        Object.assign(this.container.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            zIndex: '-1'
        });

        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl', {preserveDrawingBuffer: true, antialias: true});

        if (!gl) {
            console.error("PolygonBackground Error: Unable to initialize WebGL.");
            return;
        }

        this.canvas = canvas;
        this.gl = gl;
        this.container.appendChild(this.canvas);

        this.program = null;
        this.uniformLocations = {};

        this.shaderConfig = {
            uniforms: {
                c1: {type: '3fv', value: [0.0, 0.07, 0.11]},
                c2: {type: '3fv', value: [0.0745, 0.1686, 0.2588]},
                c3: {type: '3fv', value: [0.0, 0.07, 0.11]},
                size: {type: '1f', value: 30.0},
                rand: {type: '1f', value: 0.5},
                jam: {type: '1f', value: 0.12},
                shadow: {type: '1f', value: 0.92},
                speed: {type: '1f', value: 0.3}
            },
            vertexShader: `
                precision highp float;
                attribute vec2 position;
                void main() {
                    gl_Position = vec4(position, 0.0, 1.0);
                }
            `,
            fragmentShader: `
                precision highp float;
                uniform float uTime;
                uniform vec2 uResolution;
                uniform vec3 c1, c2, c3;
                uniform float size, speed, rand, jam, shadow;

                float hash(float n) { return fract(sin(n) * 1e4); }
                float hash(vec2 p) { return fract(1e4 * sin(17.0 * p.x + p.y * 0.1) * (0.1 + abs(sin(p.y * 13.0 + p.x)))); }

                float noise(float x) {
                    float i = floor(x);
                    float f = fract(x);
                    float u = f * f * (3.0 - 2.0 * f);
                    return mix(hash(i), hash(i + 1.0), u);
                }

                float noise(vec2 x) {
                    vec2 i = floor(x);
                    vec2 f = fract(x);
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
                }

                vec2 getpt(vec2 id, float t) {
                  vec2 pt = vec2(noise(id.x + noise(id.y) * 625.788) * t, noise(id.y + noise(id.x) * 9527.145) * t);
                  pt = vec2(cos(pt.x), sin(pt.y)) * rand;
                  return pt;
                }

                void main() {
                    vec2 auv = gl_FragCoord.xy / uResolution.xy;
                    float r;
                    if (uResolution.x > uResolution.y) {
                        r = uResolution.x / uResolution.y;
                        auv.x = auv.x * r - (r - 1.0) * 0.5;
                    } else {
                        r = uResolution.y / uResolution.x;
                        auv.y = auv.y * r - (r - 1.0) * 0.5;
                    }

                    vec2 uv = fract(auv * size) - 0.5;
                    vec2 id = floor(auv * size);

                    vec2 mv;
                    float min_dist = 999.0;
                    float t = (uTime + 2586.9363) * 2.0 * speed;

                    for (float i = -1.0; i <= 1.0; i += 1.0) {
                        for (float j = -1.0; j <= 1.0; j += 1.0) {
                            vec2 neighbor_id = id + vec2(i, j);
                            vec2 p = getpt(neighbor_id, t) + vec2(i, j);
                            float dist = length(uv - p);
                            if (dist < min_dist) {
                                min_dist = dist;
                                mv = neighbor_id;
                            }
                        }
                    }

                    float f;
                    float base_x = (mv.x / size);
                    float base_y = (mv.y / size);
                    if (uResolution.x > uResolution.y) {
                        base_x = (base_x + (r-1.0)*0.5) / r;
                    } else {
                        base_y = (base_y + (r-1.0)*0.5) / r;
                    }

                    f = pow(mix(clamp((base_x + base_y) * 0.5, 0.0, 1.0), noise(mv), jam), 1.0);

                    f = clamp(f, 0.0, 1.0);
                    f = f - pow((auv.x - mv.x / size) * 2.0 * shadow, 2.0);

                    vec3 color;
                    if (f < 0.5) {
                        color = mix(c1, c2, f * 2.0);
                    } else {
                        color = mix(c2, c3, (f - 0.5) * 2.0);
                    }
                    gl_FragColor = vec4(color, 1.0);
                }
            `
        };

        this._init();
        this._animate(0);
    }

    _init() {
        const {gl, shaderConfig} = this;
        const vertexShader = this._createShader(gl.VERTEX_SHADER, shaderConfig.vertexShader);
        const fragmentShader = this._createShader(gl.FRAGMENT_SHADER, shaderConfig.fragmentShader);

        if (!vertexShader || !fragmentShader) return;

        const program = this._createProgram(vertexShader, fragmentShader);
        if (!program) return;

        this.program = program;
        gl.useProgram(this.program);

        for (const name in shaderConfig.uniforms) {
            this.uniformLocations[name] = gl.getUniformLocation(this.program, name);
        }
        this.uniformLocations.time = gl.getUniformLocation(this.program, 'uTime');
        this.uniformLocations.resolution = gl.getUniformLocation(this.program, 'uResolution');

        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

        const positionAttributeLocation = gl.getAttribLocation(this.program, "position");
        gl.enableVertexAttribArray(positionAttributeLocation);
        gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const displayWidth = Math.round(rect.width * dpr);
        const displayHeight = Math.round(rect.height * dpr);

        if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
            this.canvas.width = displayWidth;
            this.canvas.height = displayHeight;
            this.canvas.style.width = rect.width + "px";
            this.canvas.style.height = rect.height + "px";
            this.gl.viewport(0, 0, displayWidth, displayHeight);
        }
    }

    _animate(time) {
        if (this.program) {
            this._render(time * 0.001);
        }
        requestAnimationFrame((t) => this._animate(t));
    }

    _render(time) {
        const {gl, uniformLocations, shaderConfig} = this;

        if (!gl || this.canvas.width === 0 || this.canvas.height === 0) {
            return;
        }

        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.uniform1f(uniformLocations.time, time);
        gl.uniform2f(uniformLocations.resolution, gl.canvas.width, gl.canvas.height);

        for (const name in shaderConfig.uniforms) {
            const uniformInfo = shaderConfig.uniforms[name];
            const location = uniformLocations[name];
            if (location) {
                if (uniformInfo.type === '3fv') {
                    gl.uniform3fv(location, uniformInfo.value);
                } else if (uniformInfo.type === '1f') {
                    gl.uniform1f(location, uniformInfo.value);
                }
            }
        }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    _createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(`An error occurred compiling the ${type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT'} shader: ` + gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    _createProgram(vertexShader, fragmentShader) {
        const gl = this.gl;
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(program));
            return null;
        }
        return program;
    }
}

window.addEventListener('load', () => {
    new PolygonBackground('#canvas-container');
});