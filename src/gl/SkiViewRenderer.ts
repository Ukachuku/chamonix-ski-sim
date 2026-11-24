import { createProgram, getUniformLocation } from './glUtils';
import {
  mat4Identity,
  mat4Perspective,
  mat4RotateX,
  mat4RotateY,
  mat4RotateZ,
  mat4Translate,
  Vec3,
} from '../math/mat4';

const SKI_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;      // x: lateral [-1..1], y: length [0=tail..1=tip]
layout(location = 3) in float aPartId; // 0 = topsheet, 1 = sidewall/base, 2 = steel edge, 3 = binding

uniform mat4 uModel;
uniform mat4 uProj;

out vec3 vViewPos;
out vec3 vNormal;
out vec2 vUv;
out float vPartId;

void main() {
  vec4 vp = uModel * vec4(aPos, 1.0);
  vViewPos = vp.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vUv = aUv;
  vPartId = aPartId;
  gl_Position = uProj * vp;
}
`;

const SKI_FS = `#version 300 es
precision highp float;

uniform vec3 uSunDirView;
uniform float uSnowDust;

in vec3 vViewPos;
in vec3 vNormal;
in vec2 vUv;
in float vPartId;

out vec4 fragColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize(uSunDirView);

  vec3 baseCol = vec3(0.92, 0.94, 0.96);
  float roughness = 0.28;
  float metallic = 0.05;

  if (vPartId < 0.5) {
    // Freeride topsheet design: matte alpine ivory + deep Chamonix navy + vermilion racing chevrons
    float u = vUv.x; // -1..1
    float v = vUv.y; // 0..1 toward upturned tip

    vec3 ivory = vec3(0.91, 0.92, 0.94);
    vec3 navy = vec3(0.08, 0.14, 0.24);
    vec3 crimson = vec3(0.84, 0.20, 0.14);

    // Subtle carbon diagonal weave texture
    float weave = sin((u * 26.0 + v * 120.0)) * sin((u * 26.0 - v * 120.0));
    baseCol = ivory * (0.97 + 0.03 * weave);

    // Deep navy forward nose & center rail graphic
    float noseBlock = smoothstep(0.76, 0.775, v - abs(u) * 0.09);
    baseCol = mix(baseCol, navy, noseBlock);

    // Bold diagonal alpine chevron stripes
    float diag = v - abs(u) * 0.14;
    float stripe1 = smoothstep(0.62, 0.628, diag) * (1.0 - smoothstep(0.675, 0.683, diag));
    float stripe2 = smoothstep(0.555, 0.562, diag) * (1.0 - smoothstep(0.578, 0.585, diag));
    baseCol = mix(baseCol, crimson, stripe1);
    baseCol = mix(baseCol, navy, stripe2);

    // Clean central technical pinstripe
    float centerLine = 1.0 - smoothstep(0.05, 0.085, abs(u));
    baseCol = mix(baseCol, navy * 1.1, centerLine * step(0.15, v) * step(v, 0.54) * 0.85);

    // Subtle fresh powder snow dusting resting on the ski shovel near tips
    float dustMask = smoothstep(0.52, 0.92, v) * smoothstep(0.35, 0.95, abs(u) + 0.35);
    baseCol = mix(baseCol, vec3(0.97, 0.98, 1.0), dustMask * uSnowDust * 0.48);
    roughness = 0.24;
  } else if (vPartId < 1.5) {
    // Sidewall & P-Tex base
    baseCol = vec3(0.11, 0.12, 0.14);
    roughness = 0.45;
  } else if (vPartId < 2.5) {
    // Brushed steel ski edges
    baseCol = vec3(0.78, 0.82, 0.86);
    roughness = 0.14;
    metallic = 0.88;
  } else {
    // Freeride alpine binding toe-piece
    baseCol = vec3(0.12, 0.14, 0.18);
    roughness = 0.32;
    metallic = 0.35;
  }

  float NdotL = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 0.0);

  // Alpine lighting: direct sun + blue sky zenith + snow up-bounce
  vec3 sunCol = vec3(1.38, 1.30, 1.18);
  vec3 skyAmb = mix(vec3(0.42, 0.50, 0.62), vec3(0.52, 0.72, 0.98), clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 diff = baseCol * (sunCol * NdotL * 0.95 + skyAmb * 0.62);

  float specExp = mix(128.0, 14.0, roughness);
  float specStr = mix(0.28, 1.15, metallic);
  vec3 specCol = mix(vec3(1.0, 0.98, 0.95), baseCol, metallic * 0.5);
  vec3 spec = specCol * pow(NdotH, specExp) * specStr * (0.25 + 0.75 * NdotL);

  // Fresnel alpine sky reflection rim
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 rim = vec3(0.72, 0.84, 0.98) * fresnel * (0.22 + 0.35 * metallic);

  vec3 col = diff + spec + rim;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
`;

export interface SkiPose {
  /** Edge roll angle in radians (-left, +right) */
  edgeAngle: number;
  /** Hockey-stop sideways yaw pivot in radians */
  hockeyYaw: number;
  /** Pitch offset from slope / airborne tip-lift in radians */
  pitchOffset: number;
  /** Vertical landing compression / chatter offset in meters */
  bounceY: number;
  /** Forward stagger of outside ski during carving */
  turnStagger: number;
  /** High-frequency snow chatter intensity (0..1) */
  chatter: number;
  /** Current time in seconds */
  timeSec: number;
  /** Amount of snow dusting on ski tips (0..1) */
  snowDust: number;
}

export class SkiViewRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly indexCount: number;

  private readonly uModel: WebGLUniformLocation | null;
  private readonly uProj: WebGLUniformLocation | null;
  private readonly uSunDirView: WebGLUniformLocation | null;
  private readonly uSnowDust: WebGLUniformLocation | null;

  private readonly projMat = mat4Identity();
  private readonly modelMat = mat4Identity();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, SKI_VS, SKI_FS);
    this.uModel = getUniformLocation(gl, this.program, 'uModel');
    this.uProj = getUniformLocation(gl, this.program, 'uProj');
    this.uSunDirView = getUniformLocation(gl, this.program, 'uSunDirView');
    this.uSnowDust = getUniformLocation(gl, this.program, 'uSnowDust');

    const { vao, indexCount } = this.buildSkiMesh();
    this.vao = vao;
    this.indexCount = indexCount;
  }

  /**
   * Procedurally builds a single detailed 3D rockered freeride ski + binding toe-piece
   * aligned along -Z (forward toward tip), centered at boot underfoot (z = 0).
   */
  private buildSkiMesh(): { vao: WebGLVertexArrayObject; indexCount: number } {
    const verts: number[] = [];
    const indices: number[] = [];

    const pushVert = (
      x: number, y: number, z: number,
      nx: number, ny: number, nz: number,
      u: number, v: number, partId: number
    ): number => {
      const idx = verts.length / 9;
      verts.push(x, y, z, nx, ny, nz, u, v, partId);
      return idx;
    };

    const addQuad = (a: number, b: number, c: number, d: number) => {
      indices.push(a, b, c, a, c, d);
    };

    const slices = 36;
    const zTail = 0.55;
    const zTip = -1.32;
    const thickness = 0.015;

    interface SliceRing {
      z: number;
      yBase: number;
      halfW: number;
      v: number;
      slopeY: number;
    }

    const rings: SliceRing[] = [];
    for (let i = 0; i <= slices; i++) {
      const t = i / slices; // 0 = tail, 1 = tip
      const z = zTail + (zTip - zTail) * t;

      // Realistic freeride ski sidecut (wide shovel, tapered waist, parabolic rounded nose)
      let halfW: number;
      if (t < 0.42) {
        // Tail to underfoot waist
        const s = t / 0.42;
        halfW = 0.058 - Math.sin(s * Math.PI * 0.5) * 0.007;
      } else if (t < 0.84) {
        // Waist widening into freeride shovel
        const s = (t - 0.42) / 0.42;
        halfW = 0.051 + Math.sin(s * Math.PI * 0.5) * 0.018;
      } else {
        // Rounded parabolic ski tip
        const s = (t - 0.84) / 0.16;
        halfW = 0.069 * Math.sqrt(Math.max(0.001, 1.0 - s * s));
      }

      // Rocker curve: slight camber underfoot + graceful upturned tip starting at t = 0.70
      let yBase = 0.0;
      if (t > 0.68) {
        const r = (t - 0.68) / 0.32;
        yBase = r * r * r * 0.115;
      } else if (t < 0.12) {
        const r = (0.12 - t) / 0.12;
        yBase = r * r * 0.02;
      }

      rings.push({ z, yBase, halfW, v: t, slopeY: 0 });
    }

    // Compute longitudinal pitch slope for smooth topsheet normals
    for (let i = 0; i <= slices; i++) {
      const prev = rings[Math.max(0, i - 1)];
      const next = rings[Math.min(slices, i + 1)];
      const dy = next.yBase - prev.yBase;
      const dz = next.z - prev.z;
      rings[i].slopeY = dy / (dz || -1);
    }

    // 1. Topsheet surface (curved slightly convex across width)
    const topLeft: number[] = [];
    const topMid: number[] = [];
    const topRight: number[] = [];

    for (let i = 0; i <= slices; i++) {
      const r = rings[i];
      const crown = 0.0035 * (1.0 - Math.max(0, (r.v - 0.85) / 0.15));
      const ny = 1.0;
      const nz = -r.slopeY;
      const nLen = Math.hypot(ny, nz);

      topLeft.push(
        pushVert(-r.halfW, r.yBase + thickness, r.z, -0.18, ny / nLen, nz / nLen, -1, r.v, 0)
      );
      topMid.push(
        pushVert(0, r.yBase + thickness + crown, r.z, 0, ny / nLen, nz / nLen, 0, r.v, 0)
      );
      topRight.push(
        pushVert(r.halfW, r.yBase + thickness, r.z, 0.18, ny / nLen, nz / nLen, 1, r.v, 0)
      );
    }

    for (let i = 0; i < slices; i++) {
      addQuad(topLeft[i], topMid[i], topMid[i + 1], topLeft[i + 1]);
      addQuad(topMid[i], topRight[i], topRight[i + 1], topMid[i + 1]);
    }

    // 2. Left & Right sidewalls + steel edges
    const sideLTop: number[] = [];
    const sideLBot: number[] = [];
    const edgeLBot: number[] = [];
    const sideRTop: number[] = [];
    const sideRBot: number[] = [];
    const edgeRBot: number[] = [];

    for (let i = 0; i <= slices; i++) {
      const r = rings[i];
      // Left sidewall & steel edge
      sideLTop.push(pushVert(-r.halfW, r.yBase + thickness, r.z, -1, 0.15, 0, -1, r.v, 1));
      sideLBot.push(pushVert(-r.halfW - 0.002, r.yBase + 0.003, r.z, -1, 0, 0, -1, r.v, 2));
      edgeLBot.push(pushVert(-r.halfW - 0.002, r.yBase, r.z, -0.7, -0.7, 0, -1, r.v, 2));

      // Right sidewall & steel edge
      sideRTop.push(pushVert(r.halfW, r.yBase + thickness, r.z, 1, 0.15, 0, 1, r.v, 1));
      sideRBot.push(pushVert(r.halfW + 0.002, r.yBase + 0.003, r.z, 1, 0, 0, 1, r.v, 2));
      edgeRBot.push(pushVert(r.halfW + 0.002, r.yBase, r.z, 0.7, -0.7, 0, 1, r.v, 2));
    }

    for (let i = 0; i < slices; i++) {
      addQuad(sideLBot[i], sideLTop[i], sideLTop[i + 1], sideLBot[i + 1]);
      addQuad(edgeLBot[i], sideLBot[i], sideLBot[i + 1], edgeLBot[i + 1]);
      addQuad(sideRTop[i], sideRBot[i], sideRBot[i + 1], sideRTop[i + 1]);
      addQuad(sideRBot[i], edgeRBot[i], edgeRBot[i + 1], sideRBot[i + 1]);
    }

    // 3. Compact 3D Binding Toe-Piece box mounted near z = -0.22..-0.38
    const addBox = (
      x0: number, x1: number,
      y0: number, y1: number,
      z0: number, z1: number,
      partId: number
    ) => {
      // Top
      const t0 = pushVert(x0, y1, z1, 0, 1, 0, 0, 0, partId);
      const t1 = pushVert(x1, y1, z1, 0, 1, 0, 0, 0, partId);
      const t2 = pushVert(x1, y1, z0, 0, 1, 0, 0, 0, partId);
      const t3 = pushVert(x0, y1, z0, 0, 1, 0, 0, 0, partId);
      addQuad(t0, t1, t2, t3);
      // Front (-Z)
      const f0 = pushVert(x0, y0, z0, 0, 0, -1, 0, 0, partId);
      const f1 = pushVert(x1, y0, z0, 0, 0, -1, 0, 0, partId);
      const f2 = pushVert(x1, y1, z0, 0, 0, -1, 0, 0, partId);
      const f3 = pushVert(x0, y1, z0, 0, 0, -1, 0, 0, partId);
      addQuad(f0, f3, f2, f1);
      // Left (-X)
      const l0 = pushVert(x0, y0, z1, -1, 0, 0, 0, 0, partId);
      const l1 = pushVert(x0, y0, z0, -1, 0, 0, 0, 0, partId);
      const l2 = pushVert(x0, y1, z0, -1, 0, 0, 0, 0, partId);
      const l3 = pushVert(x0, y1, z1, -1, 0, 0, 0, 0, partId);
      addQuad(l0, l3, l2, l1);
      // Right (+X)
      const r0 = pushVert(x1, y0, z0, 1, 0, 0, 0, 0, partId);
      const r1 = pushVert(x1, y0, z1, 1, 0, 0, 0, 0, partId);
      const r2 = pushVert(x1, y1, z1, 1, 0, 0, 0, 0, partId);
      const r3 = pushVert(x1, y1, z0, 1, 0, 0, 0, 0, partId);
      addQuad(r0, r3, r2, r1);
    };

    // Binding baseplate + toe wings
    addBox(-0.036, 0.036, thickness, thickness + 0.026, -0.37, -0.18, 3);
    addBox(-0.044, 0.044, thickness + 0.012, thickness + 0.034, -0.33, -0.24, 2);

    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    const stride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 8 * 4);

    gl.bindVertexArray(null);
    return { vao, indexCount: indices.length };
  }

  render(
    aspect: number,
    fovRad: number,
    viewMatrix: Float32Array,
    sunDirWorld: Vec3,
    pose: SkiPose
  ): void {
    const gl = this.gl;
    // Clear depth buffer so first-person skis never clip into terrain triangles
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // Transform world sun direction into camera view space (rotation part of viewMatrix)
    const sx =
      viewMatrix[0] * sunDirWorld.x +
      viewMatrix[4] * sunDirWorld.y +
      viewMatrix[8] * sunDirWorld.z;
    const sy =
      viewMatrix[1] * sunDirWorld.x +
      viewMatrix[5] * sunDirWorld.y +
      viewMatrix[9] * sunDirWorld.z;
    const sz =
      viewMatrix[2] * sunDirWorld.x +
      viewMatrix[6] * sunDirWorld.y +
      viewMatrix[10] * sunDirWorld.z;

    mat4Perspective(this.projMat, fovRad, aspect, 0.05, 10.0);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uProj, false, this.projMat);
    gl.uniform3f(this.uSunDirView, sx, sy, sz);
    gl.uniform1f(this.uSnowDust, pose.snowDust);
    gl.bindVertexArray(this.vao);

    // Render Left (-1) and Right (+1) skis cleanly framed at bottom of screen
    const sides = [-1, 1];
    for (const side of sides) {
      // Subtle independent micro-chatter between left and right ski tips
      const vib =
        Math.sin(pose.timeSec * 37.0 + side * 1.9) * 0.0035 * pose.chatter +
        Math.cos(pose.timeSec * 53.0 - side * 2.4) * 0.002 * pose.chatter;
      const rollVib = Math.sin(pose.timeSec * 41.0 + side * 0.8) * 0.015 * pose.chatter;

      // Base stance below eye level so forward tips frame the bottom third of the screen cleanly
      const stanceX =
        side * 0.22 - pose.edgeAngle * 0.085 + pose.hockeyYaw * 0.32;
      const stanceY = -0.68 + pose.bounceY + vib;
      const staggerZ = -0.18 + side * pose.turnStagger * 0.075;

      // Build ski transform in view space:
      // 1. Place under feet
      mat4Identity(this.modelMat);
      mat4Translate(this.modelMat, this.modelMat, stanceX, stanceY, staggerZ);
      // 2. Hockey stop sideways pivot + slight toe-in/carve yaw
      const skiYaw = pose.hockeyYaw * 0.68 + pose.edgeAngle * 0.14;
      mat4RotateY(this.modelMat, this.modelMat, skiYaw);
      // 3. Base downward viewing angle + terrain pitch / airborne lift
      const basePitch = 0.15 + pose.pitchOffset;
      mat4RotateX(this.modelMat, this.modelMat, basePitch);
      // 4. Tilt ski sharply onto its steel edge when turning!
      // Positive edgeAngle = right turn -> tilt top of ski toward inside of turn (clockwise = -Z rotation)
      const edgeRoll = -pose.edgeAngle * 0.92 + rollVib;
      mat4RotateZ(this.modelMat, this.modelMat, edgeRoll);

      gl.uniformMatrix4fv(this.uModel, false, this.modelMat);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }

    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
  }
}
