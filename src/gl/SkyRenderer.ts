import { createProgram, getUniformLocation } from './glUtils';
import { Vec3 } from '../math/mat4';

const SKY_VS = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
out vec2 vNdc;
void main() {
  vNdc = POS[gl_VertexID];
  gl_Position = vec4(vNdc, 0.9999, 1.0);
}
`;

const SKY_FS = `#version 300 es
precision highp float;

uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform float uTime;

in vec2 vNdc;
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += amp * noise(p);
    p = rot * p * 2.08;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec4 worldFar = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(worldFar.xyz / worldFar.w - uCameraPos);

  float elev = clamp(dir.y, -0.25, 1.0);
  float up = max(dir.y, 0.0);

  // High-altitude Mont Blanc alpine sky gradient: rich cobalt zenith to crisp ice-blue horizon
  vec3 zenithCol = vec3(0.035, 0.15, 0.46);
  vec3 midSkyCol = vec3(0.14, 0.38, 0.74);
  vec3 horizonCol = vec3(0.60, 0.77, 0.93);

  vec3 col = mix(horizonCol, midSkyCol, pow(up, 0.36));
  col = mix(col, zenithCol, pow(up, 0.85));

  // Warm atmospheric horizon band toward the sun
  float sunCos = max(dot(dir, uSunDir), 0.0);
  float horizonWarmth = exp(-abs(dir.y) * 8.0) * pow(sunCos, 2.8);
  col += vec3(0.28, 0.21, 0.13) * horizonWarmth;

  // Mie forward scattering aureole + crisp alpine sun disc
  float mieGlow = pow(sunCos, 12.0) * 0.28 + pow(sunCos, 96.0) * 0.65;
  float sunDisc = smoothstep(0.99935, 0.99975, sunCos);
  col += vec3(1.0, 0.95, 0.86) * mieGlow;
  col += vec3(2.8, 2.55, 2.15) * sunDisc;

  // Subtle high-altitude alpine cirrus wisps
  if (dir.y > 0.03) {
    vec2 cloudUv = dir.xz / (dir.y + 0.18) * 1.15 + vec2(uTime * 0.0022, -uTime * 0.0009);
    float c1 = fbm(cloudUv * 1.8);
    float c2 = fbm(cloudUv * 3.7 + vec2(4.2, -1.9));
    float wisps = smoothstep(0.56, 0.85, c1 * 0.65 + c2 * 0.45);
    float fadeHorizon = smoothstep(0.03, 0.20, dir.y) * smoothstep(0.95, 0.35, dir.y);
    vec3 cloudCol = mix(vec3(0.76, 0.85, 0.96), vec3(1.0, 0.97, 0.92), pow(sunCos, 3.0) * 0.7 + 0.3);
    col = mix(col, cloudCol, wisps * fadeHorizon * 0.34);
  }

  // Below horizon alpine valley haze fill
  if (elev < 0.0) {
    vec3 valleyMist = vec3(0.52, 0.67, 0.84);
    col = mix(horizonCol, valleyMist, clamp(-elev * 5.0, 0.0, 1.0));
  }

  // ACES filmic tone curve (preserves deep cobalt blues & crisp alpine highlights)
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
`;

export class SkyRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uInvViewProj: WebGLUniformLocation | null;
  private readonly uCameraPos: WebGLUniformLocation | null;
  private readonly uSunDir: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, SKY_VS, SKY_FS);
    this.vao = gl.createVertexArray()!;
    this.uInvViewProj = getUniformLocation(gl, this.program, 'uInvViewProj');
    this.uCameraPos = getUniformLocation(gl, this.program, 'uCameraPos');
    this.uSunDir = getUniformLocation(gl, this.program, 'uSunDir');
    this.uTime = getUniformLocation(gl, this.program, 'uTime');
  }

  render(
    invViewProj: Float32Array,
    cameraPos: Vec3,
    sunDir: Vec3,
    timeSec: number
  ): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uInvViewProj, false, invViewProj);
    gl.uniform3f(this.uCameraPos, cameraPos.x, cameraPos.y, cameraPos.z);
    gl.uniform3f(this.uSunDir, sunDir.x, sunDir.y, sunDir.z);
    gl.uniform1f(this.uTime, timeSec);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }
}
