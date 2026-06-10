/**
 * Resource Monitor - CPU/memory gating for extended analysis
 *
 * Prevents heavy analysis (storage layout, call graph, deployment cost)
 * from running when system resources are constrained.
 */

export const MEMORY_THRESHOLD_MB = 500;
export const CPU_THRESHOLD_PERCENT = 50;

// CPU sampling state: process.cpuUsage() returns cumulative user+system micros,
// so we measure the delta against the wall-clock elapsed since the last sample.
let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastSampleTime: bigint | null = null;

/**
 * Sample the process CPU usage as a percentage of one core since the previous
 * call. Returns null until a baseline has been established (first call) so the
 * caller can skip CPU gating on the very first sample.
 *
 * Non-blocking: relies on cumulative counters (process.cpuUsage / process.hrtime)
 * rather than busy-waiting over an interval.
 */
function sampleCpuPercent(): number | null {
  const nowUsage = process.cpuUsage();
  const nowTime = process.hrtime.bigint();

  if (lastCpuUsage === null || lastSampleTime === null) {
    lastCpuUsage = nowUsage;
    lastSampleTime = nowTime;
    return null;
  }

  const cpuMicros = nowUsage.user - lastCpuUsage.user + (nowUsage.system - lastCpuUsage.system);
  const elapsedNanos = nowTime - lastSampleTime;

  lastCpuUsage = nowUsage;
  lastSampleTime = nowTime;

  // Need a meaningful window to avoid divide-by-zero / noisy spikes.
  if (elapsedNanos <= 0n) {
    return null;
  }

  const elapsedMicros = Number(elapsedNanos) / 1000;
  if (elapsedMicros <= 0) {
    return null;
  }

  return (cpuMicros / elapsedMicros) * 100;
}

/**
 * Check if system resources are available for extended analysis
 */
export function checkResourcesAvailable(isAnalysisInProgress: boolean): boolean {
  try {
    const memUsage = process.memoryUsage();
    const memUsedMB = memUsage.heapUsed / 1024 / 1024;

    if (memUsedMB > MEMORY_THRESHOLD_MB) {
      return false;
    }

    // Gate on CPU usage of this process since the previous check. Skip when no
    // baseline is available yet (returns null on first sample / tiny windows).
    const cpuPercent = sampleCpuPercent();
    if (cpuPercent !== null && cpuPercent > CPU_THRESHOLD_PERCENT) {
      return false;
    }

    if (isAnalysisInProgress) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
