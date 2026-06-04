export const PROTOCOL_VERSION = 2;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function validAttemptId(value) {
    return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value) ? value : null;
}

export function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function ack(callback, status, payload = {}) {
    if (typeof callback === 'function') callback({ status, ...payload });
}
