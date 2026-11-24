export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function normalize3(x: number, y: number, z: number): Vec3 {
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

export function mat4Identity(out: Float32Array = new Float32Array(16)): Float32Array {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function mat4Perspective(
  out: Float32Array,
  fovyRad: number,
  aspect: number,
  near: number,
  far: number
): Float32Array {
  const f = 1.0 / Math.tan(fovyRad * 0.5);
  const nf = 1.0 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function mat4LookAt(
  out: Float32Array,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  upX: number,
  upY: number,
  upZ: number
): Float32Array {
  let zx = eyeX - centerX;
  let zy = eyeY - centerY;
  let zz = eyeZ - centerZ;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = upY * zz - upZ * zy;
  let xy = upZ * zx - upX * zz;
  let xz = upX * zy - upY * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;

  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;

  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;

  out[12] = -(xx * eyeX + xy * eyeY + xz * eyeZ);
  out[13] = -(yx * eyeX + yy * eyeY + yz * eyeZ);
  out[14] = -(zx * eyeX + zy * eyeY + zz * eyeZ);
  out[15] = 1;
  return out;
}

export function mat4Multiply(
  out: Float32Array,
  a: Float32Array,
  b: Float32Array
): Float32Array {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4];
    const b1 = b[i * 4 + 1];
    const b2 = b[i * 4 + 2];
    const b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function mat4Translate(
  out: Float32Array,
  m: Float32Array,
  x: number,
  y: number,
  z: number
): Float32Array {
  if (out !== m) out.set(m);
  out[12] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[13] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[14] = m[2] * x + m[6] * y + m[10] * z + m[14];
  out[15] = m[3] * x + m[7] * y + m[11] * z + m[15];
  return out;
}

export function mat4RotateX(out: Float32Array, m: Float32Array, rad: number): Float32Array {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  if (out !== m) out.set(m);
  out[4] = a10 * c + a20 * s;
  out[5] = a11 * c + a21 * s;
  out[6] = a12 * c + a22 * s;
  out[7] = a13 * c + a23 * s;
  out[8] = a20 * c - a10 * s;
  out[9] = a21 * c - a11 * s;
  out[10] = a22 * c - a12 * s;
  out[11] = a23 * c - a13 * s;
  return out;
}

export function mat4RotateY(out: Float32Array, m: Float32Array, rad: number): Float32Array {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  if (out !== m) out.set(m);
  out[0] = a00 * c - a20 * s;
  out[1] = a01 * c - a21 * s;
  out[2] = a02 * c - a22 * s;
  out[3] = a03 * c - a23 * s;
  out[8] = a00 * s + a20 * c;
  out[9] = a01 * s + a21 * c;
  out[10] = a02 * s + a22 * c;
  out[11] = a03 * s + a23 * c;
  return out;
}

export function mat4RotateZ(out: Float32Array, m: Float32Array, rad: number): Float32Array {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  if (out !== m) out.set(m);
  out[0] = a00 * c + a10 * s;
  out[1] = a01 * c + a11 * s;
  out[2] = a02 * c + a12 * s;
  out[3] = a03 * c + a13 * s;
  out[4] = a10 * c - a00 * s;
  out[5] = a11 * c - a01 * s;
  out[6] = a12 * c - a02 * s;
  out[7] = a13 * c - a03 * s;
  return out;
}

export function mat4Invert(out: Float32Array, a: Float32Array): Float32Array | null {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Extract 6 normalized frustum planes (a, b, c, d) from a view-projection matrix. */
export function extractFrustumPlanes(vp: Float32Array, out: Float32Array): void {
  const m0 = vp[0], m1 = vp[1], m2 = vp[2], m3 = vp[3];
  const m4 = vp[4], m5 = vp[5], m6 = vp[6], m7 = vp[7];
  const m8 = vp[8], m9 = vp[9], m10 = vp[10], m11 = vp[11];
  const m12 = vp[12], m13 = vp[13], m14 = vp[14], m15 = vp[15];

  const planes = [
    [m3 + m0, m7 + m4, m11 + m8, m15 + m12], // Left
    [m3 - m0, m7 - m4, m11 - m8, m15 - m12], // Right
    [m3 + m1, m7 + m5, m11 + m9, m15 + m13], // Bottom
    [m3 - m1, m7 - m5, m11 - m9, m15 - m13], // Top
    [m3 + m2, m7 + m6, m11 + m10, m15 + m14], // Near
    [m3 - m2, m7 - m6, m11 - m10, m15 - m14], // Far
  ];

  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    out[i * 4] = p[0] / len;
    out[i * 4 + 1] = p[1] / len;
    out[i * 4 + 2] = p[2] / len;
    out[i * 4 + 3] = p[3] / len;
  }
}

export function aabbIntersectsFrustum(
  planes: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): boolean {
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4];
    const b = planes[i * 4 + 1];
    const c = planes[i * 4 + 2];
    const d = planes[i * 4 + 3];
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) {
      return false;
    }
  }
  return true;
}
