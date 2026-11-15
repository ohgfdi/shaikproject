/**
 * Detects whether the current process is `next build` rather than a server.
 *
 * Next.js compiles and prerenders with `NODE_ENV=production` and imports every
 * server module to collect page data, so boot-time production gates would fire
 * on a build host that serves nothing — a CI machine, the Docker builder stage
 * (which carries no production secrets at all), or a developer's laptop.
 *
 * Those gates belong to a *running* server. Next.js marks the phase in
 * `NEXT_PHASE`, which the build passes to its workers: `phase-production-build`
 * during `next build`, `phase-production-server` under `next start`.
 */
export function isNextBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}
