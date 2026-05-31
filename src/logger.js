import winston from 'winston';
import DatadogWinston from 'datadog-winston';

const DD_API_KEY = process.env.DD_API_KEY;
const APP_NAME = process.env.APP_NAME;
const SERVER_VERSION = process.env.npm_package_version;
const LOG_LEVEL = process.env.LOG_LEVEL || (APP_NAME?.includes('PROD') ? 'info' : 'debug');

const REDACTED = '<redacted>';
const SENSITIVE_FIELDS = new Set([
    'jwt', 'hostToken', 'clientToken', 'passwordHash',
    'offer', 'answer', 'candidate', 'candidates', 'sdp', 'url', 'credential',
    'requestHash', 'certificateSha256Digest', 'integrity_token', 'token', 'accessToken',
]);

function redactString(value) {
    return value.replace(/([?&](?:p|password|passwordHash|clientToken|hostToken|jwt|token|dd-api-key)=)[^&\s]*/gi, `$1${REDACTED}`);
}

const normalizeStructuredLog = winston.format((info) => {
    const source = info.message;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
        const { message, level, timestamp, ...fields } = source;
        Object.assign(info, fields);
        info.message = message || fields.socket_event || fields.event_name || fields.reason || fields.error || 'log_event';
    }
    const hasFailure = Boolean(info.error || info.reason);
    if (info.socket_event && !info.event_name) info.event_name = 'webrtc_signaling';
    if (!info.result) info.result = String(info.classification || '').includes('ignored') ? 'ignored' : (hasFailure ? 'error' : info.result);
    for (const [key, value] of Object.entries(info)) {
        if (key !== 'level' && key !== 'timestamp') info[key] = SENSITIVE_FIELDS.has(key) ? REDACTED : redactLogPayload(value);
    }
    return info;
});

const logger = winston.createLogger({
    level: LOG_LEVEL,
    exitOnError: false,
    defaultMeta: { server_version: SERVER_VERSION },
    format: winston.format.combine(winston.format.timestamp(), normalizeStructuredLog(), winston.format.json()),
});

if (DD_API_KEY) {
    logger.add(new DatadogWinston({ apiKey: DD_API_KEY, hostname: APP_NAME, service: APP_NAME, ddsource: 'nodejs', }));
} else {
    logger.add(new winston.transports.Console());
}

export function redactLogPayload(payload) {
    if (Array.isArray(payload)) return payload.map(redactLogPayload);
    if (payload instanceof Error) return { name: payload.name, message: redactString(payload.message || '') };
    if (typeof payload === 'string') return redactString(payload);
    if (!payload || typeof payload !== 'object') return payload;

    return Object.fromEntries( Object.entries(payload).map(([key, value]) => [ key, SENSITIVE_FIELDS.has(key) ? REDACTED : redactLogPayload(value), ]) );
}

export default logger;
