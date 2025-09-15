// src/components/GlobeScene.tsx
"use client";

import * as THREE from "three";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { ArcballControls, useProgress } from "@react-three/drei";
import { TextureLoader } from "three";
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import LoaderOverlay from "./LoaderOverlay";
import { motion, AnimatePresence } from "framer-motion";

/* ===== GLOBE CONFIG ===== */
const SUN_W = new THREE.Vector3(-0.7, 0.7, 0.75).normalize();
let TEXTURE_LON0_DEG = 0;
const TIME_SCALE = 1;
const AMBIENT = 0.1;
const AXIAL_TILT_DEG = 0;

/* ---- CLOUD SPEED CONTROLS ---- */
const CLOUD_ROTATION_PERIOD_HOURS = 12;
const CLOUD_SPEED_MULTIPLIER = 36;
const OMEGA_CLOUD = (2 * Math.PI) / (CLOUD_ROTATION_PERIOD_HOURS * 3600);

/* ---- CAMERA / ZOOM LIMITS ---- */
const EARTH_OUTER_RADIUS = 1.525;
const CAMERA_FOV_DEG = 55;
const MIN_DIST_FILL =
    (EARTH_OUTER_RADIUS /
        Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2))) *
    0.75;
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
  uniform float uGain;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vec3 dayCol=texture2D(uDay,vUv).rgb, nightCol=texture2D(uNight,vUv).rgb;
    float k=dot(normalize(vNormalW),normalize(uSunDir));
    float dayAmt=smoothstep(-0.15,0.15,k), nightAmt=1.0-dayAmt;
    vec3 color = dayCol*(uAmbient+dayAmt*(1.0-uAmbient)) + nightCol*(nightAmt*0.9);
    gl_FragColor = vec4(color, uGain);
  }
`;

/* ===== SOLAR GEOMETRY ===== */
const DEG = Math.PI / 180;
const jd = (d: Date) => d.getTime() / 86400000 + 2440587.5;
const T = (J: number) => (J - 2451545.0) / 36525.0;
const n2 = (a: number) => {
    a %= 2 * Math.PI;
    return a < 0 ? a + 2 * Math.PI : a;
};
function solarRAdecAndGMST(d: Date) {
    const J = jd(d),
        t = T(J);
    const L0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t),
        Mr = M * DEG;
    const Omega = 125.04 - 1934.136 * t;
    const C =
        (1.914602 - t * (0.004817 + 0.000014 * t)) * Math.sin(Mr) +
        (0.019993 - 0.000101 * t) * Math.sin(2.0 * Mr) +
        0.000289 * Math.sin(3.0 * Mr);
    const trueLong = L0 + C;
    const lambdaApp = trueLong - 0.00569 - 0.00478 * Math.sin(Omega * DEG);
    const eps0 =
        23 +
        26 / 60 +
        21.448 / 3600 -
        (46.815 * t + 0.00059 * t * t - 0.001813 * t * t * t) / 3600;
    const eps = eps0 + 0.00256 * Math.cos(Omega * DEG);
    const lam = lambdaApp * DEG,
        epsR = eps * DEG;
    const dec = Math.asin(Math.sin(epsR) * Math.sin(lam));
    let ra = Math.atan2(Math.cos(epsR) * Math.sin(lam), Math.cos(lam));
    ra = n2(ra);
    const GMSTdeg =
        (280.46061837 +
            360.98564736629 * (J - 2451545.0) +
            0.000387933 * t * t -
            t * t * t / 38710000) %
        360;
    const GMST = n2(GMSTdeg * DEG);
    return { ra, dec, GMST };
}
function sunVec_EarthFixed(d: Date) {
    const { ra, dec, GMST } = solarRAdecAndGMST(d);
    const Hg = n2(GMST - ra),
        cosd = Math.cos(dec);
    return new THREE.Vector3(
        cosd * Math.cos(Hg),
        Math.sin(dec),
        cosd * Math.sin(Hg)
    ).normalize();
}

/* ===== Helpers ===== */
const DELHI = { lat: 28.6139, lon: 77.2088 };
const GLOBE_RADIUS = 1.5;
const MARKER_HEIGHT = 0.017;

/* ✅ Accurate lat/lon conversion */
function latLonToVec3(latDeg: number, lonDeg: number, r: number) {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = -THREE.MathUtils.degToRad(lonDeg); // negate for east-positive
    const x = r * Math.cos(lat) * Math.cos(lon);
    const y = r * Math.sin(lat);
    const z = r * Math.cos(lat) * Math.sin(lon);
    return new THREE.Vector3(x, y, z);
}

/* ===== Glow Marker ===== */
let _radialTex: THREE.Texture | null = null;
function radialGlowTex() {
    if (_radialTex) return _radialTex;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.25, "rgba(255,255,255,0.6)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    _radialTex = new THREE.CanvasTexture(c);
    return _radialTex;
}
function GlowMarker({
    position,
    onClick,
    color = "#00ff88",
}: {
    position: THREE.Vector3;
    onClick: () => void;
    color?: string;
}) {
    const group = useRef<THREE.Group>(null);
    useFrame(({ clock }) => {
        const t = clock.getElapsedTime();
        const s = 1 + 0.25 * Math.sin(t * 4);
        group.current?.scale.setScalar(s);
    });
    const setCursor = (v: string) => (document.body.style.cursor = v);
    return (
        <group ref={group} position={position}>
            <mesh
                onClick={onClick}
                onPointerOver={() => setCursor("pointer")}
                onPointerOut={() => setCursor("auto")}
            >
                <sphereGeometry args={[0.015, 16, 16]} />
                <meshBasicMaterial color={color} />
            </mesh>
            <sprite
                scale={[0.22, 0.22, 0.22]}
                onClick={onClick}
                onPointerOver={() => setCursor("pointer")}
                onPointerOut={() => setCursor("auto")}
            >
                <spriteMaterial
                    map={radialGlowTex()}
                    transparent
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    opacity={0.9}
                    color={color}
                />
            </sprite>
        </group>
    );
}

/* ===== SKY DOME ===== */
function SkyDome({
    src = "/textures/space/space_around.webp",
    radius = 800,
    opacity = 0.24,
}: {
    src?: string;
    radius?: number;
    opacity?: number;
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
            matRef.current.opacity = THREE.MathUtils.lerp(
                matRef.current.opacity,
                opacity * eased,
                0.2
            );
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
                opacity={0}
                depthWrite={false}
            />
        </mesh>
    );
}

/* ===== Earth System ===== */
function EarthSystem({
    children,
    planetRef,
}: {
    children?: React.ReactNode;
    planetRef?: React.RefObject<THREE.Group | null>;
}) {
    const day = useLoader(TextureLoader, "/textures/earth/earth_day.jpg");
    const night = useLoader(TextureLoader, "/textures/earth/earth_night.jpg");
    const clouds = useLoader(TextureLoader, "/textures/earth/earth_clouds.jpg");

    const baseRef = useRef<THREE.Group | null>(null);
    const geomRef = useRef<THREE.Group | null>(null);
    const cloudsRef = useRef<THREE.Mesh | null>(null);

    useEffect(() => {
        if (planetRef && geomRef.current) planetRef.current = geomRef.current;
    }, [planetRef]);

    const uniforms = useMemo(
        () => ({
            uDay: { value: day },
            uNight: { value: night },
            uSunDir: { value: SUN_W.clone() },
            uAmbient: { value: AMBIENT },
            uGain: { value: 0.0 },
        }),
        [day, night]
    );

    useEffect(() => {
        if (!geomRef.current) return;
        geomRef.current.rotation.y = THREE.MathUtils.degToRad(TEXTURE_LON0_DEG);
        geomRef.current.rotation.z = THREE.MathUtils.degToRad(AXIAL_TILT_DEG);
    }, []);

    const introT = useRef(0);
    const t0Real = useRef(Date.now());
    const t0Sim = useRef(Date.now());

    useFrame((_, dt) => {
        const base = baseRef.current;
        if (!base) return;

        const sim = new Date(
            t0Sim.current + (Date.now() - t0Real.current) * TIME_SCALE
        );
        const s_e = sunVec_EarthFixed(sim);
        const q = new THREE.Quaternion().setFromUnitVectors(s_e, SUN_W);
        base.quaternion.copy(q);

        const cm = cloudsRef.current;
        if (cm) cm.rotation.y += OMEGA_CLOUD * dt * CLOUD_SPEED_MULTIPLIER;

        const DURATION = 1.0;
        introT.current = Math.min(introT.current + dt, DURATION);
        const t = introT.current / DURATION;
        const eased = 1.0 - Math.pow(1.0 - t, 3.0);
        uniforms.uGain.value = eased;
    });

    return (
        <group ref={baseRef}>
            <group ref={geomRef}>
                <mesh>
                    <sphereGeometry args={[GLOBE_RADIUS, 96, 96]} />
                    <shaderMaterial
                        vertexShader={earthVS}
                        fragmentShader={earthFS}
                        uniforms={uniforms}
                        transparent
                    />
                </mesh>

                <mesh ref={cloudsRef}>
                    <sphereGeometry args={[1.515, 96, 96]} />
                    <meshPhongMaterial
                        alphaMap={clouds}
                        color="white"
                        transparent
                        depthWrite={false}
                        opacity={0.75}
                    />
                </mesh>

                <mesh>
                    <sphereGeometry args={[EARTH_OUTER_RADIUS, 96, 96]} />
                    <meshBasicMaterial
                        color="#3a9fff"
                        side={THREE.BackSide}
                        transparent
                        opacity={0.2}
                    />
                </mesh>

                {children}
            </group>
        </group>
    );
}

/* ===== Camera Pilot ===== */
function CameraPilot({
    targetPoint,
    onArrive,
    controlsRef,
}: {
    targetPoint: THREE.Vector3 | null;
    onArrive: () => void;
    controlsRef: React.RefObject<any>;
}) {
    const { camera } = useThree();
    const startPos = useRef<THREE.Vector3 | null>(null);
    const endPos = useRef<THREE.Vector3 | null>(null);
    const lookAt = useRef<THREE.Vector3 | null>(null);
    const t0 = useRef<number>(0);
    const duration = useRef<number>(1.2);
    const flying = useRef(false);
    const faded = useRef(false);

    useEffect(() => {
        if (!targetPoint) return;
        if (controlsRef.current) controlsRef.current.enabled = false;

        const n = targetPoint.clone().normalize();
        endPos.current = n.multiplyScalar(GLOBE_RADIUS + 0.09);
        lookAt.current = targetPoint.clone();

        startPos.current = camera.position.clone();
        const d = startPos.current.distanceTo(endPos.current);
        duration.current = THREE.MathUtils.clamp(0.7 + d * 0.35, 1.0, 3.0);

        t0.current = performance.now();
        flying.current = true;
        faded.current = false;
    }, [targetPoint, camera]);

    useFrame(() => {
        if (!flying.current || !startPos.current || !endPos.current || !lookAt.current) return;

        const t = (performance.now() - t0.current) / (duration.current * 1000);
        const e = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

        const pos = new THREE.Vector3().lerpVectors(startPos.current, endPos.current, e);
        camera.position.copy(pos);
        camera.lookAt(lookAt.current);

        const ctrls = controlsRef.current;
        if (ctrls?.setLookAt) {
            const c = camera.position;
            const target = lookAt.current;
            ctrls.setLookAt(c.x, c.y, c.z, target.x, target.y, target.z, false);
        }

        const dist = camera.position.distanceTo(endPos.current!);
        if (!faded.current && dist < 0.65) {
            faded.current = true;
            onArrive();
        }

        if (e >= 1) {
            flying.current = false;
        }
    });

    return null;
}

/* ===== Scene ===== */
export default function GlobeScene() {
    const { active } = useProgress();
    const [ready, setReady] = useState(false);
    useEffect(() => {
        if (!active) {
            const id = requestAnimationFrame(() => setReady(true));
            return () => cancelAnimationFrame(id);
        } else setReady(false);
    }, [active]);

    const [markerVec, setMarkerVec] = useState<THREE.Vector3>(() =>
        latLonToVec3(DELHI.lat, DELHI.lon, GLOBE_RADIUS + MARKER_HEIGHT)
    );

    const planetRef = useRef<THREE.Group | null>(null);
    const controlsRef = useRef<any>(null);

    const [fadeStage, setFadeStage] = useState<"hidden" | "fadeIn" | "black">("hidden");

    // useEffect(() => {
    //     if (!("geolocation" in navigator)) return;
    //     navigator.geolocation.getCurrentPosition(
    //         (pos) => {
    //             const { latitude, longitude } = pos.coords;
    //             setMarkerVec(latLonToVec3(latitude, longitude, GLOBE_RADIUS + MARKER_HEIGHT));
    //         },
    //         () => { },
    //         { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    //     );
    // }, []);

    // Geolocation: try GPS first, fallback to IP if denied
    useEffect(() => {
        if (!("geolocation" in navigator)) {
            // fallback directly if geolocation API not available
            fetch("https://ipapi.co/json/")
                .then((res) => res.json())
                .then((data) => {
                    if (data && data.latitude && data.longitude) {
                        setMarkerVec(latLonToVec3(data.latitude, data.longitude, GLOBE_RADIUS + MARKER_HEIGHT));
                    }
                })
                .catch(() => {
                    // fallback stays on Delhi
                });
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                setMarkerVec(latLonToVec3(latitude, longitude, GLOBE_RADIUS + MARKER_HEIGHT));
            },
            () => {
                // user denied → fallback to IP-based lookup
                fetch("https://ipapi.co/json/")
                    .then((res) => res.json())
                    .then((data) => {
                        if (data && data.latitude && data.longitude) {
                            setMarkerVec(latLonToVec3(data.latitude, data.longitude, GLOBE_RADIUS + MARKER_HEIGHT));
                        }
                    })
                    .catch(() => {
                        // fallback stays on Delhi
                    });
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    }, []);


    const [flyTarget, setFlyTarget] = useState<THREE.Vector3 | null>(null);
    const onMarkerClick = () => {
        const surfaceLocal = markerVec.clone().setLength(GLOBE_RADIUS);
        const surfaceWorld = surfaceLocal.clone();
        planetRef.current?.localToWorld(surfaceWorld);
        setFlyTarget(surfaceWorld);
    };

    return (
        <div
            className="relative w-full h-full"
            onContextMenu={(e) => e.preventDefault()}
            style={{ width: "100%", height: "100%" }}
        >
            <AnimatePresence initial={false}>
                {fadeStage !== "hidden" && (
                    <motion.div
                        key="fade"
                        className="pointer-events-none absolute inset-0 bg-black z-20"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.8, ease: "easeInOut" }}
                        onAnimationComplete={() => setFadeStage("black")}
                    />
                )}
            </AnimatePresence>

            <div
                style={{
                    width: "100%",
                    height: "100%",
                    opacity: ready ? 1 : 0,
                    transition: "opacity 1200ms cubic-bezier(.22,.61,.36,1)",
                }}
            >
                <Canvas camera={{ position: [0, 0, 4.2], fov: CAMERA_FOV_DEG }} style={{ background: "#06070B" }}>
                    <color attach="background" args={["#06070B"]} />

                    <Suspense fallback={null}>
                        <SkyDome src="/textures/space/space_around.webp" opacity={0.24} radius={800} />
                    </Suspense>

                    <directionalLight
                        position={[SUN_W.x * 10, SUN_W.y * 10, SUN_W.z * 10]}
                        intensity={1.05}
                    />
                    <ambientLight intensity={0.18} />

                    <Suspense fallback={null}>
                        <EarthSystem planetRef={planetRef}>
                            <GlowMarker position={markerVec} onClick={onMarkerClick} />
                        </EarthSystem>
                    </Suspense>

                    <CameraPilot
                        targetPoint={flyTarget}
                        onArrive={() => setFadeStage("fadeIn")}
                        controlsRef={controlsRef}
                    />

                    <ArcballControls
                        ref={controlsRef}
                        makeDefault
                        enablePan={false}
                        enableZoom
                        enableAnimations
                        dampingFactor={0.35}
                        minDistance={MIN_DIST_FILL}
                        maxDistance={MAX_DIST_NICE}
                    />
                </Canvas>
            </div>

            <LoaderOverlay />
        </div>
    );
}
