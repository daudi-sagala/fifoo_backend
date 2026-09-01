import { config } from './config.js';

export async function startObservability() {
  if (!config.applicationInsightsConnectionString) return false;

  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = config.applicationInsightsConnectionString;
  try {
    const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
    useAzureMonitor();
    return true;
  } catch (error) {
    if (config.nodeEnv === 'production') {
      throw new Error(`Azure Monitor OpenTelemetry failed to initialize: ${error?.message ?? error}`);
    }
    console.warn('Azure Monitor OpenTelemetry unavailable', error?.message ?? error);
    return false;
  }
}
