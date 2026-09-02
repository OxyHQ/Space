import pino from 'pino';

const REDACT_PATHS = [
  'token',
  'authorization',
  'password',
  'secret',
  'req.headers.authorization',
  'req.headers.cookie',
];

const isDev = process.env.NODE_ENV !== 'production';

const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

export function createLogger(subsystem: string) {
  return rootLogger.child({ subsystem });
}

export const log = {
  auth: createLogger('auth'),
  general: rootLogger,
};

export default rootLogger;
