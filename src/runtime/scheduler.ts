export class FixedStepClock {
  private previous: number | null = null;
  private accumulator = 0;
  private dropped = 0;

  constructor(private readonly stepSeconds = 1 / 120, private readonly maxSubSteps = 6) {}

  get droppedTimeMs(): number {
    return this.dropped * 1000;
  }

  reset(): void {
    this.previous = null;
    this.accumulator = 0;
  }

  advance(timestampMs: number, step: (dt: number) => void): number {
    if (this.previous === null) {
      this.previous = timestampMs;
      return 0;
    }
    const elapsed = Math.max(0, (timestampMs - this.previous) / 1000);
    this.previous = Math.max(this.previous, timestampMs);
    const allowed = this.stepSeconds * this.maxSubSteps;
    this.dropped += Math.max(0, elapsed - allowed);
    this.accumulator += Math.min(elapsed, allowed);
    let count = 0;
    while (this.accumulator + 1e-10 >= this.stepSeconds && count < this.maxSubSteps) {
      step(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      count++;
    }
    this.accumulator = Math.max(0, this.accumulator);
    return this.accumulator / this.stepSeconds;
  }
}
