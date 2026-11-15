/**
 * WebGL capability probe.
 *
 * This lives apart from the renderer on purpose. It is the one function that
 * decides whether *any* 3D should mount, so it has to be callable from a route's
 * first-load module graph without dragging three.js in with it. It previously
 * lived in components/charts/3d/canvas.tsx, and tier.ts importing it from there
 * meant every route that probes its scene tier — which is every route, since
 * the tier gate is honest by design — pulled the WebGL runtime into its first
 * load. A probe cannot afford to be heavy: it has to be able to answer "no"
 * without having loaded the thing it is rejecting.
 */
export function supportsWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return false;
    // Release the probe context immediately.
    const lose = gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}
