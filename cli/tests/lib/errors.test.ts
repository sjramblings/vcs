import { describe, test, expect } from 'bun:test';
import { CliError, ConfigError, exitCodeFromStatus } from '../../src/lib/errors';

describe('exitCodeFromStatus', () => {
  test('returns 0 for 200', () => {
    expect(exitCodeFromStatus(200)).toBe(0);
  });

  test('returns 0 for 201', () => {
    expect(exitCodeFromStatus(201)).toBe(0);
  });

  test('returns 1 for 400', () => {
    expect(exitCodeFromStatus(400)).toBe(1);
  });

  test('returns 1 for 404', () => {
    expect(exitCodeFromStatus(404)).toBe(1);
  });

  test('returns 2 for 500', () => {
    expect(exitCodeFromStatus(500)).toBe(2);
  });

  test('returns 2 for 503', () => {
    expect(exitCodeFromStatus(503)).toBe(2);
  });
});

describe('CliError', () => {
  test('stores message, exitCode, hint, code', () => {
    const err = new CliError('test error', 2, 'try again', 'TEST_CODE');
    expect(err.message).toBe('test error');
    expect(err.exitCode).toBe(2);
    expect(err.hint).toBe('try again');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('CliError');
    expect(err).toBeInstanceOf(Error);
  });

  test('hint and code are optional', () => {
    const err = new CliError('simple error', 1);
    expect(err.hint).toBeUndefined();
    expect(err.code).toBeUndefined();
  });
});

describe('ConfigError', () => {
  test('extends CliError with exitCode 1', () => {
    const err = new ConfigError('config missing', 'run init');
    expect(err).toBeInstanceOf(CliError);
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(1);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.hint).toBe('run init');
    expect(err.name).toBe('ConfigError');
  });
});
