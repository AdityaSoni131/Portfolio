"use client";
import { useProgress } from "@react-three/drei";

export default function LoaderOverlay() {
    const { active, progress } = useProgress();
    return (
        <div
            style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                background: "rgba(6,7,11,0.55)",
                color: "rgba(255,255,255,0.9)",
                fontSize: 14,
                letterSpacing: 1,
                transition: "opacity 1000ms cubic-bezier(.22,.61,.36,1)",
                opacity: active ? 1 : 0,
            }}
        >
            Loading {progress.toFixed(0)}%
        </div>
    );
}
