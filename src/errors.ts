export class BridgeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

export function failure(error: unknown): { ok: false; error: { code: string; message: string } } {
  if (error instanceof BridgeError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: 'INTERNAL', message: 'Unexpected bridge error.' } };
}
