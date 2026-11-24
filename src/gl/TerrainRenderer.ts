import { createProgram, getUniformLocation } from './glUtils';
import { TerrainData } from '../terrain/TerrainData';
import { aabbIntersectsFrustum, Vec3 } from '../math/mat4';

const TERRAIN_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;

uniform mat4 uViewProj;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;

void main() {
  vWorldPos = aPos;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const TERRAIN_FS = `#version 300 es
precision highp float;

uniform sampler2D uLightMap;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform float uTime;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += amp * noise2(p);
    p = rot * p * 2.05;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 toCam = uCameraPos - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 0.001);

  // Sample pre-baked alpine lightmap: R=sunShadow, G=skyAO, B=curvature, A=localSlopeY
  vec4 lm = texture(uLightMap, vUv);
  float castShadow = lm.r;
  float skyAO = lm.g;
  float curvature = lm.b; // >0.5 ridge, <0.5 couloir/valley

  // Multi-scale procedural detail coordinates
  vec2 wp = vWorldPos.xz;
  float macroN = fbm2(wp * 0.0045);
  float medN = fbm2(wp * 0.028);
  float fineN = noise2(wp * 0.19);
  float microN = noise2(wp * 0.85);

  // Wind-sculpted snow sastrugi ripples (aligned with NW alpine wind)
  vec2 windUv = vec2(wp.x * 0.16 + wp.y * 0.10, wp.y * 0.48 - wp.x * 0.26);
  float sastrugi1 = noise2(windUv);
  float sastrugi2 = noise2(windUv * 2.4 + vec2(3.7, 1.4));
  float sastrugi = sastrugi1 * 0.62 + sastrugi2 * 0.38;

  // Compute steep exposed Chamonix granite cliff mask from slope + ridge curvature + organic fBm
  // cos(29 deg) ≈ 0.875 -> 1-Ny ≈ 0.125; cos(40 deg) ≈ 0.766 -> 1-Ny ≈ 0.234
  float slopeSteepness = 1.0 - clamp(N.y, 0.0, 1.0);
  float ridgeBoost = smoothstep(0.51, 0.84, curvature) * 0.095;
  float rockNoise = (macroN - 0.5) * 0.095 + (medN - 0.5) * 0.065;
  float rockMask = smoothstep(0.115, 0.245, slopeSteepness + ridgeBoost + rockNoise);

  // Organic snow ledges trapped on fractured rock faces (warped fBm, zero contour banding)
  float rockWarp = fbm2(wp * 0.015 + vec2(vWorldPos.y * 0.012, -vWorldPos.y * 0.008));
  float ledgeSnow = smoothstep(0.54, 0.82, rockWarp) * smoothstep(0.62, 0.86, N.y) * 0.42;
  rockMask = clamp(rockMask - ledgeSnow, 0.0, 1.0);

  // Lower Chamonix valley snowline transition (below ~1650m alpine forest / dark talus)
  float valleyRock = smoothstep(1680.0, 1180.0, vWorldPos.y) * (0.45 + 0.4 * medN);
  float alpineForestMask = smoothstep(1620.0, 1220.0, vWorldPos.y) * smoothstep(0.28, 0.10, slopeSteepness);

  // Perturb normal for crisp close snow sastrugi & rugged fractured granite crags
  float detailFade = 1.0 - smoothstep(110.0, 1100.0, dist);
  vec2 snowGrad = vec2(
    noise2(windUv + vec2(0.08, 0.0)) - sastrugi1,
    noise2(windUv + vec2(0.0, 0.08)) - sastrugi1
  ) * 2.15 * detailFade;

  float rockFreq = 0.065;
  vec2 rockCoord = wp * rockFreq + vec2(vWorldPos.y * 0.04, -vWorldPos.y * 0.055);
  float r0 = fbm2(rockCoord);
  float rX = fbm2(rockCoord + vec2(0.22, 0.0));
  float rZ = fbm2(rockCoord + vec2(0.0, 0.22));
  vec2 rockGrad = vec2(rX - r0, rZ - r0) * 6.2 * (0.45 + 0.55 * detailFade);

  vec2 microGrad = mix(snowGrad, rockGrad, rockMask);
  vec3 bumpedN = normalize(vec3(N.x + microGrad.x, N.y, N.z + microGrad.y));

  // --- MATERIAL ALBEDOS ---
  // 1. Crisp alpine snow with glacial blue wind-scoured depth
  vec3 freshSnow = vec3(0.92, 0.95, 0.99);
  vec3 windSnow = vec3(0.76, 0.85, 0.95);
  vec3 glacierIce = vec3(0.32, 0.62, 0.84);

  float windScour = smoothstep(0.46, 0.84, curvature) * 0.42 + (sastrugi - 0.5) * 0.32;
  vec3 snowAlbedo = mix(freshSnow, windSnow, clamp(windScour, 0.0, 1.0));

  // Subtle high-altitude glacial serac blue-ice peeking on steep concave glacier walls
  float iceMask = smoothstep(2350.0, 2950.0, vWorldPos.y)
    * smoothstep(0.10, 0.22, slopeSteepness)
    * smoothstep(0.55, 0.30, curvature)
    * smoothstep(0.46, 0.76, medN)
    * (1.0 - rockMask);
  snowAlbedo = mix(snowAlbedo, glacierIce, iceMask * 0.55);

  // 2. Chamonix Mont Blanc Protogine granite (dramatic dark slate + warm alpine feldspar)
  vec3 graniteDark = vec3(0.09, 0.11, 0.14);
  vec3 graniteMid = vec3(0.22, 0.23, 0.26);
  vec3 graniteWarm = vec3(0.32, 0.27, 0.23);
  float rockTone = clamp(r0 * 0.65 + rockWarp * 0.35, 0.0, 1.0);
  vec3 rockAlbedo = mix(graniteDark, graniteMid, rockTone);
  rockAlbedo = mix(rockAlbedo, graniteWarm, smoothstep(0.44, 0.76, macroN) * 0.55);

  // Alpine pine/dark valley floor far down in Chamonix
  vec3 pineCol = vec3(0.08, 0.14, 0.11) * (0.75 + 0.5 * fineN);

  vec3 albedo = mix(snowAlbedo, rockAlbedo, clamp(rockMask + valleyRock * 0.45, 0.0, 1.0));
  albedo = mix(albedo, pineCol, alpineForestMask * 0.78);

  // --- ALPINE SUNLIGHT & SHADOW LIGHTING ---
  float NdotL = max(dot(bumpedN, uSunDir), 0.0);
  float macroNdotL = max(dot(N, uSunDir), 0.0);

  // Combine baked mountain-scale cast shadow with smooth self-shadowing
  float sunVis = castShadow * smoothstep(0.0, 0.14, macroNdotL);

  // Crisp high-altitude warm sunlight
  vec3 sunColor = vec3(1.26, 1.16, 1.02);
  vec3 directLight = sunColor * NdotL * sunVis;

  // Dramatic glacial cobalt sky hemisphere fill in shadows (high alpine snow shadow contrast!)
  float hemi = bumpedN.y * 0.5 + 0.5;
  vec3 skyFill = mix(vec3(0.16, 0.28, 0.48), vec3(0.28, 0.48, 0.78), hemi);
  vec3 snowBounce = vec3(0.16, 0.22, 0.32) * (1.0 - hemi) * 0.45;
  vec3 ambientLight = (skyFill * 0.56 + snowBounce) * (0.30 + 0.70 * skyAO);

  // Snow subsurface scattering / wrap lighting on sunlit snow ridges
  float snowFactor = 1.0 - rockMask;
  float wrapDiff = max((dot(bumpedN, uSunDir) + 0.25) / 1.25, 0.0);
  vec3 sssGlow = vec3(0.12, 0.18, 0.28) * wrapDiff * snowFactor * castShadow * 0.26;

  // Specular highlight: crisp icy sheen + ultra-fine pinpoint snow micro-crystal glints
  vec3 H = normalize(uSunDir + V);
  float NdotH = max(dot(bumpedN, H), 0.0);
  float snowSpec = pow(NdotH, 48.0) * 0.28 * snowFactor * sunVis;
  float rockSpec = pow(NdotH, 18.0) * 0.10 * rockMask * sunVis;

  // Pinpoint 4cm snow micro-crystal sparkle glints (zero blocky squares!)
  float sparkleFade = (1.0 - smoothstep(6.0, 55.0, dist)) * snowFactor * sunVis;
  float glintHash = hash21(floor(wp * 26.0 + V.xz * 4.0 + sin(uTime * 0.35) * 0.08));
  float sparkle = smoothstep(0.992, 0.9995, glintHash) * pow(max(dot(N, H), 0.0), 8.0) * sparkleFade * 0.95;

  vec3 lit = albedo * (directLight + ambientLight) + sssGlow + vec3(1.0, 0.97, 0.92) * (snowSpec + rockSpec + sparkle);

  // Crisp close-range snow micro-grain & sastrugi relief so ground speed reads viscerally
  float closeRelief = ((sastrugi - 0.5) * 0.12 + (fineN * 0.55 + microN * 0.45 - 0.5) * 0.095)
    * (1.0 - smoothstep(14.0, 140.0, dist));
  lit *= (1.0 + closeRelief);

  // --- ATMOSPHERIC PERSPECTIVE & CHAMONIX VALLEY HAZE ---
  float sunAlign = max(dot(-V, uSunDir), 0.0);
  vec3 fogBase = vec3(0.55, 0.72, 0.91);
  vec3 fogSun = vec3(0.92, 0.86, 0.76);
  vec3 fogCol = mix(fogBase, fogSun, pow(sunAlign, 4.0) * 0.42);

  // Crisp alpine aerial perspective (lets distant Mont Blanc granite peaks shine through!)
  float distFog = 1.0 - exp(-dist * 0.000145);
  // Misty inversion haze pooled deep down in Chamonix valley (< 1850m)
  float valleyDepth = smoothstep(2000.0, 1150.0, vWorldPos.y);
  float valleyMist = valleyDepth * (1.0 - exp(-dist * 0.00050)) * 0.55;
  float fogAmount = clamp(max(distFog, valleyMist), 0.0, 0.88);

  vec3 col = mix(lit, fogCol, fogAmount);

  // ACES filmic tone curve matching sky dome
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));

  fragColor = vec4(col, 1.0);
}
`;

interface TerrainTile {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export class TerrainRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly tiles: TerrainTile[] = [];
  private readonly lightMapTex: WebGLTexture;

  private readonly uViewProj: WebGLUniformLocation | null;
  private readonly uLightMap: WebGLUniformLocation | null;
  private readonly uCameraPos: WebGLUniformLocation | null;
  private readonly uSunDir: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;

  constructor(
    gl: WebGL2RenderingContext,
    terrain: TerrainData,
    lightMapTex: WebGLTexture
  ) {
    this.gl = gl;
    this.lightMapTex = lightMapTex;
    this.program = createProgram(gl, TERRAIN_VS, TERRAIN_FS);

    this.uViewProj = getUniformLocation(gl, this.program, 'uViewProj');
    this.uLightMap = getUniformLocation(gl, this.program, 'uLightMap');
    this.uCameraPos = getUniformLocation(gl, this.program, 'uCameraPos');
    this.uSunDir = getUniformLocation(gl, this.program, 'uSunDir');
    this.uTime = getUniformLocation(gl, this.program, 'uTime');

    this.buildTiledMesh(terrain);
  }

  private buildTiledMesh(terrain: TerrainData): void {
    const gl = this.gl;
    const W = terrain.width;
    const H = terrain.height;
    const elev = terrain.elevations;

    // Precompute smooth normals across entire grid
    const normals = new Float32Array(W * H * 3);
    const cellX = terrain.cellSizeX;
    const cellZ = terrain.cellSizeZ;
    for (let z = 0; z < H; z++) {
      const zm = Math.max(0, z - 1);
      const zp = Math.min(H - 1, z + 1);
      for (let x = 0; x < W; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(W - 1, x + 1);
        const hL = elev[z * W + xm];
        const hR = elev[z * W + xp];
        const hD = elev[zm * W + x];
        const hU = elev[zp * W + x];
        const dxSpan = (xp - xm) * cellX;
        const dzSpan = (zp - zm) * cellZ;
        const nx = -(hR - hL) / dxSpan;
        const ny = 1.0;
        const nz = -(hU - hD) / dzSpan;
        const len = Math.hypot(nx, ny, nz) || 1;
        const idx = (z * W + x) * 3;
        normals[idx] = nx / len;
        normals[idx + 1] = ny / len;
        normals[idx + 2] = nz / len;
      }
    }

    // Divide 512x512 grid into 8x8 frustum-culled tiles
    const tilesPerAxis = 8;
    for (let tz = 0; tz < tilesPerAxis; tz++) {
      const zStart = Math.floor((tz * (H - 1)) / tilesPerAxis);
      const zEnd = Math.floor(((tz + 1) * (H - 1)) / tilesPerAxis);
      const rows = zEnd - zStart + 1;

      for (let tx = 0; tx < tilesPerAxis; tx++) {
        const xStart = Math.floor((tx * (W - 1)) / tilesPerAxis);
        const xEnd = Math.floor(((tx + 1) * (W - 1)) / tilesPerAxis);
        const cols = xEnd - xStart + 1;

        const verts = new Float32Array(cols * rows * 8);
        let vPtr = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let gz = zStart; gz <= zEnd; gz++) {
          const v = gz / (H - 1);
          const wz = (v - 0.5) * terrain.worldSizeZ;
          for (let gx = xStart; gx <= xEnd; gx++) {
            const u = gx / (W - 1);
            const wx = (u - 0.5) * terrain.worldSizeX;
            const wy = elev[gz * W + gx];
            const nIdx = (gz * W + gx) * 3;

            verts[vPtr++] = wx;
            verts[vPtr++] = wy;
            verts[vPtr++] = wz;
            verts[vPtr++] = normals[nIdx];
            verts[vPtr++] = normals[nIdx + 1];
            verts[vPtr++] = normals[nIdx + 2];
            verts[vPtr++] = u;
            verts[vPtr++] = v;

            if (wx < minX) minX = wx;
            if (wx > maxX) maxX = wx;
            if (wy < minY) minY = wy;
            if (wy > maxY) maxY = wy;
            if (wz < minZ) minZ = wz;
            if (wz > maxZ) maxZ = wz;
          }
        }

        const quadCount = (cols - 1) * (rows - 1);
        const indices = new Uint16Array(quadCount * 6);
        let iPtr = 0;
        for (let r = 0; r < rows - 1; r++) {
          for (let c = 0; c < cols - 1; c++) {
            const i00 = r * cols + c;
            const i10 = i00 + 1;
            const i01 = i00 + cols;
            const i11 = i01 + 1;
            // Counter-clockwise when viewed from above (+Y)
            indices[iPtr++] = i00;
            indices[iPtr++] = i01;
            indices[iPtr++] = i10;
            indices[iPtr++] = i10;
            indices[iPtr++] = i01;
            indices[iPtr++] = i11;
          }
        }

        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);

        const vbo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        const ebo = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        const stride = 8 * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);

        gl.bindVertexArray(null);

        this.tiles.push({
          vao,
          indexCount: indices.length,
          minX,
          minY,
          minZ,
          maxX,
          maxY,
          maxZ,
        });
      }
    }
  }

  render(
    viewProj: Float32Array,
    frustumPlanes: Float32Array,
    cameraPos: Vec3,
    sunDir: Vec3,
    timeSec: number
  ): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProj);
    gl.uniform3f(this.uCameraPos, cameraPos.x, cameraPos.y, cameraPos.z);
    gl.uniform3f(this.uSunDir, sunDir.x, sunDir.y, sunDir.z);
    gl.uniform1f(this.uTime, timeSec);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightMapTex);
    gl.uniform1i(this.uLightMap, 0);

    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (
        !aabbIntersectsFrustum(
          frustumPlanes,
          tile.minX,
          tile.minY,
          tile.minZ,
          tile.maxX,
          tile.maxY,
          tile.maxZ
        )
      ) {
        continue;
      }
      gl.bindVertexArray(tile.vao);
      gl.drawElements(gl.TRIANGLES, tile.indexCount, gl.UNSIGNED_SHORT, 0);
    }

    gl.bindVertexArray(null);
  }
}
