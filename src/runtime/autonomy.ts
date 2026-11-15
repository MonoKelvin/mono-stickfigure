export type AutonomousPose = 'wave' | 'rest' | 'crouch' | 'prone';

/** Newest entries are last; history is bounded by the caller. */
export function recentPenalty<T>(history: readonly T[], value: T): number {
  return 1 + history.reduce((penalty, item, index) => penalty + (item === value ? (index + 1) / history.length * 3 : 0), 0);
}

/** null means physical travel. Never manufacture a position or a platform. */
export function chooseAutonomousPose(random: number, recent: readonly AutonomousPose[], stagnant: number, canProne: boolean): AutonomousPose | null {
  // Repeated stationary decisions monotonically reduce poses, then require travel.
  if (stagnant >= 3) return null;
  const candidates: readonly [AutonomousPose, number][] = [['wave', 0.06], ['rest', 0.03], ['crouch', 0.02], ['prone', canProne ? 0.01 : 0]];
  let remaining = random;
  for (const [pose, base] of candidates) {
    remaining -= base / ((1 + stagnant) * recentPenalty(recent, pose));
    if (remaining < 0) return pose;
  }
  return null;
}
