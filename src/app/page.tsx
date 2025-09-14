// app/page.tsx (or src/app/page.tsx)
"use client";

import Globe from "@/components/Globe";

export default function Page() {
  return (
    <main
      className="w-screen h-screen overflow-hidden"
      style={{ background: "black" }}
      onContextMenu={(e) => e.preventDefault()} // keep right-drag clean
    >
      <Globe />
    </main>
  );
}
