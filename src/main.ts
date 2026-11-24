import './styles.css';
import {
  clamp,
  extractFrustumPlanes,
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  normalize3,
} from './math/mat4';
import { TerrainData } from './terrain/TerrainData';
import { bakeTerrainMaps } from './gl/ShadowBaker';
import { SkyRenderer } from './gl/SkyRenderer';
import { TerrainRenderer } from './gl/TerrainRenderer';
import { SkiTracksRenderer } from './gl/SkiTracksRenderer';
import { SnowParticleRenderer } from './gl/SnowParticleRenderer';
import { SkiViewRenderer } from './gl/SkiViewRenderer';
import { ControlState, SkiPhysics } from './physics/SkiPhysics';
import { SkiAudio } from './audio/SkiAudio';

function formatCompass(yawRad: number): string {
  // yaw = 0 -> North (0 deg), +PI/2 -> East (90 deg)
  let deg = ((yawRad * 180) / Math.PI) % 360;
  if (deg < 0) deg += 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(deg / 45) % 8;
  return `${Math.round(deg).toString().padStart(3, '0')}° ${dirs[idx]}`;
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
  const launchOverlay = document.getElementById('launch-overlay')!;
  const btnDropIn = document.getElementById('btn-drop-in') as HTMLButtonElement;
  const btnDropInLabel = document.getElementById('btn-drop-in-label')!;
  const btnMute = document.getElementById('btn-mute') as HTMLButtonElement;
  const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
  const iconSoundOn = document.getElementById('icon-sound-on')!;
  const iconSoundOff = document.getElementById('icon-sound-off')!;
  const muteLabel = document.getElementById('mute-label')!;
  const errorOverlay = document.getElementById('error-overlay')!;
  const errorMessage = document.getElementById('error-message')!;

  const hudSpeed = document.getElementById('hud-speed')!;
  const hudSpeedBar = document.getElementById('hud-speed-bar')!;
  const hudElevation = document.getElementById('hud-elevation')!;
  const hudSlope = document.getElementById('hud-slope')!;
  const hudSlopeLine = document.getElementById('hud-slope-line')!;
  const hudHeading = document.getElementById('hud-heading')!;
  const hudDrop = document.getElementById('hud-drop')!;
  const hudCallout = document.getElementById('hud-callout')!;

  btnDropIn.disabled = true;

  const gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    depth: true,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    errorOverlay.classList.remove('hidden');
    launchOverlay.classList.add('hidden');
    return;
  }

  let terrain: TerrainData;
  try {
    terrain = await TerrainData.load();
  } catch (err) {
    errorOverlay.classList.remove('hidden');
    launchOverlay.classList.add('hidden');
    errorMessage.textContent =
      err instanceof Error ? err.message : 'Failed to load Chamonix heightmap.';
    return;
  }

  // Dramatic morning alpine sunlight from the ESE across the Vallée Blanche ridges
  // Casts sculptural shadows across steep granite cliffs and snow couloirs
  const sunDir = normalize3(0.68, 0.44, 0.58);

  // Bake mountain-scale alpine sun shadows, sky AO, and curvature map on GPU
  const { lightMapTex } = bakeTerrainMaps(gl, terrain, sunDir);

  // Initialize renderers, physics, and Web Audio synthesizer
  const skyRenderer = new SkyRenderer(gl);
  const terrainRenderer = new TerrainRenderer(gl, terrain, lightMapTex);
  const tracksRenderer = new SkiTracksRenderer(gl);
  const particleRenderer = new SnowParticleRenderer(gl);
  const skiViewRenderer = new SkiViewRenderer(gl);
  const physics = new SkiPhysics(terrain);
  const audio = new SkiAudio();

  btnDropIn.disabled = false;
  btnDropInLabel.textContent = 'Drop In — Vallée Blanche';

  let started = false;
  let calloutTimer = 0;
  let calloutText = '';
  let snowDustOnSkis = 0.22;

  const controls: ControlState = {
    left: false,
    right: false,
    brake: false,
    tuck: false,
    jump: false,
  };

  const syncMuteUI = () => {
    const muted = audio.isMuted;
    btnMute.setAttribute('aria-pressed', String(muted));
    btnMute.classList.toggle('muted', muted);
    iconSoundOn.classList.toggle('hidden', muted);
    iconSoundOff.classList.toggle('hidden', !muted);
    muteLabel.textContent = muted ? 'Muted' : 'Sound';
  };

  const startRun = () => {
    audio.unlock();
    if (!started) {
      started = true;
      launchOverlay.classList.add('fade-out');
      window.setTimeout(() => {
        launchOverlay.classList.add('hidden');
      }, 340);
    }
  };

  const resetRun = () => {
    audio.unlock();
    physics.resetToSummit();
    tracksRenderer.clear();
    snowDustOnSkis = 0.2;
    calloutText = 'AIGUILLE DU MIDI · 3,671 M';
    calloutTimer = 2.0;
  };

  btnDropIn.addEventListener('click', startRun);

  btnMute.addEventListener('click', () => {
    audio.unlock();
    audio.toggleMute();
    syncMuteUI();
  });

  btnReset.addEventListener('click', () => {
    resetRun();
    if (!started) startRun();
  });

  const handleKey = (e: KeyboardEvent, down: boolean) => {
    const code = e.code;
    if (
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'Space'
    ) {
      e.preventDefault();
    }

    if (down) {
      if (
        !started &&
        (code === 'KeyA' ||
          code === 'KeyD' ||
          code === 'KeyW' ||
          code === 'KeyS' ||
          code === 'ArrowLeft' ||
          code === 'ArrowRight' ||
          code === 'ArrowUp' ||
          code === 'ArrowDown' ||
          code === 'Space' ||
          code === 'Enter')
      ) {
        startRun();
      } else {
        audio.unlock();
      }

      if (code === 'KeyR' && !e.repeat) {
        resetRun();
        if (!started) startRun();
        return;
      }
      if (code === 'KeyM' && !e.repeat) {
        audio.toggleMute();
        syncMuteUI();
        return;
      }
    }

    switch (code) {
      case 'KeyA':
      case 'ArrowLeft':
        controls.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        controls.right = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        controls.brake = down;
        break;
      case 'KeyW':
      case 'ArrowUp':
        controls.tuck = down;
        break;
      case 'Space':
        controls.jump = down;
        break;
    }
  };

  window.addEventListener('keydown', (e) => handleKey(e, true));
  window.addEventListener('keyup', (e) => handleKey(e, false));
  window.addEventListener('blur', () => {
    controls.left = false;
    controls.right = false;
    controls.brake = false;
    controls.tuck = false;
    controls.jump = false;
  });

  // Viewport resize handling with crisp Retina DPR cap
  let canvasW = 1;
  let canvasH = 1;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasW = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvasH = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }
  };
  resize();
  window.addEventListener('resize', resize);

  // Reusable math buffers
  const projMat = mat4Identity();
  const viewMat = mat4Identity();
  const viewProjMat = mat4Identity();
  const invViewProjMat = mat4Identity();
  const frustumPlanes = new Float32Array(24);

  let prevTime = performance.now();
  let hudAccum = 0;

  const frame = (now: number) => {
    requestAnimationFrame(frame);

    const dt = clamp((now - prevTime) / 1000, 0.001, 0.05);
    prevTime = now;
    const timeSec = now * 0.001;

    // 1. Step ski physics
    const snap = physics.step(dt, controls, started);

    // 2. Record carved twin ski tracks & emit dynamic powder spray
    if (started) {
      if (snap.grounded) {
        tracksRenderer.recordPoint(
          terrain,
          snap.pos.x,
          snap.pos.z,
          snap.yaw,
          snap.carveIntensity,
          snap.hockeyStop
        );

        // Emit snow spray during carving or hockey stops
        const rightX = Math.cos(snap.yaw);
        const rightZ = Math.sin(snap.yaw);
        const sprayFactor = Math.max(snap.carveIntensity * 0.85, snap.hockeyStop * 1.25);

        if (sprayFactor > 0.16 && snap.speedKmh > 10) {
          const dirSign = snap.edgeAngle >= 0 ? -1 : 1; // Spray throws to outside of turn
          const count = Math.min(18, Math.floor(sprayFactor * (snap.speedKmh / 14)));
          if (count > 0) {
            particleRenderer.emitSpray(
              snap.pos,
              snap.vel,
              rightX * dirSign,
              rightZ * dirSign,
              count,
              sprayFactor
            );
          }
          snowDustOnSkis = clamp(snowDustOnSkis + dt * sprayFactor * 0.55, 0.15, 1.0);
        } else {
          snowDustOnSkis = clamp(snowDustOnSkis - dt * 0.08, 0.15, 1.0);
        }
      } else {
        tracksRenderer.breakTrack();
      }

      // Trigger powder burst & landing thump on touchdown
      if (snap.justLandedStrength > 0) {
        audio.triggerLanding(snap.justLandedStrength);
        particleRenderer.emitSpray(
          snap.pos,
          snap.vel,
          0,
          0,
          Math.floor(18 + snap.justLandedStrength * 34),
          1.1
        );
        if (snap.lastJumpAirTime > 0.45) {
          calloutText = `AIRTIME · ${snap.lastJumpAirTime.toFixed(1)}S`;
          calloutTimer = 1.9;
        }
      }
    }

    particleRenderer.update(dt);

    // 3. Modulate procedural Web Audio (wind rush + snow carving)
    audio.update(
      snap.speedKmh,
      snap.carveIntensity,
      snap.hockeyStop,
      snap.grounded,
      started
    );

    // 4. Build camera matrices
    const aspect = canvasW / canvasH;
    mat4Perspective(projMat, snap.fovRad, aspect, 0.35, 15000.0);
    mat4LookAt(
      viewMat,
      snap.eyePos.x,
      snap.eyePos.y,
      snap.eyePos.z,
      snap.lookTarget.x,
      snap.lookTarget.y,
      snap.lookTarget.z,
      snap.upVec.x,
      snap.upVec.y,
      snap.upVec.z
    );
    mat4Multiply(viewProjMat, projMat, viewMat);
    mat4Invert(invViewProjMat, viewProjMat);
    extractFrustumPlanes(viewProjMat, frustumPlanes);

    // 5. Render WebGL2 scene
    gl.viewport(0, 0, canvasW, canvasH);
    gl.clearColor(0.55, 0.72, 0.9, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Pass A: High-altitude Alpine Sky Dome
    skyRenderer.render(invViewProjMat, snap.eyePos, sunDir, timeSec);

    // Pass B: Chamonix Real Terrain (snow, granite cliffs, cast shadows, valley haze)
    terrainRenderer.render(viewProjMat, frustumPlanes, snap.eyePos, sunDir, timeSec);

    // Pass C: Twin Carved Ski Tracks
    tracksRenderer.render(viewProjMat, snap.eyePos, sunDir);

    // Pass D: Blowing Alpine Snow & Carve Powder Spray
    particleRenderer.render(
      viewProjMat,
      snap.eyePos,
      timeSec,
      clamp(snap.speedKmh / 100, 0, 1.3),
      dpr
    );

    // Pass E: First-Person 3D Skis (depth-cleared near pass)
    skiViewRenderer.render(aspect, snap.fovRad, viewMat, sunDir, {
      edgeAngle: snap.edgeAngle,
      hockeyYaw: snap.hockeyYaw,
      pitchOffset: snap.pitchOffset,
      bounceY: snap.bounceY,
      turnStagger: snap.turnStagger,
      chatter: snap.chatter,
      timeSec,
      snowDust: snowDustOnSkis,
    });

    // 6. Throttled HUD updates (~20 Hz for crisp readability & zero DOM thrash)
    hudAccum += dt;
    if (hudAccum >= 0.05) {
      hudAccum = 0;
      const kmh = Math.round(snap.speedKmh);
      hudSpeed.textContent = String(kmh);
      hudSpeedBar.style.width = `${clamp((snap.speedKmh / 120) * 100, 0, 100)}%`;
      hudElevation.textContent = `${Math.round(snap.elevationM).toLocaleString()} m`;
      const slopeRounded = Math.round(snap.slopeDeg);
      hudSlope.textContent = `${slopeRounded}°`;
      hudSlopeLine.style.transform = `rotate(${clamp(slopeRounded, 0, 65)}deg)`;
      hudHeading.textContent = formatCompass(snap.yaw);
      hudDrop.textContent = `${Math.round(snap.verticalDropM).toLocaleString()} m`;

      if (calloutTimer > 0) {
        calloutTimer = Math.max(0, calloutTimer - 0.05);
      }

      if (!snap.grounded && snap.airTimeSec > 0.25) {
        hudCallout.textContent = `AIRBORNE · ${snap.airTimeSec.toFixed(1)}S`;
        hudCallout.classList.remove('hidden');
      } else if (snap.nearBoundary) {
        hudCallout.textContent = 'VALLEY BOUNDARY · PRESS R FOR SUMMIT LIFT';
        hudCallout.classList.remove('hidden');
      } else if (calloutTimer > 0 && calloutText) {
        hudCallout.textContent = calloutText;
        hudCallout.classList.remove('hidden');
      } else {
        hudCallout.classList.add('hidden');
      }
    }
  };

  requestAnimationFrame(frame);
}

void bootstrap();
