export class CliError extends Error {
  public readonly exitCode: number;
  public readonly hint?: string;
  public readonly code?: string;

  constructor(message: string, exitCode: number, hint?: string, code?: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
    this.code = code;
  }
}

export class ConfigError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, 1, hint, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export function exitCodeFromStatus(status: number): number {
  if (status >= 200 && status < 300) return 0;
  if (status >= 400 && status < 500) return 1;
  return 2;
}
