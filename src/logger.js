import winston from 'winston';
import DatadogWinston from 'datadog-winston';

const DD_API_KEY = process.env.DD_API_KEY;
const APP_NAME = process.env.APP_NAME;

const logger = winston.createLogger({
    level: 'debug',
    exitOnError: false,
    format: winston.format.json(),
});

logger.add(
    new DatadogWinston({
        apiKey: DD_API_KEY,
        hostname: APP_NAME,
        service: APP_NAME,
        ddsource: 'nodejs',
    })
);

export default logger;