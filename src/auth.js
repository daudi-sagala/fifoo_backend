import { config } from './config.js';
import { GameError } from './lib/errors.js';
import { assertObject, assertString, isUUID } from './lib/validation.js';
import { verifyAccessToken } from './services/authService.js';

async function assertUserExists(client, userID) {
  const { rowCount } = await client.query('SELECT 1 FROM users WHERE user_id=$1', [userID]);
  if (!rowCount) throw new GameError('unauthorized', 'Authenticated user does not exist.');
}

async function verifyExternal(payload) {
  if (!config.authVerifyURL) {
    throw new GameError('server_error', 'AUTH_VERIFY_URL is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.authVerifyTimeoutMs);
  try {
    const response = await fetch(config.authVerifyURL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${payload.authToken}`,
      },
      body: JSON.stringify({ userID: payload.userID, deviceID: payload.deviceID }),
      signal: controller.signal,
    });
    if (!response.ok) throw new GameError('unauthorized', 'Authentication token was rejected.');
    const body = await response.json();
    const userID = String(body.userID ?? body.user_id ?? body.sub ?? '');
    if (!isUUID(userID)) throw new GameError('unauthorized', 'Authentication service returned an invalid user ID.');
    return userID;
  } catch (error) {
    if (error instanceof GameError) throw error;
    if (error?.name === 'AbortError') throw new GameError('unauthorized', 'Authentication verification timed out.');
    throw new GameError('unauthorized', 'Authentication verification failed.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function authenticateGameSocket(client, rawPayload) {
  const payload = assertObject(rawPayload, 'authentication payload');
  assertString(payload.userID, 'userID');
  assertString(payload.authToken, 'authToken');
  assertString(payload.deviceID, 'deviceID');

  let userID;
  if (config.authMode === 'development') {
    // DEBUG can still use the explicit legacy dummy credential, but real
    // signup/login sessions are accepted as well so local auth can be tested
    // without switching environment modes back and forth.
    if (config.allowDummyAuth && payload.authToken === config.dummyAuthToken) {
      if (!isUUID(config.dummyUserID)) {
        throw new GameError('server_error', 'DUMMY_USER_ID must be the UUID of an existing users row.');
      }
      userID = config.dummyUserID;
    } else {
      const session = await verifyAccessToken(client, payload.authToken);
      userID = session.user_id;
    }
  } else if (config.authMode === 'internal') {
    const session = await verifyAccessToken(client, payload.authToken);
    userID = session.user_id;
  } else if (config.authMode === 'external') {
    userID = await verifyExternal(payload);
  } else {
    throw new GameError('server_error', `Unsupported AUTH_MODE: ${config.authMode}`);
  }

  if (payload.userID && isUUID(payload.userID) && payload.userID !== userID) {
    throw new GameError('unauthorized', 'Authentication token does not belong to the requested user.');
  }

  await assertUserExists(client, userID);
  return { userID, deviceID: payload.deviceID };
}
