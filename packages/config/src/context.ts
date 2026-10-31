import { ConfigurationError, loadConfig } from './config.js';
import type { AppConfig, Environment } from './config.js';
import { createLogger } from './logger.js';
import type { AppLogger } from './logger.js';
import { SecretRegistry } from './secrets.js';

export interface AppContext {
  readonly config: AppConfig;
  readonly logger: AppLogger;
}

/** Both services share the same validation, registry and startup error boundary. */
export function createAppContext(
  env: Environment,
  sink: (line: string) => void,
): AppContext | undefined {
  const registry = new SecretRegistry();
  const logger = createLogger(registry, sink);
  try {
    return Object.freeze({ config: loadConfig(env, registry), logger });
  } catch (error) {
    // Invalid inputs may fail before registration; never log raw environment or errors here.
    logger.error('configuration_invalid', {
      code: 'INVALID_CONFIGURATION',
      fields: error instanceof ConfigurationError ? error.fields : ['ENVIRONMENT'],
    });
    return undefined;
  }
}
