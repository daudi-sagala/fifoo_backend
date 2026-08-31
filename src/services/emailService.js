import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let cachedClient = null;

async function azureEmailClient() {
  if (cachedClient) return cachedClient;
  const { EmailClient } = await import('@azure/communication-email');

  if (config.azureCommunicationEmailConnectionString) {
    cachedClient = new EmailClient(config.azureCommunicationEmailConnectionString);
    return cachedClient;
  }

  const { DefaultAzureCredential } = await import('@azure/identity');
  cachedClient = new EmailClient(
    config.azureCommunicationEmailEndpoint,
    new DefaultAzureCredential(),
  );
  return cachedClient;
}

function resetURL(token) {
  const separator = config.passwordResetURLBase.includes('?') ? '&' : '?';
  return `${config.passwordResetURLBase}${separator}token=${encodeURIComponent(token)}`;
}

function resetEmail(reset) {
  const url = resetURL(reset.token);
  const expiryMinutes = config.passwordResetTTLMinutes;
  const subject = 'Reset your Fifoo password';
  const plainText = [
    'A password reset was requested for your Fifoo account.',
    '',
    `Open this link to choose a new password: ${url}`,
    '',
    `This link expires in ${expiryMinutes} minutes.`,
    'If you did not request this reset, you can ignore this email.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;color:#172033"><h2>Reset your Fifoo password</h2><p>A password reset was requested for your Fifoo account.</p><p><a href="${url}">Choose a new password</a></p><p>This link expires in ${expiryMinutes} minutes.</p><p>If you did not request this reset, you can ignore this email.</p></body></html>`;
  return { url, subject, plainText, html };
}

async function sendAzure(reset) {
  const client = await azureEmailClient();
  const content = resetEmail(reset);
  const poller = await client.beginSend({
    senderAddress: config.emailSenderAddress,
    content: {
      subject: content.subject,
      plainText: content.plainText,
      html: content.html,
    },
    recipients: {
      to: [{ address: reset.email }],
    },
    replyTo: config.emailReplyToAddress
      ? [{ address: config.emailReplyToAddress }]
      : undefined,
  });
  const result = await poller.pollUntilDone();
  const status = String(result?.status ?? '').toLowerCase();
  if (status && status !== 'succeeded') {
    throw new Error(`Azure Communication Services email status: ${status}`);
  }
  return { provider: 'azure-communication-services', messageID: result?.id ?? null };
}

async function sendWebhook(reset) {
  if (!config.passwordResetDeliveryURL) throw new Error('PASSWORD_RESET_DELIVERY_URL is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.outboundHTTPTimeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (config.passwordResetDeliverySecret) headers.authorization = `Bearer ${config.passwordResetDeliverySecret}`;
    const response = await fetch(config.passwordResetDeliveryURL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: reset.email,
        token: reset.token,
        expiresAt: reset.expiresAt,
        resetURL: resetURL(reset.token),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`delivery returned ${response.status}`);
    return { provider: 'webhook', messageID: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendPasswordResetEmail(reset) {
  if (!reset) return false;
  try {
    let delivery;
    if (config.emailProvider === 'azure-communication-services') delivery = await sendAzure(reset);
    else if (config.emailProvider === 'webhook') delivery = await sendWebhook(reset);
    else if (config.emailProvider === 'console' && config.nodeEnv !== 'production') {
      logger.info('development password reset email', { email: reset.email, resetURL: resetURL(reset.token) });
      return true;
    } else {
      throw new Error(`Unsupported EMAIL_PROVIDER: ${config.emailProvider}`);
    }

    logger.info('password reset email sent', {
      provider: delivery.provider,
      messageID: delivery.messageID,
      userID: reset.userID,
    });
    return true;
  } catch (error) {
    logger.error('password reset email delivery failed', {
      userID: reset.userID,
      provider: config.emailProvider,
      error,
    });
    return false;
  }
}
