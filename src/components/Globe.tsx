// src/components/Globe.tsx
"use client";
import dynamic from "next/dynamic";
const Globe = dynamic(() => import("./GlobeScene"), { ssr: false });
export default Globe;
