import winston from 'winston';
import DatadogWinston from 'datadog-winston';

const DD_API_KEY = process.env.DD_API_KEY;
const HEROKU_APP_NAME = process.env.HEROKU_APP_NAME;

const logger = winston.createLogger({
    level: 'debug',
    exitOnError: false,
    format: winston.format.json(),
});

logger.add(
    new DatadogWinston({
        apiKey: DD_API_KEY,
        hostname: HEROKU_APP_NAME,
        service: HEROKU_APP_NAME,
        ddsource: 'nodejs',
    })
);

export default logger;