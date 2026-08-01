import { describe, expect, it } from 'vitest';
import { AuthAvailabilityMonitor } from './auth-availability.monitor';

describe('AuthAvailabilityMonitor', () => {
  it('raises a local read-only alert above one percent in the five-minute window', () => {
    const monitor = new AuthAvailabilityMonitor();
    for (let index = 0; index < 99; index += 1) monitor.recordAvailable(1_000 + index);
    monitor.recordUnavailable(2_000);
    expect(monitor.getSnapshot(2_000)).toMatchObject({
      alert: false,
      unavailableRate: 0.01
    });
    monitor.recordUnavailable(2_001);
    expect(monitor.getSnapshot(2_001).status).toBe('degraded');
  });

  it('raises an alert after three consecutive unavailable checks', () => {
    const monitor = new AuthAvailabilityMonitor();
    monitor.recordUnavailable(1_000);
    monitor.recordUnavailable(1_001);
    monitor.recordUnavailable(1_002);
    expect(monitor.getSnapshot(1_002)).toMatchObject({
      alert: true,
      consecutiveUnavailable: 3
    });
  });

  it('drops expired samples and resets the consecutive counter after recovery', () => {
    const monitor = new AuthAvailabilityMonitor();
    monitor.recordUnavailable(1_000);
    monitor.recordAvailable(400_000);
    expect(monitor.getSnapshot(400_000)).toMatchObject({
      alert: false,
      consecutiveUnavailable: 0,
      totalChecks: 1,
      unavailableChecks: 0
    });
  });
});
