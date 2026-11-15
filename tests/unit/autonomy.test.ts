import { describe, expect, it } from 'vitest';
import { chooseAutonomousPose, recentPenalty } from '../../src/runtime/autonomy';

describe('自主行为近期记忆', () => {
  it('相同动作与表面越近期，选择惩罚越高', () => {
    expect(recentPenalty([], 'a')).toBe(1);
    expect(recentPenalty(['a', 'b'], 'a')).toBeLessThan(recentPenalty(['b', 'a'], 'a'));
    expect(recentPenalty(['a', 'a'], 'a')).toBeGreaterThan(recentPenalty(['b', 'a'], 'a'));
  });

  it('近期动作减少重复，其他静止动作仍可选择', () => {
    expect(chooseAutonomousPose(0.04, [], 0, true)).toBe('wave');
    expect(chooseAutonomousPose(0.04, ['wave'], 0, true)).toBe('rest');
    expect(chooseAutonomousPose(0.119, [], 0, false)).toBeNull();
  });

  it('停滞逐步提高移动概率，三次后保证尝试真实移动', () => {
    const poses = (stagnant: number) => Array.from({ length: 1000 }, (_, i) => chooseAutonomousPose((i + 0.5) / 1000, [], stagnant, true)).filter(Boolean).length;
    expect(poses(0)).toBe(120);
    expect(poses(1)).toBe(60);
    expect(poses(2)).toBe(40);
    expect(poses(3)).toBe(0);
    expect(chooseAutonomousPose(0, [], 3, true)).toBeNull();
  });
});
