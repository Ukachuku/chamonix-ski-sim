import { clamp, Vec3 } from '../math/mat4';

export interface TerrainLandmark {
  name: string;
  x: number;
  z: number;
  elevation: number;
  lat: number;
  lon: number;
}

export interface TerrainMeta {
  name: string;
  source: string;
  width: number;
  height: number;
  worldSizeX: number;
  worldSizeZ: number;
  minElev: number;
  maxElev: number;
  centerLat: number;
  centerLon: number;
  bounds: {
    north: number;
    south: number;
    west: number;
    east: number;
  };
  spawn: {
    x: number;
    z: number;
    elevation: number;
    yaw: number;
  };
  landmarks: TerrainLandmark[];
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export class TerrainData {
  readonly meta: TerrainMeta;
  readonly elevations: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly worldSizeX: number;
  readonly worldSizeZ: number;
  readonly halfSizeX: number;
  readonly halfSizeZ: number;
  readonly cellSizeX: number;
  readonly cellSizeZ: number;

  private constructor(meta: TerrainMeta, elevations: Float32Array) {
    this.meta = meta;
    this.elevations = elevations;
    this.width = meta.width;
    this.height = meta.height;
    this.worldSizeX = meta.worldSizeX;
    this.worldSizeZ = meta.worldSizeZ;
    this.halfSizeX = meta.worldSizeX * 0.5;
    this.halfSizeZ = meta.worldSizeZ * 0.5;
    this.cellSizeX = meta.worldSizeX / (meta.width - 1);
    this.cellSizeZ = meta.worldSizeZ / (meta.height - 1);
  }

  static async load(): Promise<TerrainData> {
    const [metaResp, binResp] = await Promise.all([
      fetch('./terrain/chamonix-meta.json'),
      fetch('./terrain/chamonix-heightmap.bin'),
    ]);
    if (!metaResp.ok) {
      throw new Error(`Failed to load terrain metadata: ${metaResp.status}`);
    }
    if (!binResp.ok) {
      throw new Error(`Failed to load terrain heightmap: ${binResp.status}`);
    }
    const meta = (await metaResp.json()) as TerrainMeta;
    const buffer = await binResp.arrayBuffer();
    const raw = new Uint16Array(buffer);
    const count = meta.width * meta.height;
    const elevations = new Float32Array(count);
    const span = meta.maxElev - meta.minElev;
    const invMax = 1 / 65535;
    for (let i = 0; i < count; i++) {
      elevations[i] = meta.minElev + raw[i] * invMax * span;
    }
    return new TerrainData(meta, elevations);
  }

  private getGrid(ix: number, iz: number): number {
    const cx = clamp(ix, 0, this.width - 1);
    const cz = clamp(iz, 0, this.height - 1);
    return this.elevations[cz * this.width + cx];
  }

  /**
   * Smooth C1 Catmull-Rom bicubic terrain elevation sample in meters ASL.
   * Gives buttery-smooth ski physics with zero heightmap facet snapping.
   */
  sampleHeight(worldX: number, worldZ: number): number {
    const u = clamp((worldX + this.halfSizeX) / this.worldSizeX, 0, 1) * (this.width - 1);
    const v = clamp((worldZ + this.halfSizeZ) / this.worldSizeZ, 0, 1) * (this.height - 1);
    const ix = Math.floor(u);
    const iz = Math.floor(v);
    const tx = u - ix;
    const tz = v - iz;

    const r0 = catmullRom(
      this.getGrid(ix - 1, iz - 1),
      this.getGrid(ix, iz - 1),
      this.getGrid(ix + 1, iz - 1),
      this.getGrid(ix + 2, iz - 1),
      tx
    );
    const r1 = catmullRom(
      this.getGrid(ix - 1, iz),
      this.getGrid(ix, iz),
      this.getGrid(ix + 1, iz),
      this.getGrid(ix + 2, iz),
      tx
    );
    const r2 = catmullRom(
      this.getGrid(ix - 1, iz + 1),
      this.getGrid(ix, iz + 1),
      this.getGrid(ix + 1, iz + 1),
      this.getGrid(ix + 2, iz + 1),
      tx
    );
    const r3 = catmullRom(
      this.getGrid(ix - 1, iz + 2),
      this.getGrid(ix, iz + 2),
      this.getGrid(ix + 1, iz + 2),
      this.getGrid(ix + 2, iz + 2),
      tx
    );

    return catmullRom(r0, r1, r2, r3, tz);
  }

  /** Bilinear height matching vertex interpolation closely for visual placement (tracks, etc). */
  sampleHeightBilinear(worldX: number, worldZ: number): number {
    const u = clamp((worldX + this.halfSizeX) / this.worldSizeX, 0, 1) * (this.width - 1);
    const v = clamp((worldZ + this.halfSizeZ) / this.worldSizeZ, 0, 1) * (this.height - 1);
    const ix = Math.floor(u);
    const iz = Math.floor(v);
    const tx = u - ix;
    const tz = v - iz;
    const h00 = this.getGrid(ix, iz);
    const h10 = this.getGrid(ix + 1, iz);
    const h01 = this.getGrid(ix, iz + 1);
    const h11 = this.getGrid(ix + 1, iz + 1);
    const hx0 = h00 + (h10 - h00) * tx;
    const hx1 = h01 + (h11 - h01) * tx;
    return hx0 + (hx1 - hx0) * tz;
  }

  /** Smooth unit surface normal computed via central differences on the bicubic surface. */
  sampleNormal(worldX: number, worldZ: number, eps = 3.0): Vec3 {
    const hL = this.sampleHeight(worldX - eps, worldZ);
    const hR = this.sampleHeight(worldX + eps, worldZ);
    const hD = this.sampleHeight(worldX, worldZ - eps);
    const hU = this.sampleHeight(worldX, worldZ + eps);
    const nx = -(hR - hL) / (2 * eps);
    const ny = 1.0;
    const nz = -(hU - hD) / (2 * eps);
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** Slope angle in degrees (0 = flat, 90 = sheer vertical cliff). */
  sampleSlopeDeg(worldX: number, worldZ: number): number {
    const n = this.sampleNormal(worldX, worldZ);
    return (Math.acos(clamp(n.y, -1, 1)) * 180) / Math.PI;
  }

  isNearBoundary(worldX: number, worldZ: number, margin = 220): boolean {
    return (
      Math.abs(worldX) > this.halfSizeX - margin ||
      Math.abs(worldZ) > this.halfSizeZ - margin
    );
  }
}
