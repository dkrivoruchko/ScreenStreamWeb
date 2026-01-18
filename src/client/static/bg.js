"use strict";

(() => {
    const container = document.querySelector('#canvas-container');
    if (!container) {
        console.error("PolygonBackground Error: Container element not found:", '#canvas-container');
        return;
    }

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) {
        console.error("PolygonBackground Error: Unable to initialize WebGL.");
        return;
    }

    container.appendChild(canvas);

    const vertexShaderSource = `
        precision highp float;
        attribute vec2 position;
        void main() {
            gl_Position = vec4(position, 0.0, 1.0);
        }
    `;
    const fragmentShaderSource = `
        precision mediump float;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform sampler2D uNoise;
        uniform vec3 c1, c2, c3;
        uniform float size, speed, rand, jam, shadow;

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
                    vec2 n = texture2D(uNoise, fract(neighbor_id * 0.01)).rg;
                    vec2 pt = vec2(
                        texture2D(uNoise, vec2(fract((neighbor_id.x + n.y * 625.788) * 0.01), 0.5)).r,
                        texture2D(uNoise, vec2(fract((neighbor_id.y + n.x * 9527.145) * 0.01), 0.5)).r
                    ) * t;
                    pt = vec2(cos(pt.x), sin(pt.y)) * rand;
                    vec2 p = pt + vec2(i, j);
                    vec2 d = uv - p;
                    float dist = dot(d, d);
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

            f = mix(clamp((base_x + base_y) * 0.5, 0.0, 1.0), texture2D(uNoise, fract(mv * 0.01)).r, jam);

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
    `;

    const createShader = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(`An error occurred compiling the ${type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT'} shader: ` + gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    };

    const createProgram = (vertexShader, fragmentShader) => {
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(program));
            return null;
        }
        return program;
    };

    const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) return;

    const program = createProgram(vertexShader, fragmentShader);
    if (!program) return;

    gl.useProgram(program);

    const timeLoc = gl.getUniformLocation(program, 'uTime');
    const resolutionLoc = gl.getUniformLocation(program, 'uResolution');
    const noiseLoc = gl.getUniformLocation(program, 'uNoise');

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const positionAttributeLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    const createNoiseTexture = (size) => {
        const data = new Uint8Array(size * size * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.floor(Math.random() * 256);
            data[i + 1] = Math.floor(Math.random() * 256);
            data[i + 2] = 255;
            data[i + 3] = 255;
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return tex;
    };

    const noiseTexture = createNoiseTexture(128);
    if (noiseTexture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
        gl.uniform1i(noiseLoc, 0);
    }

    let loc = gl.getUniformLocation(program, 'c1');
    gl.uniform3fv(loc, [0.0, 0.07, 0.11]);
    loc = gl.getUniformLocation(program, 'c2');
    gl.uniform3fv(loc, [0.0745, 0.1686, 0.2588]);
    loc = gl.getUniformLocation(program, 'c3');
    gl.uniform3fv(loc, [0.0, 0.07, 0.11]);
    loc = gl.getUniformLocation(program, 'size');
    gl.uniform1f(loc, 30.0);
    loc = gl.getUniformLocation(program, 'rand');
    gl.uniform1f(loc, 0.5);
    loc = gl.getUniformLocation(program, 'jam');
    gl.uniform1f(loc, 0.12);
    loc = gl.getUniformLocation(program, 'shadow');
    gl.uniform1f(loc, 0.92);
    loc = gl.getUniformLocation(program, 'speed');
    gl.uniform1f(loc, 0.3);

    const resize = () => {
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const displayWidth = Math.round(rect.width * dpr);
        const displayHeight = Math.round(rect.height * dpr);

        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;
            canvas.style.width = rect.width + "px";
            canvas.style.height = rect.height + "px";
            gl.viewport(0, 0, displayWidth, displayHeight);
        }
    };

    resize();
    window.addEventListener('resize', resize);

    const minFrameTime = 1000 / 15;
    let lastFrameTime = 0;
    let paused = document.visibilityState === 'hidden';
    let rafId = 0;

    const render = (time) => {
        rafId = 0;
        if (paused) {
            return;
        }
        if (canvas.width === 0 || canvas.height === 0) {
            rafId = requestAnimationFrame(render);
            return;
        }
        if ((time - lastFrameTime) >= minFrameTime) {
            gl.uniform1f(timeLoc, time * 0.001);
            gl.uniform2f(resolutionLoc, gl.canvas.width, gl.canvas.height);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            lastFrameTime = time;
        }
        rafId = requestAnimationFrame(render);
    };

    const start = () => {
        if (!rafId) {
            rafId = requestAnimationFrame(render);
        }
    };

    document.addEventListener('visibilitychange', () => {
        const wasPaused = paused;
        paused = document.visibilityState === 'hidden';
        if (!paused && wasPaused) {
            start();
        }
    });

    if (!paused) {
        start();
    }
})();
