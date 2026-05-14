import { type IAgentRuntime, logger } from '@elizaos/core';

export interface TelegramConfig {
  TELEGRAM_BOT_TOKEN: string;
}

/**
 * Validates the Telegram configuration by retrieving the Telegram bot token from the runtime settings or environment variables.
 * Returns null if validation fails instead of throwing an error.
 *
 * @param {IAgentRuntime} runtime - The agent runtime used to get the setting.
 * @returns {Promise<TelegramConfig | null>} A promise that resolves with the validated Telegram configuration or null if invalid.
 */
export async function validateTelegramConfig(
  runtime: IAgentRuntime,
): Promise<TelegramConfig | null> {
  const rawToken = runtime.getSetting('TELEGRAM_BOT_TOKEN');
  const fromRuntime =
    typeof rawToken === 'string' && rawToken.trim() ? rawToken.trim() : '';
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  const token =
    fromRuntime ||
    (typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : '');

  if (!token) {
    logger.warn(
      { src: 'plugin:telegram', errors: 'TELEGRAM_BOT_TOKEN: Telegram bot token is required' },
      'Telegram configuration validation failed',
    );
    return null;
  }

  return { TELEGRAM_BOT_TOKEN: token };
}
