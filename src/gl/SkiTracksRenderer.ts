import { createProgram, getUniformLocation } from './glUtils';
import { TerrainData } from '../terrain/TerrainData';
import { Vec3 } from '../math/mat4';

const TRACKS_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aTrackData; // x = lateral [-1..1], y = carveDepth [0..1]

uniform mat4 uViewProj;

out vec3 vWorldPos;
out vec2 vTrackData;

void main() {
  vWorldPos = aPos;
  vTrackData = aTrackData;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const TRACKS_FS = `#version 300 es
precision highp float;

uniform vec3 uCameraPos;
uniform vec3 uSunDir;

in vec3 vWorldPos;
in vec2 vTrackData;

out vec4 fragColor;

void main() {
  float u = vTrackData.x; // -1..+1 across single ski track
  float depth = vTrackData.y;
  float dist = length(uCameraPos - vWorldPos);

  float absU = abs(u);
  // Sculpted trough profile: darkened cool-blue snow trough in center + sunlit snow rim on edges
  float trough = 1.0 - smoothstep(0.18, 0.72, absU);
  float rim = smoothstep(0.45, 0.78, absU) * (1.0 - smoothstep(0.78, 1.0, absU));

  float sunLift = clamp(uSunDir.y * 1.35 + 0.35, 0.5, 1.15);
  vec3 troughCol = vec3(0.42, 0.56, 0.76);
  vec3 rimCol = vec3(0.98, 0.99, 1.0) * sunLift;
  vec3 col = mix(troughCol, rimCol, rim * 0.7);

  float alpha = (trough * (0.48 + depth * 0.32) + rim * 0.28);
  // Distance fade into alpine haze
  float distFade = 1.0 - smoothstep(120.0, 950.0, dist);
  alpha *= distFade;

  if (alpha < 0.01) discard;

  // Match terrain tone mapping lightly
  col = mix(col, vec3(0.78, 0.86, 0.95), clamp(1.0 - exp(-dist * 0.00025), 0.0, 0.85));
  fragColor = vec4(col, clamp(alpha, 0.0, 0.85));
}
`;

interface TrackPoint {
  leftX: number;
  leftY: number;
  leftZ: number;
  rightX: number;
  rightY: number;
  rightZ: number;
  sideX: number;
  sideZ: number;
  halfWidth: number;
  depth: number;
}

const MAX_SEGMENTS = 1400; // 1400 quads per ski -> ~1.5-2.5 km of crisp twin carved tracks!
// Each segment = 2 skis * 2 triangles * 3 verts = 12 verts * 5 floats
const FLOATS_PER_VERTEX = 5;
const VERTS_PER_SEGMENT = 12;

export class SkiTracksRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly vertexData: Float32Array;

  private readonly uViewProj: WebGLUniformLocation | null;
  private readonly uCameraPos: WebGLUniformLocation | null;
  private readonly uSunDir: WebGLUniformLocation | null;

  private segmentCount = 0;
  private writeIndex = 0;
  private lastPoint: TrackPoint | null = null;
  private lastEmitX = 0;
  private lastEmitZ = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, TRACKS_VS, TRACKS_FS);
    this.uViewProj = getUniformLocation(gl, this.program, 'uViewProj');
    this.uCameraPos = getUniformLocation(gl, this.program, 'uCameraPos');
    this.uSunDir = getUniformLocation(gl, this.program, 'uSunDir');

    this.vertexData = new Float32Array(
      MAX_SEGMENTS * VERTS_PER_SEGMENT * FLOATS_PER_VERTEX
    );

    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
    gl.bindVertexArray(null);
  }

  clear(): void {
    this.segmentCount = 0;
    this.writeIndex = 0;
    this.lastPoint = null;
  }

  /** Break current continuous track (e.g. when launching airborne off a ridge). */
  breakTrack(): void {
    this.lastPoint = null;
  }

  /**
   * Append a new carved twin ski-track sample behind the skier when grounded.
   */
  recordPoint(
    terrain: TerrainData,
    worldX: number,
    worldZ: number,
    yaw: number,
    carveIntensity: number,
    hockeyStop: number
  ): void {
    // Only emit when moved enough from last recorded node
    if (this.lastPoint !== null) {
      const dist = Math.hypot(worldX - this.lastEmitX, worldZ - this.lastEmitZ);
      if (dist < 0.9) return;
      if (dist > 35.0) {
        this.lastPoint = null;
      }
    }

    // Ski stance right-vector perpendicular to travel heading
    const sideX = Math.cos(yaw);
    const sideZ = Math.sin(yaw);
    const halfStance = 0.26; // Realistic ski stance ~52 cm center-to-center

    // Left & right ski contact positions in world XZ
    const lx = worldX - sideX * halfStance;
    const lz = worldZ - sideZ * halfStance;
    const rx = worldX + sideX * halfStance;
    const rz = worldZ + sideZ * halfStance;

    // Conform cleanly to the rendered terrain triangles (+0.19m offset prevents dipping on convex crests)
    const ly =
      Math.max(terrain.sampleHeightBilinear(lx, lz), terrain.sampleHeight(lx, lz)) +
      0.19;
    const ry =
      Math.max(terrain.sampleHeightBilinear(rx, rz), terrain.sampleHeight(rx, rz)) +
      0.19;

    const halfWidth = 0.11 + carveIntensity * 0.1 + hockeyStop * 0.22;
    const depth = Math.min(1.0, 0.25 + carveIntensity * 0.55 + hockeyStop * 0.65);

    const cur: TrackPoint = {
      leftX: lx,
      leftY: ly,
      leftZ: lz,
      rightX: rx,
      rightY: ry,
      rightZ: rz,
      sideX,
      sideZ,
      halfWidth,
      depth,
    };

    if (this.lastPoint !== null) {
      this.writeSegment(this.lastPoint, cur);
    }

    this.lastPoint = cur;
    this.lastEmitX = worldX;
    this.lastEmitZ = worldZ;
  }

  private writeSegment(a: TrackPoint, b: TrackPoint): void {
    const baseFloat = this.writeIndex * VERTS_PER_SEGMENT * FLOATS_PER_VERTEX;
    let ptr = baseFloat;
    const d = this.vertexData;

    const pushVert = (x: number, y: number, z: number, u: number, depth: number) => {
      d[ptr++] = x;
      d[ptr++] = y;
      d[ptr++] = z;
      d[ptr++] = u;
      d[ptr++] = depth;
    };

    const emitStrip = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number
    ) => {
      const aLx = ax - a.sideX * a.halfWidth;
      const aLz = az - a.sideZ * a.halfWidth;
      const aRx = ax + a.sideX * a.halfWidth;
      const aRz = az + a.sideZ * a.halfWidth;

      const bLx = bx - b.sideX * b.halfWidth;
      const bLz = bz - b.sideZ * b.halfWidth;
      const bRx = bx + b.sideX * b.halfWidth;
      const bRz = bz + b.sideZ * b.halfWidth;

      // Tri 1
      pushVert(aLx, ay, aLz, -1, a.depth);
      pushVert(bLx, by, bLz, -1, b.depth);
      pushVert(aRx, ay, aRz, 1, a.depth);
      // Tri 2
      pushVert(aRx, ay, aRz, 1, a.depth);
      pushVert(bLx, by, bLz, -1, b.depth);
      pushVert(bRx, by, bRz, 1, b.depth);
    };

    // Left ski track strip
    emitStrip(a.leftX, a.leftY, a.leftZ, b.leftX, b.leftY, b.leftZ);
    // Right ski track strip
    emitStrip(a.rightX, a.rightY, a.rightZ, b.rightX, b.rightY, b.rightZ);

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const sub = this.vertexData.subarray(
      baseFloat,
      baseFloat + VERTS_PER_SEGMENT * FLOATS_PER_VERTEX
    );
    gl.bufferSubData(gl.ARRAY_BUFFER, baseFloat * 4, sub);

    this.writeIndex = (this.writeIndex + 1) % MAX_SEGMENTS;
    if (this.segmentCount < MAX_SEGMENTS) {
      this.segmentCount++;
    }
  }

  render(viewProj: Float32Array, cameraPos: Vec3, sunDir: Vec3): void {
    if (this.segmentCount === 0) return;
    const gl = this.gl;

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2.0, -4.0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj);
    gl.uniform3f(this.uCameraPos, cameraPos.x, cameraPos.y, cameraPos.z);
    gl.uniform3f(this.uSunDir, sunDir.x, sunDir.y, sunDir.z);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.segmentCount * VERTS_PER_SEGMENT);
    gl.bindVertexArray(null);

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }
}
