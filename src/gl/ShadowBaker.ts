import { createProgram, getUniformLocation } from './glUtils';
import { TerrainData } from '../terrain/TerrainData';
import { Vec3 } from '../math/mat4';

const FULLSCREEN_VS = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const BAKE_FS = `#version 300 es
precision highp float;

uniform sampler2D uHeightTex;
uniform vec2 uGridSize;
uniform vec2 uWorldSize;
uniform vec3 uSunDir;

in vec2 vUv;
out vec4 fragColor;

float sampleHeight(vec2 uv) {
  vec2 clamped = clamp(uv, vec2(0.0), vec2(1.0));
  vec2 fc = clamped * (uGridSize - 1.0);
  ivec2 i0 = ivec2(floor(fc));
  ivec2 i1 = min(i0 + ivec2(1), ivec2(uGridSize) - ivec2(1));
  vec2 f = fract(fc);
  float h00 = texelFetch(uHeightTex, i0, 0).r;
  float h10 = texelFetch(uHeightTex, ivec2(i1.x, i0.y), 0).r;
  float h01 = texelFetch(uHeightTex, ivec2(i0.x, i1.y), 0).r;
  float h11 = texelFetch(uHeightTex, i1, 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

void main() {
  float h0 = sampleHeight(vUv);
  vec2 texel = 1.0 / (uGridSize - 1.0);

  // 1. Directional alpine sunlight soft raymarched shadow across the massif
  vec2 sunHoriz = uSunDir.xz;
  float sunHorizLen = max(length(sunHoriz), 1e-4);
  vec2 rayDirXZ = sunHoriz / sunHorizLen;
  float sunSlope = uSunDir.y / sunHorizLen;

  float shadow = 1.0;
  float dist = 16.0;
  for (int i = 0; i < 96; i++) {
    vec2 sampleWorldOffset = rayDirXZ * dist;
    vec2 suv = vUv + sampleWorldOffset / uWorldSize;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
      break;
    }
    float sh = sampleHeight(suv);
    float rayH = h0 + sunSlope * dist;
    float diff = sh - rayH;
    if (diff > 0.0) {
      // Soft penumbra proportional to occlusion angle
      float penumbra = clamp(1.0 - (diff / (dist * 0.055 + 4.0)), 0.0, 1.0);
      shadow = min(shadow, penumbra);
      if (shadow < 0.02) {
        shadow = 0.0;
        break;
      }
    }
    dist += 16.0 + float(i) * 1.15;
  }

  // 2. Multi-direction horizon ambient occlusion (8 directions x 3 radii)
  float aoSum = 0.0;
  const float PI = 3.14159265;
  for (int d = 0; d < 8; d++) {
    float ang = float(d) * (PI * 0.25);
    vec2 dir = vec2(cos(ang), sin(ang));
    float maxAngle = 0.0;
    for (int r = 1; r <= 4; r++) {
      float rad = float(r * r) * 28.0;
      vec2 suv = vUv + (dir * rad) / uWorldSize;
      float sh = sampleHeight(suv);
      float slope = (sh - h0) / rad;
      maxAngle = max(maxAngle, atan(max(slope, 0.0)));
    }
    aoSum += 1.0 - clamp(maxAngle / (PI * 0.48), 0.0, 1.0);
  }
  float ao = clamp(aoSum / 8.0, 0.15, 1.0);

  // 3. Ridge vs couloir curvature (Laplacian) encoded in [0, 1] (0.5 = neutral)
  float hL = sampleHeight(vUv - vec2(texel.x, 0.0));
  float hR = sampleHeight(vUv + vec2(texel.x, 0.0));
  float hD = sampleHeight(vUv - vec2(0.0, texel.y));
  float hU = sampleHeight(vUv + vec2(0.0, texel.y));
  float avgN = 0.25 * (hL + hR + hD + hU);
  float curv = clamp((h0 - avgN) / 14.0 * 0.5 + 0.5, 0.0, 1.0);

  // 4. Local micro-slope normal Y
  vec2 cell = uWorldSize / (uGridSize - 1.0);
  float gx = (hR - hL) / (2.0 * cell.x);
  float gz = (hU - hD) / (2.0 * cell.y);
  float ny = inversesqrt(gx * gx + gz * gz + 1.0);

  fragColor = vec4(shadow, ao, curv, ny);
}
`;

export interface BakedTerrainMaps {
  heightTex: WebGLTexture;
  lightMapTex: WebGLTexture;
}

/**
 * Uploads the 512x512 float heightmap to an R32F WebGL2 texture and bakes
 * mountain-scale soft alpine shadows, sky AO, and ridge curvature into an RGBA8 texture.
 */
export function bakeTerrainMaps(
  gl: WebGL2RenderingContext,
  terrain: TerrainData,
  sunDir: Vec3
): BakedTerrainMaps {
  // Upload R32F elevation texture
  const heightTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    terrain.width,
    terrain.height,
    0,
    gl.RED,
    gl.FLOAT,
    terrain.elevations
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Allocate target RGBA8 lightmap texture
  const lightMapTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, lightMapTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    terrain.width,
    terrain.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    lightMapTex,
    0
  );

  const program = createProgram(gl, FULLSCREEN_VS, BAKE_FS);
  const vao = gl.createVertexArray()!;

  gl.viewport(0, 0, terrain.width, terrain.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.uniform1i(getUniformLocation(gl, program, 'uHeightTex'), 0);
  gl.uniform2f(
    getUniformLocation(gl, program, 'uGridSize'),
    terrain.width,
    terrain.height
  );
  gl.uniform2f(
    getUniformLocation(gl, program, 'uWorldSize'),
    terrain.worldSizeX,
    terrain.worldSizeZ
  );
  gl.uniform3f(
    getUniformLocation(gl, program, 'uSunDir'),
    sunDir.x,
    sunDir.y,
    sunDir.z
  );

  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, lightMapTex);
  gl.generateMipmap(gl.TEXTURE_2D);

  gl.deleteFramebuffer(fbo);
  gl.deleteVertexArray(vao);
  gl.deleteProgram(program);

  return { heightTex, lightMapTex };
}
