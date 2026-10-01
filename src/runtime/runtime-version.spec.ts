import { classifyRuntimeVersion } from './runtime-version';

describe('classifyRuntimeVersion', () => {
  it.each(['0.8.0', '0.8.6', 'v0.8.12', '0.8.6-rc1'])('treats %s as tested', (v) => {
    expect(classifyRuntimeVersion(v)).toBe('tested');
  });

  it.each(['0.7.6', '0.9.0', '1.0.0', '0.5.0'])('treats %s as untested', (v) => {
    expect(classifyRuntimeVersion(v)).toBe('untested');
  });

  it.each([undefined, '', 'latest', 'abc'])('treats %p as unknown', (v) => {
    expect(classifyRuntimeVersion(v as string | undefined)).toBe('unknown');
  });
});
