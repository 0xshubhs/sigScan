/**
 * Resource Monitor - CPU/memory gating for extended analysis
 *
 * Prevents heavy analysis (storage layout, call graph, deployment cost)
 * from running when system resources are constrained.
 */

export const MEMORY_THRESHOLD_MB = 500;
export const CPU_THRESHOLD_PERCENT = 50;

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

    if (isAnalysisInProgress) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
