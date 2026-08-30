export class GameError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.details = details;
  }
}

export function asGameError(error) {
  if (error instanceof GameError) return error;
  console.error(error);
  return new GameError('server_error', 'The server could not complete the request.');
}

export function successAck(requestID = null, revision = null, message = null) {
  return { success: true, requestID, revision, message, errorCode: null };
}

export function failureAck(error, requestID = null, revision = null) {
  const gameError = asGameError(error);
  return {
    success: false,
    requestID,
    revision,
    message: gameError.message,
    errorCode: gameError.code,
  };
}
