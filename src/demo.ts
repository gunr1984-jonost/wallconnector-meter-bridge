// A simulated charger, so the whole chain runs before the real one is installed.
// Deterministic: the same day always produces the same session.

import type { Session } from "./types";

const DAY = 86_400_000;
const MIN = 60_000;

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** One evening session on roughly three days out of four, 11 kW charger. */
export function demoSessions(fromMs: number, toMs: number): Session[] {
  const sessions: Session[] = [];
  for (let day = Math.floor(fromMs / DAY) - 1; day <= Math.floor(toMs / DAY); day++) {
    const h = hash(day);
    if (h % 4 === 0) continue; // no charge that day
    const start = day * DAY + 17 * 60 * MIN + ((h >>> 4) % 180) * MIN; // 17:00-20:00 UTC
    const minutes = 60 + ((h >>> 12) % 181); // 1-4 h
    const loadFactor = 0.6 + ((h >>> 20) % 41) / 100; // 0.60-1.00 of 11 kW
    const end = start + minutes * MIN;
    if (start <= fromMs || end > toMs) continue;
    sessions.push({
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
      energy_wh: Math.round((minutes / 60) * 11_000 * loadFactor),
    });
  }
  return sessions;
}
