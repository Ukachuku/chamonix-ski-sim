import { createProgram, getUniformLocation } from './glUtils';
import { Vec3 } from '../math/mat4';

// Layer 1: GPU-wrapping ambient blowing alpine spindrift snow
const AMBIENT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aSeed; // [0..1]^3 random start position
layout(location = 1) in float aSize;

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float uSpeedRatio;
uniform float uPixelRatio;

out float vAlpha;

void main() {
  const float BOX = 64.0;
  // Wind blowing briskly across the Vallée Blanche ridges + downward snowfall
  vec3 wind = vec3(5.8, -2.1, 3.2) * uTime;
  vec3 swirl = vec3(
    sin(uTime * 1.4 + aSeed.y * 19.0) * 1.6,
    cos(uTime * 1.1 + aSeed.x * 17.0) * 0.6,
    cos(uTime * 1.3 + aSeed.z * 23.0) * 1.6
  );

  // Wrap seamlessly in a 64m cube centered on the camera
  vec3 rel = mod(aSeed * BOX + wind + swirl - uCameraPos, BOX) - (BOX * 0.5);
  vec3 worldPos = uCameraPos + rel;

  float dist = length(rel);
  float edgeFade = 1.0 - smoothstep(BOX * 0.34, BOX * 0.5, dist);
  float nearFade = smoothstep(1.2, 4.5, dist);
  vAlpha = edgeFade * nearFade * (0.42 + uSpeedRatio * 0.25);

  vec4 clip = uViewProj * vec4(worldPos, 1.0);
  gl_Position = clip;
  float projSize = (aSize * (1.0 + uSpeedRatio * 0.4) * 28.0 * uPixelRatio) / max(clip.w, 1.0);
  gl_PointSize = clamp(projSize, 1.2, 9.0);
}
`;

const PARTICLE_FS = `#version 300 es
precision highp float;

in float vAlpha;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float soft = exp(-r2 * 13.0);
  vec3 snowCol = vec3(0.95, 0.98, 1.0);
  fragColor = vec4(snowCol, soft * vAlpha);
}
`;

// Layer 2: Dynamic ski-carve & hockey-stop powder spray plume
const SPRAY_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in float aLife; // 0..1 normalized remaining life
layout(location = 2) in float aSize;

uniform mat4 uViewProj;
uniform float uPixelRatio;

out float vAlpha;

void main() {
  vAlpha = smoothstep(0.0, 0.25, aLife) * smoothstep(1.0, 0.7, aLife) * 0.68;
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  float size = aSize * (1.35 - aLife * 0.5) * 85.0 * uPixelRatio / max(clip.w, 0.6);
  gl_PointSize = clamp(size, 2.0, 42.0);
}
`;

const AMBIENT_COUNT = 2200;
const MAX_SPRAY = 900;

export class SnowParticleRenderer {
  private readonly gl: WebGL2RenderingContext;

  // Ambient blowing snow
  private readonly ambProg: WebGLProgram;
  private readonly ambVao: WebGLVertexArrayObject;
  private readonly uAmbVP: WebGLUniformLocation | null;
  private readonly uAmbCam: WebGLUniformLocation | null;
  private readonly uAmbTime: WebGLUniformLocation | null;
  private readonly uAmbSpeed: WebGLUniformLocation | null;
  private readonly uAmbDpr: WebGLUniformLocation | null;

  // Dynamic carve & hockey-stop spray
  private readonly sprayProg: WebGLProgram;
  private readonly sprayVao: WebGLVertexArrayObject;
  private readonly sprayVbo: WebGLBuffer;
  private readonly uSprayVP: WebGLUniformLocation | null;
  private readonly uSprayDpr: WebGLUniformLocation | null;

  private readonly sprayPos = new Float32Array(MAX_SPRAY * 3);
  private readonly sprayVel = new Float32Array(MAX_SPRAY * 3);
  private readonly sprayLife = new Float32Array(MAX_SPRAY);
  private readonly sprayMaxLife = new Float32Array(MAX_SPRAY);
  private readonly spraySize = new Float32Array(MAX_SPRAY);
  private readonly sprayGpuBuf = new Float32Array(MAX_SPRAY * 5);
  private sprayCursor = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    // 1. Ambient spindrift setup
    this.ambProg = createProgram(gl, AMBIENT_VS, PARTICLE_FS);
    this.uAmbVP = getUniformLocation(gl, this.ambProg, 'uViewProj');
    this.uAmbCam = getUniformLocation(gl, this.ambProg, 'uCameraPos');
    this.uAmbTime = getUniformLocation(gl, this.ambProg, 'uTime');
    this.uAmbSpeed = getUniformLocation(gl, this.ambProg, 'uSpeedRatio');
    this.uAmbDpr = getUniformLocation(gl, this.ambProg, 'uPixelRatio');

    const seeds = new Float32Array(AMBIENT_COUNT * 4);
    for (let i = 0; i < AMBIENT_COUNT; i++) {
      seeds[i * 4] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = 0.6 + Math.random() * 1.4;
    }

    this.ambVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ambVao);
    const ambVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ambVbo);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);

    // 2. Dynamic spray setup
    this.sprayProg = createProgram(gl, SPRAY_VS, PARTICLE_FS);
    this.uSprayVP = getUniformLocation(gl, this.sprayProg, 'uViewProj');
    this.uSprayDpr = getUniformLocation(gl, this.sprayProg, 'uPixelRatio');

    this.sprayVao = gl.createVertexArray()!;
    this.sprayVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.sprayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sprayVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.sprayGpuBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
    gl.bindVertexArray(null);
  }

  emitSpray(
    origin: Vec3,
    skierVel: Vec3,
    sprayDirX: number,
    sprayDirZ: number,
    count: number,
    intensity: number
  ): void {
    for (let n = 0; n < count; n++) {
      const i = this.sprayCursor;
      this.sprayCursor = (this.sprayCursor + 1) % MAX_SPRAY;

      const jitterX = (Math.random() - 0.5) * 0.7;
      const jitterZ = (Math.random() - 0.5) * 0.7;
      this.sprayPos[i * 3] = origin.x + jitterX;
      this.sprayPos[i * 3 + 1] = origin.y + 0.15 + Math.random() * 0.25;
      this.sprayPos[i * 3 + 2] = origin.z + jitterZ;

      const kick = (2.5 + Math.random() * 5.2) * (0.5 + intensity);
      this.sprayVel[i * 3] =
        skierVel.x * 0.35 + sprayDirX * kick + (Math.random() - 0.5) * 2.4;
      this.sprayVel[i * 3 + 1] =
        1.6 + Math.random() * 3.2 * (0.5 + intensity * 0.8);
      this.sprayVel[i * 3 + 2] =
        skierVel.z * 0.35 + sprayDirZ * kick + (Math.random() - 0.5) * 2.4;

      const life = 0.45 + Math.random() * 0.65;
      this.sprayLife[i] = life;
      this.sprayMaxLife[i] = life;
      this.spraySize[i] = 0.25 + Math.random() * 0.55 * (0.7 + intensity * 0.6);
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-2.1 * dt);
    for (let i = 0; i < MAX_SPRAY; i++) {
      if (this.sprayLife[i] <= 0) continue;
      this.sprayLife[i] -= dt;
      if (this.sprayLife[i] <= 0) {
        this.sprayLife[i] = 0;
        continue;
      }
      const b = i * 3;
      this.sprayVel[b] *= drag;
      this.sprayVel[b + 1] = this.sprayVel[b + 1] * drag - 6.8 * dt;
      this.sprayVel[b + 2] *= drag;

      this.sprayPos[b] += this.sprayVel[b] * dt;
      this.sprayPos[b + 1] += this.sprayVel[b + 1] * dt;
      this.sprayPos[b + 2] += this.sprayVel[b + 2] * dt;
    }
  }

  render(
    viewProj: Float32Array,
    cameraPos: Vec3,
    timeSec: number,
    speedRatio: number,
    dpr: number
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 1. Ambient blowing snow
    gl.useProgram(this.ambProg);
    gl.uniformMatrix4fv(this.uAmbVP, false, viewProj);
    gl.uniform3f(this.uAmbCam, cameraPos.x, cameraPos.y, cameraPos.z);
    gl.uniform1f(this.uAmbTime, timeSec);
    gl.uniform1f(this.uAmbSpeed, speedRatio);
    gl.uniform1f(this.uAmbDpr, dpr);
    gl.bindVertexArray(this.ambVao);
    gl.drawArrays(gl.POINTS, 0, AMBIENT_COUNT);

    // 2. Dynamic carve & hockey-stop snow spray
    let activeCount = 0;
    for (let i = 0; i < MAX_SPRAY; i++) {
      if (this.sprayLife[i] <= 0) continue;
      const g = activeCount * 5;
      this.sprayGpuBuf[g] = this.sprayPos[i * 3];
      this.sprayGpuBuf[g + 1] = this.sprayPos[i * 3 + 1];
      this.sprayGpuBuf[g + 2] = this.sprayPos[i * 3 + 2];
      this.sprayGpuBuf[g + 3] = this.sprayLife[i] / this.sprayMaxLife[i];
      this.sprayGpuBuf[g + 4] = this.spraySize[i];
      activeCount++;
    }

    if (activeCount > 0) {
      gl.useProgram(this.sprayProg);
      gl.uniformMatrix4fv(this.uSprayVP, false, viewProj);
      gl.uniform1f(this.uSprayDpr, dpr);
      gl.bindVertexArray(this.sprayVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sprayVbo);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.sprayGpuBuf.subarray(0, activeCount * 5)
      );
      gl.drawArrays(gl.POINTS, 0, activeCount);
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
