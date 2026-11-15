"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

/**
 * A vertical gradient sky, drawn once into a 2×256 canvas and wrapped round the
 * back of the scene on a large inverted sphere.
 *
 * It exists because an environment map lights materials but is not a *backdrop*:
 * `scene.environment` is a reflection probe, so without this the camera sees the
 * page behind the canvas and a large scene reads as objects floating in a
 * document rather than standing in a room. One draw call, no shader, no
 * external asset, and the same pixels every time.
 */
export type BackdropVariant = "sky" | "horizon";

/**
 * Stops are chosen against the app's two themes and the fog colour in
 * scene-canvas.tsx, so the horizon dissolves into the fog instead of banding
 * against it. `sky` is for wide overhead cameras (the hero), `horizon` is
 * tighter and lower-contrast for a small scene read through a card.
 */
const STOPS: Record<BackdropVariant, { dark: string[]; light: string[] }> = {
  sky: {
    dark: ["#05080c", "#0b1016", "#12222a", "#1d3a3f"],
    light: ["#8ea9c4", "#b8c9dc", "#dfe6ee", "#f4f7fa"],
  },
  horizon: {
    dark: ["#0b1016", "#101a22", "#16242c", "#1d3038"],
    light: ["#d5dee8", "#e4eaf1", "#eef1f6", "#f7f9fb"],
  },
};

function gradientTexture(dark: boolean, variant: BackdropVariant): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const stops = dark ? STOPS[variant].dark : STOPS[variant].light;
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    stops.forEach((colour, i) => {
      gradient.addColorStop(i / (stops.length - 1), colour);
    });
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  // The gradient runs bottom-to-top in texture space, so flip it to match the
  // sphere's UVs, keep it in sRGB (it is a colour, not data), and let mipmaps
  // handle the sphere's minification.
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function GradientBackdrop({ variant = "sky", radius = 90 }: { variant?: BackdropVariant; radius?: number }) {
  const dark = useMemo(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    [],
  );
  const texture = useMemo(() => gradientTexture(dark, variant), [dark, variant]);

  // The texture is ours; the mesh geometry is not. Only the texture is disposed
  // on unmount or a theme flip, or every theme switch would leak a 2×256 upload.
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh scale={[-1, 1, 1]} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[radius, 32, 16]} />
      <meshBasicMaterial map={texture} side={THREE.FrontSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
