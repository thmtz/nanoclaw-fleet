/**
 * Logging: pretty output to stdout (captured by systemd to nanoclaw.log),
 * structured JSONL to logs/nanoclaw.jsonl for programmatic querying.
 */
import fs from 'fs';
import path from 'path';
import pino from 'pino';

const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true, destination: 1 }, // stdout
      },
      {
        target: 'pino/file',
        options: { destination: path.join(logsDir, 'nanoclaw.jsonl') },
      },
    ],
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
