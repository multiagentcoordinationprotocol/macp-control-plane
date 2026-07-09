import { NotFoundException } from '@nestjs/common';
import { RuntimeProviderRegistry } from './runtime-provider.registry';
import { RuntimeCapabilities, RuntimeProvider } from '../contracts/runtime';
import { RustRuntimeProvider } from './rust-runtime.provider';

describe('RuntimeProviderRegistry', () => {
  let registry: RuntimeProviderRegistry;
  let mockRustProvider: { kind: string };

  beforeEach(() => {
    mockRustProvider = { kind: 'rust' };
    registry = new RuntimeProviderRegistry(mockRustProvider as unknown as RustRuntimeProvider);
  });

  it('registers the rust provider under its kind on construction', () => {
    expect(registry.get('rust')).toBe(mockRustProvider);
    expect(registry.listKinds()).toEqual(['rust']);
  });

  it('get throws NotFoundException for an unregistered kind', () => {
    expect(() => registry.get('unknown')).toThrow(NotFoundException);
    expect(() => registry.get('unknown')).toThrow("runtime provider 'unknown' is not registered");
  });

  it('register adds additional providers keyed by kind', () => {
    const mockProvider = { kind: 'mock' } as unknown as RuntimeProvider;
    registry.register(mockProvider);

    expect(registry.get('mock')).toBe(mockProvider);
    expect(registry.listKinds()).toEqual(['rust', 'mock']);
  });

  it('register overwrites an existing provider of the same kind', () => {
    const replacement = { kind: 'rust' } as unknown as RuntimeProvider;
    registry.register(replacement);

    expect(registry.get('rust')).toBe(replacement);
    expect(registry.listKinds()).toEqual(['rust']);
  });

  it('setCapabilities/getCapabilities round-trips per kind', () => {
    const caps = { supportsReplay: true } as unknown as RuntimeCapabilities;
    registry.setCapabilities('rust', caps);

    expect(registry.getCapabilities('rust')).toBe(caps);
  });

  it('getCapabilities returns undefined for a kind without capabilities', () => {
    expect(registry.getCapabilities('rust')).toBeUndefined();
    expect(registry.getCapabilities('unknown')).toBeUndefined();
  });
});
