import { describe, it, expect } from 'vitest';
import { summarizeFeedbackTrend } from '../../src/utils/aiFeedbackDatabase';

describe('summarizeFeedbackTrend', () => {
  it('returns insufficient_data for empty input', () => {
    const r = summarizeFeedbackTrend([]);
    expect(r.direction).toBe('insufficient_data');
    expect(r.peak_negative_day).toBeNull();
    expect(r.peak_negative_count).toBe(0);
    expect(r.total_thumbs_up).toBe(0);
    expect(r.total_thumbs_down).toBe(0);
    expect(r.days_observed).toBe(0);
  });

  it('returns insufficient_data for a single point', () => {
    const r = summarizeFeedbackTrend([
      { day: '2026-04-20', thumbs_up: 5, thumbs_down: 1 },
    ]);
    expect(r.direction).toBe('insufficient_data');
    expect(r.peak_negative_day).toBe('2026-04-20');
    expect(r.peak_negative_count).toBe(1);
  });

  it('detects a worsening trend when down-rate climbs in the second half', () => {
    const r = summarizeFeedbackTrend([
      { day: '2026-04-15', thumbs_up: 9, thumbs_down: 1 },
      { day: '2026-04-16', thumbs_up: 9, thumbs_down: 1 },
      { day: '2026-04-17', thumbs_up: 5, thumbs_down: 5 },
      { day: '2026-04-18', thumbs_up: 3, thumbs_down: 7 },
    ]);
    expect(r.direction).toBe('worsening');
    expect(r.peak_negative_day).toBe('2026-04-18');
    expect(r.peak_negative_count).toBe(7);
    expect(r.second_half_down_rate).toBeGreaterThan(r.first_half_down_rate);
  });

  it('detects an improving trend when down-rate drops in the second half', () => {
    const r = summarizeFeedbackTrend([
      { day: '2026-04-15', thumbs_up: 2, thumbs_down: 8 },
      { day: '2026-04-16', thumbs_up: 3, thumbs_down: 7 },
      { day: '2026-04-17', thumbs_up: 9, thumbs_down: 1 },
      { day: '2026-04-18', thumbs_up: 9, thumbs_down: 1 },
    ]);
    expect(r.direction).toBe('improving');
    expect(r.peak_negative_day).toBe('2026-04-15');
    expect(r.peak_negative_count).toBe(8);
    expect(r.second_half_down_rate).toBeLessThan(r.first_half_down_rate);
  });

  it('treats small swings as stable', () => {
    const r = summarizeFeedbackTrend([
      { day: '2026-04-15', thumbs_up: 10, thumbs_down: 2 },
      { day: '2026-04-16', thumbs_up: 10, thumbs_down: 2 },
      { day: '2026-04-17', thumbs_up: 10, thumbs_down: 2 },
      { day: '2026-04-18', thumbs_up: 10, thumbs_down: 2 },
    ]);
    expect(r.direction).toBe('stable');
    expect(r.peak_negative_count).toBe(2);
  });

  it('reports the worst single day even when rates are stable', () => {
    const r = summarizeFeedbackTrend([
      { day: '2026-04-15', thumbs_up: 8, thumbs_down: 2 },
      { day: '2026-04-16', thumbs_up: 8, thumbs_down: 2 },
      { day: '2026-04-17', thumbs_up: 1, thumbs_down: 9 },
      { day: '2026-04-18', thumbs_up: 8, thumbs_down: 2 },
    ]);
    expect(r.peak_negative_day).toBe('2026-04-17');
    expect(r.peak_negative_count).toBe(9);
  });
});
