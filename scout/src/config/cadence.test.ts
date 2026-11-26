import { describe, expect, it } from 'vitest';
import {
  edgarPollSeconds,
  haltsPollSeconds,
  irPollSeconds,
  optionsPollSeconds,
} from './cadence.js';
import { PollingSchema } from './schema.js';

const polling = PollingSchema.parse({});

describe('poll cadence semantics', () => {
  it('EDGAR: premarket, regular and afterhours use the normal cadence; only `closed` uses off-hours', () => {
    for (const phase of ['premarket', 'regular', 'afterhours'] as const)
      expect(edgarPollSeconds(polling, phase, 'normal')).toBe(120);
    expect(edgarPollSeconds(polling, 'closed', 'normal')).toBe(900);
  });

  it('earnings mode overrides every phase (EDGAR 30 s, IR 30 s)', () => {
    for (const phase of ['premarket', 'regular', 'afterhours', 'closed'] as const) {
      expect(edgarPollSeconds(polling, phase, 'earnings')).toBe(30);
      expect(irPollSeconds(polling, phase, 'earnings')).toBe(30);
    }
  });

  it('IR follows the EDGAR phase rule and never polls faster off-hours than normal', () => {
    expect(irPollSeconds(polling, 'regular', 'normal')).toBe(120);
    expect(irPollSeconds(polling, 'afterhours', 'normal')).toBe(120);
    expect(irPollSeconds(polling, 'closed', 'normal')).toBe(900);
    expect(irPollSeconds({ ...polling, ir_seconds: 2000 }, 'closed', 'normal')).toBe(2000);
    expect(edgarPollSeconds(polling, 'regular', 'backfill')).toBe(120);
  });

  it('halts and options are regular-session only', () => {
    expect(haltsPollSeconds(polling, 'regular')).toBe(30);
    expect(optionsPollSeconds(polling, 'regular')).toBe(1800);
    for (const phase of ['premarket', 'afterhours', 'closed'] as const) {
      expect(haltsPollSeconds(polling, phase)).toBeNull();
      expect(optionsPollSeconds(polling, phase)).toBeNull();
    }
  });
});
