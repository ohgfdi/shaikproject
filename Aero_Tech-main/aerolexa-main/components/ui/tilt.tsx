"use client";

import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import type { ReactNode } from "react";

/**
 * Lightweight 3D tilt wrapper. Rotates its content in response to the pointer
 * using imperative style updates (no React re-renders), respects
 * `prefers-reduced-motion`, and disables itself on touch devices.
 */
export function Tilt({
  children,
  max = 8,
  scale = 1.02,
  className,
  style,
  glare = true,
}: {
  children: ReactNode;
  /** Max rotation in degrees. */
  max?: number;
  scale?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Add a soft specular sheen that follows the cursor. */
  glare?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el || e.pointerType !== "mouse" || reduced.current) return;
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      const rx = -py * max;
      const ry = px * max;
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        el.style.transform = `perspective(1200px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale3d(${scale},${scale},${scale})`;
        if (glowRef.current) {
          glowRef.current.style.opacity = "1";
          glowRef.current.style.background = `radial-gradient(circle at ${((px + 0.5) * 100).toFixed(1)}% ${((py + 0.5) * 100).toFixed(1)}%, rgba(255,255,255,0.18), transparent 55%)`;
        }
      });
    },
    [max, scale],
  );

  const onPointerLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      el.style.transform = "";
      if (glowRef.current) glowRef.current.style.opacity = "0";
    });
  }, []);

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={className}
      style={{
        transformStyle: "preserve-3d",
        willChange: "transform",
        transition: "transform 0.2s ease-out",
        ...style,
      }}
    >
      {children}
      {glare && (
        <div
          ref={glowRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] opacity-0 transition-opacity duration-300"
        />
      )}
    </div>
  );
}
