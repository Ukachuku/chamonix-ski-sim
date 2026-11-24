import { TerrainData } from '../terrain/TerrainData';
import { clamp, lerp, Vec3 } from '../math/mat4';

export interface ControlState {
  left: boolean;
  right: boolean;
  brake: boolean; // S / Down Arrow -> Hockey Stop
  tuck: boolean;  // W / Up Arrow -> Aero tuck
  jump: boolean;  // Spacebar
}

export interface SkiSnapshot {
  pos: Vec3;
  vel: Vec3;
  eyePos: Vec3;
  lookTarget: Vec3;
  upVec: Vec3;
  fovRad: number;

  yaw: number;
  speedMs: number;
  speedKmh: number;
  elevationM: number;
  verticalDropM: number;
  slopeDeg: number;
  grounded: boolean;
  airTimeSec: number;
  lastJumpAirTime: number;
  justLandedStrength: number;

  edgeAngle: number;      // -1..+1 normalized edge tilt
  carveIntensity: number; // 0..1
  hockeyStop: number;     // 0..1
  hockeyYaw: number;      // radians for visual ski pivot
  pitchOffset: number;    // radians for visual ski pitch
  bounceY: number;        // meters landing compression
  turnStagger: number;    // -1..+1
  chatter: number;        // 0..1 vibration
  nearBoundary: boolean;
}

const GRAVITY = 9.81;
const EYE_HEIGHT = 1.62;

export class SkiPhysics {
  private readonly terrain: TerrainData;

  private x = 0;
  private y = 0;
  private z = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;

  private yaw = 0;
  private startElevation = 0;
  private grounded = true;
  private airTime = 0;
  private lastJumpAirTime = 0;
  private justLandedStrength = 0;
  private jumpWasPressed = false;
  private jumpCooldown = 0;

  // Smoothed visual & feel state
  private edgeAngle = 0;
  private hockeyStop = 0;
  private hockeySide = 1; // +1 or -1 direction of hockey stop pivot
  private cameraRoll = 0;
  private cameraPitch = -0.18;
  private cameraFov = 1.18; // ~68 deg
  private bounceY = 0;
  private bounceVel = 0;
  private tuckAmount = 0;
  private simTime = 0;
  private currentSlopeDeg = 0;

  constructor(terrain: TerrainData) {
    this.terrain = terrain;
    this.resetToSummit();
  }

  resetToSummit(): void {
    const sp = this.terrain.meta.spawn;
    this.x = sp.x;
    this.z = sp.z;
    this.y = this.terrain.sampleHeight(this.x, this.z);
    this.startElevation = this.y;
    this.yaw = sp.yaw;

    // Gentle initial push down the fall line so the player drops right into motion
    const initSpeed = 5.5;
    this.vx = Math.sin(this.yaw) * initSpeed;
    this.vz = -Math.cos(this.yaw) * initSpeed;
    this.vy = 0;

    this.grounded = true;
    this.airTime = 0;
    this.lastJumpAirTime = 0;
    this.justLandedStrength = 0;
    this.jumpCooldown = 0;
    this.edgeAngle = 0;
    this.hockeyStop = 0;
    this.cameraRoll = 0;
    this.cameraPitch = -0.22;
    this.cameraFov = 1.2;
    this.bounceY = 0;
    this.bounceVel = 0;
    this.tuckAmount = 0;
    this.currentSlopeDeg = this.terrain.sampleSlopeDeg(this.x, this.z);
  }

  step(dtRaw: number, controls: ControlState, active: boolean): SkiSnapshot {
    const dt = Math.min(dtRaw, 0.05);
    this.simTime += dt;
    this.justLandedStrength = 0;

    if (this.jumpCooldown > 0) {
      this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    }

    // If still on launch overlay, hold steady at the summit overlooking the Vallée Blanche
    if (!active) {
      this.y = this.terrain.sampleHeight(this.x, this.z);
      this.currentSlopeDeg = this.terrain.sampleSlopeDeg(this.x, this.z);
      const snap = this.buildSnapshot();
      snap.speedMs = 0;
      snap.speedKmh = 0;
      return snap;
    }

    const steerInput = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
    const brakeInput = controls.brake ? 1 : 0;
    const tuckInput = controls.tuck && !controls.brake ? 1 : 0;
    const jumpPressed = controls.jump && !this.jumpWasPressed;
    this.jumpWasPressed = controls.jump;

    // Remember which direction we were turning for natural hockey-stop swing direction
    if (steerInput !== 0) {
      this.hockeySide = steerInput;
    }

    // Smooth edge angle and hockey-stop engagement
    const edgeTarget = steerInput;
    this.edgeAngle = lerp(this.edgeAngle, edgeTarget, 1 - Math.exp(-9.5 * dt));
    this.hockeyStop = lerp(this.hockeyStop, brakeInput, 1 - Math.exp(-10.0 * dt));
    this.tuckAmount = lerp(this.tuckAmount, tuckInput, 1 - Math.exp(-6.0 * dt));

    const normal = this.terrain.sampleNormal(this.x, this.z, 3.5);
    this.currentSlopeDeg = (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI;

    const horizSpeed = Math.hypot(this.vx, this.vz);

    if (this.grounded) {
      // --- CARVING STEERING ---
      // Responsive turn rate that feels agile at low speed and carves sweeping arcs at high speed
      const speedFactor = clamp(horizSpeed / 12.0, 0.35, 1.35);
      const turnRate = (1.65 - 0.35 * clamp(horizSpeed / 40.0, 0, 1)) * speedFactor;
      this.yaw += this.edgeAngle * turnRate * dt;

      const fwdX = Math.sin(this.yaw);
      const fwdZ = -Math.cos(this.yaw);
      const rightX = Math.cos(this.yaw);
      const rightZ = Math.sin(this.yaw);

      // --- GRAVITY PROJECTED ONTO TERRAIN TANGENT PLANE ---
      // a_grav = g * (n.y * n - (0,1,0)) -> horizontal components are (g * n.y * n.x, g * n.y * n.z)
      // Boost gravity factor slightly (~1.22x) for exhilarating freeride acceleration feel
      const slopeAccelScale = GRAVITY * 1.24;
      let ax = slopeAccelScale * normal.y * normal.x;
      let az = slopeAccelScale * normal.y * normal.z;

      // Subtle poling/push acceleration when nearly stopped or tucking on a flat glacier bench
      if (horizSpeed < 8.0 && brakeInput < 0.2) {
        const push = (1.0 - horizSpeed / 8.0) * 3.8 + this.tuckAmount * 2.4;
        ax += fwdX * push;
        az += fwdZ * push;
      } else if (this.tuckAmount > 0.05) {
        ax += fwdX * this.tuckAmount * 1.4;
        az += fwdZ * this.tuckAmount * 1.4;
      }

      // Apply slope acceleration
      this.vx += ax * dt;
      this.vz += az * dt;

      // Decompose velocity into forward (along skis) and lateral (across ski edges)
      let vFwd = this.vx * fwdX + this.vz * fwdZ;
      let vLat = this.vx * rightX + this.vz * rightZ;

      // Carving edge grip: strong lateral bite redirects velocity cleanly along the carved ski arc!
      const carveGrip = 5.4 + Math.abs(this.edgeAngle) * 5.8;
      const latKill = 1 - Math.exp(-carveGrip * dt);
      // Transfer a generous fraction of scrubbed lateral energy into forward carved arc speed
      const transferred = Math.abs(vLat) * latKill * (0.58 * (1 - this.hockeyStop));
      vLat *= 1 - latKill;
      vFwd += Math.sign(vFwd || 1) * transferred;

      // Rolling snow friction + carving edge drag + hockey-stop aggressive snow braking
      const glideFriction = 0.042 * (1 - this.tuckAmount * 0.25);
      const carveDrag = Math.abs(this.edgeAngle) * 0.14;
      const hockeyDrag = this.hockeyStop * (1.85 + Math.min(horizSpeed * 0.075, 2.6));
      const aeroDrag = (0.00058 - this.tuckAmount * 0.00022) * Math.abs(vFwd);

      const totalForwardDecel =
        (glideFriction + carveDrag + hockeyDrag) * GRAVITY * normal.y +
        aeroDrag * Math.abs(vFwd) * Math.abs(vFwd);

      if (Math.abs(vFwd) > 0.01) {
        const nextFwd = Math.max(0, Math.abs(vFwd) - totalForwardDecel * dt);
        vFwd = Math.sign(vFwd) * nextFwd;
      }
      if (this.hockeyStop > 0.5 && Math.abs(vFwd) < 0.8) {
        vFwd *= Math.exp(-8.0 * dt);
      }

      // Reconstruct horizontal velocity
      this.vx = fwdX * vFwd + rightX * vLat;
      this.vz = fwdZ * vFwd + rightZ * vLat;

      // Compute vertical velocity tangent to the slope
      const slopeVy = -(normal.x * this.vx + normal.z * this.vz) / Math.max(normal.y, 0.2);

      // Integrate XZ position
      const nextX = this.x + this.vx * dt;
      const nextZ = this.z + this.vz * dt;
      const nextGroundH = this.terrain.sampleHeight(nextX, nextZ);

      // --- JUMPING OFF RIDGES (SPACEBAR OLLIE OR NATURAL HIGH-SPEED CREST LAUNCH) ---
      const terrainDrop = this.y + slopeVy * dt - nextGroundH;
      const naturalLaunch =
        horizSpeed > 18.0 && terrainDrop > 0.26 && this.hockeyStop < 0.3;

      if ((jumpPressed && this.jumpCooldown <= 0) || naturalLaunch) {
        const popBoost = jumpPressed
          ? 5.8 + clamp(horizSpeed * 0.14, 0, 3.6)
          : clamp(terrainDrop * 3.5, 0.5, 2.8);
        this.vy = Math.max(slopeVy, -2.0) + popBoost;
        this.grounded = false;
        this.airTime = 0;
        this.jumpCooldown = 0.45;
        this.x = nextX;
        this.z = nextZ;
        this.y += this.vy * dt;
      } else {
        this.x = nextX;
        this.z = nextZ;
        this.y = nextGroundH;
        this.vy = slopeVy;
      }
    } else {
      // --- AIRBORNE 3D BALLISTIC FLIGHT ---
      this.airTime += dt;
      // Gentle mid-air yaw control
      this.yaw += this.edgeAngle * 0.72 * dt;

      // Light air resistance
      const airDrag = Math.exp(-0.08 * dt);
      this.vx *= airDrag;
      this.vz *= airDrag;
      this.vy -= GRAVITY * dt;

      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.z += this.vz * dt;

      const newGroundH = this.terrain.sampleHeight(this.x, this.z);
      if (this.y <= newGroundH) {
        // Touchdown!
        const newNormal = this.terrain.sampleNormal(this.x, this.z, 3.5);
        const slopeVy =
          -(newNormal.x * this.vx + newNormal.z * this.vz) /
          Math.max(newNormal.y, 0.2);
        const impactVel = Math.max(0, slopeVy - this.vy);

        this.y = newGroundH;
        this.vy = slopeVy;
        this.grounded = true;
        if (this.airTime > 0.32) {
          this.lastJumpAirTime = this.airTime;
        }
        this.justLandedStrength = clamp(impactVel / 12.0, 0.15, 1.0);
        // Trigger spring landing compression dip
        this.bounceVel -= clamp(impactVel * 0.34, 0.6, 3.2);
        this.airTime = 0;
      }
    }

    // Soft massif boundary guard so player stays inside the 8.5km Chamonix heightmap
    const maxX = this.terrain.halfSizeX - 95;
    const maxZ = this.terrain.halfSizeZ - 95;
    if (this.x < -maxX) {
      this.x = -maxX;
      if (this.vx < 0) this.vx = -this.vx * 0.35;
    } else if (this.x > maxX) {
      this.x = maxX;
      if (this.vx > 0) this.vx = -this.vx * 0.35;
    }
    if (this.z < -maxZ) {
      this.z = -maxZ;
      if (this.vz < 0) this.vz = -this.vz * 0.35;
    } else if (this.z > maxZ) {
      this.z = maxZ;
      if (this.vz > 0) this.vz = -this.vz * 0.35;
    }

    // Damped spring for landing compression & knee absorption
    const springK = 48.0;
    const dampC = 9.5;
    const springAcc = -springK * this.bounceY - dampC * this.bounceVel;
    this.bounceVel += springAcc * dt;
    this.bounceY = clamp(this.bounceY + this.bounceVel * dt, -0.35, 0.12);

    // Update dynamic camera banking, pitch, and speed-responsive FOV
    const speedMs = Math.hypot(this.vx, this.vy, this.vz);
    const speedNorm = clamp(speedMs / 36.0, 0, 1);

    // Bank camera naturally into carved turns (negative roll = head leans right on right turn)
    const targetRoll =
      -this.edgeAngle * (0.14 + 0.14 * speedNorm) * (this.grounded ? 1 : 0.45);
    this.cameraRoll = lerp(this.cameraRoll, targetRoll, 1 - Math.exp(-7.5 * dt));

    // Look slightly down the slope pitch so upcoming terrain & valley always frame dramatically
    const fwdX = Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const aheadH = this.terrain.sampleHeight(this.x + fwdX * 38, this.z + fwdZ * 38);
    const lookSlope = Math.atan2(aheadH - this.y, 38.0);
    const targetPitch = clamp(
      lookSlope * 0.72 - 0.08 - this.tuckAmount * 0.04,
      -0.62,
      0.18
    );
    this.cameraPitch = lerp(this.cameraPitch, targetPitch, 1 - Math.exp(-4.5 * dt));

    // Dynamic FOV widening with speed (67 deg -> 83 deg)
    const targetFov = lerp(1.17, 1.45, speedNorm * speedNorm * 0.65 + speedNorm * 0.35);
    this.cameraFov = lerp(this.cameraFov, targetFov, 1 - Math.exp(-4.0 * dt));

    return this.buildSnapshot();
  }

  private buildSnapshot(): SkiSnapshot {
    const speedMs = Math.hypot(this.vx, this.vy, this.vz);
    const speedKmh = speedMs * 3.6;
    const speedNorm = clamp(speedMs / 35.0, 0, 1);
    const carveIntensity = this.grounded
      ? clamp(Math.abs(this.edgeAngle) * speedNorm, 0, 1)
      : 0;

    // Subtle multi-frequency terrain micro-vibration (drops to 0 when soaring airborne!)
    const chatter = this.grounded
      ? clamp(
          speedNorm * (0.35 + carveIntensity * 0.55 + this.hockeyStop * 0.75),
          0,
          1
        )
      : 0;
    const vibX =
      (Math.sin(this.simTime * 31.3) * 0.012 + Math.cos(this.simTime * 57.1) * 0.006) *
      chatter;
    const vibY =
      (Math.sin(this.simTime * 43.7) * 0.016 + Math.cos(this.simTime * 71.9) * 0.008) *
      chatter;

    const rightX = Math.cos(this.yaw);
    const rightZ = Math.sin(this.yaw);

    // Eye position (slightly lower when tucked or compressing on landing)
    const eyeH = EYE_HEIGHT - this.tuckAmount * 0.28 + this.bounceY * 0.75 + vibY;
    const eyePos: Vec3 = {
      x: this.x + rightX * vibX,
      y: this.y + eyeH,
      z: this.z + rightZ * vibX,
    };

    // Camera look vector incorporating pitch + subtle look-into-turn anticipation
    const lookYaw = this.yaw + this.edgeAngle * 0.06;
    const cosP = Math.cos(this.cameraPitch);
    const sinP = Math.sin(this.cameraPitch);
    const dirX = Math.sin(lookYaw) * cosP;
    const dirY = sinP;
    const dirZ = -Math.cos(lookYaw) * cosP;

    const lookTarget: Vec3 = {
      x: eyePos.x + dirX * 50,
      y: eyePos.y + dirY * 50,
      z: eyePos.z + dirZ * 50,
    };

    // Banked camera up vector
    const sinR = Math.sin(this.cameraRoll);
    const cosR = Math.cos(this.cameraRoll);
    const upVec: Vec3 = {
      x: rightX * sinR,
      y: cosR,
      z: rightZ * sinR,
    };

    // Visual ski pose values
    const hockeyYaw = this.hockeyStop * 0.96 * this.hockeySide;
    const skiPitchOffset = this.grounded
      ? clamp(-this.cameraPitch * 0.35, -0.18, 0.25)
      : clamp(0.18 + this.vy * 0.025, -0.12, 0.42);
    const effectiveEdge = clamp(
      this.edgeAngle + this.hockeyStop * 0.65 * this.hockeySide,
      -1.2,
      1.2
    );

    return {
      pos: { x: this.x, y: this.y, z: this.z },
      vel: { x: this.vx, y: this.vy, z: this.vz },
      eyePos,
      lookTarget,
      upVec,
      fovRad: this.cameraFov,

      yaw: this.yaw,
      speedMs,
      speedKmh,
      elevationM: this.y,
      verticalDropM: Math.max(0, this.startElevation - this.y),
      slopeDeg: this.currentSlopeDeg,
      grounded: this.grounded,
      airTimeSec: this.airTime,
      lastJumpAirTime: this.lastJumpAirTime,
      justLandedStrength: this.justLandedStrength,

      edgeAngle: effectiveEdge,
      carveIntensity,
      hockeyStop: this.hockeyStop,
      hockeyYaw,
      pitchOffset: skiPitchOffset,
      bounceY: this.bounceY * 0.35,
      turnStagger: this.edgeAngle,
      chatter,
      nearBoundary: this.terrain.isNearBoundary(this.x, this.z, 220),
    };
  }
}
