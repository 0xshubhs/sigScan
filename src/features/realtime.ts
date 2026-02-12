/**
 * Real-time Analysis - Backward-compatible facade
 *
 * This module re-exports everything from analysis-engine.ts and
 * decoration-manager.ts so existing imports continue to work.
 *
 * New code should import directly from:
 * - './analysis-engine' for AnalysisEngine / LiveAnalysis
 * - './decoration-manager' for createGasDecorations, etc.
 */

export {
  AnalysisEngine,
  LiveAnalysis,
  AnalysisReadyEvent,
  RemixCompilationEvent,
} from './analysis-engine';

export {
  createGasDecorations,
  createRemixStyleDecorations,
  createComplexityDecorations,
  createGasInlayHints,
  createHoverInfo,
  getGasGradientColor,
  getComplexityColor,
} from './decoration-manager';

// Backward-compatible alias: old code imports RealtimeAnalyzer from './realtime'
import { AnalysisEngine } from './analysis-engine';
export { AnalysisEngine as RealtimeAnalyzer };
