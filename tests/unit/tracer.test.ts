import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track Tracer constructor calls
const tracerConstructorCalls: Array<{ serviceName: string }> = [];

// Mock Tracer before any handler imports
vi.mock('@aws-lambda-powertools/tracer', () => {
  class MockTracer {
    constructor(opts: { serviceName: string }) {
      tracerConstructorCalls.push(opts);
    }
    getSegment = vi.fn().mockReturnValue(undefined);
    setSegment = vi.fn();
    annotateColdStart = vi.fn();
    addServiceNameAnnotation = vi.fn();
    addResponseAsMetadata = vi.fn();
    addErrorAsMetadata = vi.fn();
  }
  return { Tracer: MockTracer };
});

// Mock Logger to prevent initialization side effects
vi.mock('@aws-lambda-powertools/logger', () => {
  class MockLogger {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
  }
  return { Logger: MockLogger };
});

describe('Powertools Tracer instrumentation', () => {
  beforeEach(() => {
    tracerConstructorCalls.length = 0;
    vi.resetModules();
  });

  it('filesystem handler creates Tracer with serviceName vcs-filesystem', async () => {
    tracerConstructorCalls.length = 0;
    await import('../../src/lambdas/filesystem/handler');
    const match = tracerConstructorCalls.find(c => c.serviceName === 'vcs-filesystem');
    expect(match).toBeDefined();
  });

  it('ingestion handler creates Tracer with serviceName vcs-ingestion', async () => {
    tracerConstructorCalls.length = 0;
    await import('../../src/lambdas/ingestion/handler');
    const match = tracerConstructorCalls.find(c => c.serviceName === 'vcs-ingestion');
    expect(match).toBeDefined();
  });

  it('parent-summariser handler creates Tracer with serviceName vcs-parent-summariser', async () => {
    tracerConstructorCalls.length = 0;
    await import('../../src/lambdas/parent-summariser/handler');
    const match = tracerConstructorCalls.find(c => c.serviceName === 'vcs-parent-summariser');
    expect(match).toBeDefined();
  });

  it('query handler creates Tracer with serviceName vcs-query', async () => {
    tracerConstructorCalls.length = 0;
    await import('../../src/lambdas/query/handler');
    const match = tracerConstructorCalls.find(c => c.serviceName === 'vcs-query');
    expect(match).toBeDefined();
  });

  it('session handler creates Tracer with serviceName vcs-session', async () => {
    tracerConstructorCalls.length = 0;
    await import('../../src/lambdas/session/handler');
    const match = tracerConstructorCalls.find(c => c.serviceName === 'vcs-session');
    expect(match).toBeDefined();
  });
});
