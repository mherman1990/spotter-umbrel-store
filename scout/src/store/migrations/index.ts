import type { Migration } from '../migrate.js';
import { m0001 } from './0001_initial.js';

/**
 * Every migration, in order. APPEND ONLY. Wave-1 agents must NOT add migrations: schema needs go through the
 * orchestrator so numbering never conflicts (docs/ARCHITECTURE.md, "Ground rules for wave 1").
 */
export const MIGRATIONS: readonly Migration[] = [m0001];
