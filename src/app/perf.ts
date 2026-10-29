/**
 * Named User Timing measures. Standard Web API, visible in browser dev tools and read by
 * scripts/bench-browser.ts. Detail carries engine-side timings when relevant.
 */
export function measure(name: string, start: number, detail?: Record<string, unknown>): void {
  try {
    performance.measure(name, { start, end: performance.now(), detail });
  } catch {
    // Measures are diagnostics only.
  }
}
