// src/components/GlobeScene.tsx
"use client";

import * as THREE from "three";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { ArcballControls, useProgress } from "@react-three/drei";
import { TextureLoader } from "three";
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import LoaderOverlay from "./LoaderOverlay";


/* ===== GLOBE CONFIG ===== */
const SUN_W = new THREE.Vector3(-0.7, 0.7, 0.75).normalize();
let TEXTURE_LON0_DEG = 0;
const TIME_SCALE = 1;
const AMBIENT = 0.10;
const AXIAL_TILT_DEG = 0;

/* ---- CLOUD SPEED CONTROLS ---- */
const CLOUD_ROTATION_PERIOD_HOURS = 12;
const CLOUD_SPEED_MULTIPLIER = 36;
const OMEGA_CLOUD =
    (2 * Math.PI) / (CLOUD_ROTATION_PERIOD_HOURS * 3600);

/* ---- CAMERA / ZOOM LIMITS ---- */
const EARTH_OUTER_RADIUS = 1.525;      // atmosphere shell radius in your scene
const CAMERA_FOV_DEG = 55;            // must match the Canvas camera fov
// distance so the sphere exactly fills the view height (with a tiny cushion):
const MIN_DIST_FILL =
    EARTH_OUTER_RADIUS / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2)) * 0.75;
// how far you allow zooming out (tweak to taste; must be << sky dome radius)
const MAX_DIST_NICE = 12;

/* ===== SHADERS ===== */
const earthVS = `
  varying vec2 vUv; varying vec3 vNormalW;
  void main(){ vUv=uv; vNormalW=normalize(mat3(modelMatrix)*normal);
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
`;

const earthFS = `
  uniform sampler2D uDay, uNight;
  uniform vec3 uSunDir;
  uniform float uAmbient;
  uniform float uGain;               // NEW
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vec3 dayCol=texture2D(uDay,vUv).rgb, nightCol=texture2D(uNight,vUv).rgb;
    float k=dot(normalize(vNormalW),normalize(uSunDir));
    float dayAmt=smoothstep(-0.15,0.15,k), nightAmt=1.0-dayAmt;
    vec3 color = dayCol*(uAmbient+dayAmt*(1.0-uAmbient)) + nightCol*(nightAmt*0.9);
    gl_FragColor = vec4(color, uGain); // fade-in
  }
`;


/* ===== SOLAR GEOMETRY (same as before) ===== */
const DEG = Math.PI / 180;
const jd = (d: Date) => d.getTime() / 86400000 + 2440587.5;
const T = (J: number) => (J - 2451545.0) / 36525.0;
const n2 = (a: number) => { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
function solarRAdecAndGMST(d: Date) {
    const J = jd(d), t = T(J);
    const L0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t), Mr = M * DEG;
    const Omega = 125.04 - 1934.136 * t;
    const C = (1.914602 - t * (0.004817 + 0.000014 * t)) * Math.sin(Mr)
        + (0.019993 - 0.000101 * t) * Math.sin(2.0 * Mr)
        + 0.000289 * Math.sin(3.0 * Mr);
    const trueLong = L0 + C;
    const lambdaApp = trueLong - 0.00569 - 0.00478 * Math.sin(Omega * DEG);
    const eps0 = 23 + 26 / 60 + 21.448 / 3600
        - (46.8150 * t + 0.00059 * t * t - 0.001813 * t * t * t) / 3600;
    const eps = eps0 + 0.00256 * Math.cos(Omega * DEG);
    const lam = lambdaApp * DEG, epsR = eps * DEG;
    const dec = Math.asin(Math.sin(epsR) * Math.sin(lam));
    let ra = Math.atan2(Math.cos(epsR) * Math.sin(lam), Math.cos(lam)); ra = n2(ra);
    const GMSTdeg = (280.46061837 + 360.98564736629 * (J - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000) % 360;
    const GMST = n2(GMSTdeg * DEG);
    return { ra, dec, GMST };
}
function sunVec_EarthFixed(d: Date) {
    const { ra, dec, GMST } = solarRAdecAndGMST(d);
    const Hg = n2(GMST - ra), cosd = Math.cos(dec);
    return new THREE.Vector3(cosd * Math.cos(Hg), Math.sin(dec), cosd * Math.sin(Hg)).normalize();
}

/* ===== SKY DOME ===== */
function SkyDome({ src = "/textures/space/space_around.webp", radius = 800, opacity = 0.24 }: {
    src?: string; radius?: number; opacity?: number;
}) {
    const tex = useLoader(TextureLoader, src);
    // @ts-ignore
    tex.colorSpace = THREE.SRGBColorSpace;

    const matRef = useRef<THREE.MeshBasicMaterial>(null!);

    const skyIntroT = useRef(0);

    useFrame((_, dt) => {
        skyIntroT.current = Math.min(skyIntroT.current + dt, 1.0);
        const t = skyIntroT.current / 1.0;
        const eased = 1 - Math.pow(1 - t, 3);
        if (matRef.current) {
            // smoothly go 0 -> desired opacity
            matRef.current.opacity = THREE.MathUtils.lerp(matRef.current.opacity, opacity * eased, 0.2);
        }
    });

    return (
        <mesh>
            <sphereGeometry args={[radius, 64, 64]} />
            <meshBasicMaterial
                ref={matRef as any}
                map={tex}
                side={THREE.BackSide}
                transparent
                opacity={0}             // start at 0, fade to {opacity}
                depthWrite={false}
            />
        </mesh>
    );
}


/* ===== EARTH ===== */
function EarthSystem() {
    const day = useLoader(TextureLoader, "/textures/earth/earth_day.jpg");
    const night = useLoader(TextureLoader, "/textures/earth/earth_night.jpg");
    const clouds = useLoader(TextureLoader, "/textures/earth/earth_clouds.jpg");

    const baseRef = useRef<THREE.Group | null>(null);
    const geomRef = useRef<THREE.Group | null>(null);
    const cloudsRef = useRef<THREE.Mesh | null>(null);

    const uniforms = useMemo(() => ({
        uDay: { value: day },
        uNight: { value: night },
        uSunDir: { value: SUN_W.clone() },
        uAmbient: { value: AMBIENT },
        uGain: { value: 0.0 },        // NEW
    }), [day, night]);

    useEffect(() => {
        if (!geomRef.current) return;
        geomRef.current.rotation.y = THREE.MathUtils.degToRad(TEXTURE_LON0_DEG);
        geomRef.current.rotation.z = THREE.MathUtils.degToRad(AXIAL_TILT_DEG);
    }, []);

    const introT = useRef(0); // seconds since mount
    const t0Real = useRef(Date.now());
    const t0Sim = useRef(Date.now());

    useFrame((_, dt) => {
        const base = baseRef.current; if (!base) return;

        const sim = new Date(t0Sim.current + (Date.now() - t0Real.current) * TIME_SCALE);
        const s_e = sunVec_EarthFixed(sim);
        const q = new THREE.Quaternion().setFromUnitVectors(s_e, SUN_W);
        base.quaternion.copy(q);

        const cm = cloudsRef.current;
        if (cm) cm.rotation.y += OMEGA_CLOUD * dt * CLOUD_SPEED_MULTIPLIER;

        // --- intro fade 0 -> 1 over ~1.0s (cubic ease-out) ---
        const DURATION = 1.0;              // tweak for slower/faster fade
        introT.current = Math.min(introT.current + dt, DURATION);
        const t = introT.current / DURATION;
        const eased = 1.0 - Math.pow(1.0 - t, 3.0);

        uniforms.uGain.value = eased;      // drives earthFS fade
    });

    return (
        <group ref={baseRef}>
            <group ref={geomRef}>
                {/* Earth */}
                <mesh>
                    <sphereGeometry args={[1.5, 96, 96]} />
                    <shaderMaterial
                        vertexShader={earthVS}
                        fragmentShader={earthFS}
                        uniforms={uniforms}
                        transparent
                    />

                </mesh>
                {/* Clouds (rotating shell) */}
                <mesh ref={cloudsRef}>
                    <sphereGeometry args={[1.515, 96, 96]} />
                    <meshPhongMaterial alphaMap={clouds} color="white" transparent depthWrite={false} opacity={0.75} />
                </mesh>
                {/* Atmosphere */}
                <mesh>
                    <sphereGeometry args={[EARTH_OUTER_RADIUS, 96, 96]} />
                    <meshBasicMaterial color="#3a9fff" side={THREE.BackSide} transparent opacity={0.2} />
                </mesh>
            </group>
        </group>
    );
}

/* ===== SCENE ===== */
export default function GlobeScene() {

    const { active } = useProgress();      // true while any useLoader is loading
    const [ready, setReady] = useState(false);

    // when loading finishes, fade the canvas in
    useEffect(() => {
        if (!active) {
            // tiny delay/next frame so the first render is fully ready
            const id = requestAnimationFrame(() => setReady(true));
            return () => cancelAnimationFrame(id);
        } else {
            setReady(false);
        }
    }, [active]);

    return (
        <div
            className="relative w-full h-full"
            onContextMenu={(e) => e.preventDefault()}
            style={{ width: "100%", height: "100%" }}
        >
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    opacity: ready ? 1 : 0,                 // fade 0 -> 1
                    // transition: "opacity 650ms ease",       // tune duration/ease
                    transition: "opacity 1200ms cubic-bezier(.22,.61,.36,1)",
                }}
            >
                <Canvas camera={{ position: [0, 0, 4.2], fov: CAMERA_FOV_DEG }} style={{ background: "#06070B" }}>
                    {/* Background visible while textures load */}
                    <color attach="background" args={["#06070B"]} />

                    <Suspense fallback={null}>
                        <SkyDome src="/textures/space/space_around.webp" opacity={0.24} radius={800} />
                    </Suspense>

                    <directionalLight position={[SUN_W.x * 10, SUN_W.y * 10, SUN_W.z * 10]} intensity={1.05} />
                    <ambientLight intensity={0.18} />

                    <Suspense fallback={null}>
                        <EarthSystem />
                    </Suspense>

                    <ArcballControls
                        makeDefault
                        enablePan={false}
                        enableZoom
                        enableAnimations           // (default true) keep a touch of smoothing
                        dampingFactor={0.35}       // higher = more friction; try 0.2–0.35
                        minDistance={MIN_DIST_FILL}
                        maxDistance={MAX_DIST_NICE}
                    />


                </Canvas>
            </div>
            {/* Overlay sits on top of the Canvas and fades out when loading is done */}
            <LoaderOverlay />
        </div>
    );
}

