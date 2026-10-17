// HTTP status codes by name, as Python's http.HTTPStatus names them, so code
// never compares a response against a bare number.

export const HTTP_STATUS = Object.freeze({
    OK: 200,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    CONFLICT: 409,
    GONE: 410,
    INTERNAL_SERVER_ERROR: 500,
});

// Every HTTP status is below this (the 5xx class is the last).
const STATUS_LIMIT = 600;

// The server or a client error: 4xx or 5xx.
export function isErrorStatus(status) {
    return status >= HTTP_STATUS.BAD_REQUEST;
}

// A server error: 5xx.
export function isServerErrorStatus(status) {
    return status >= HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

// A final answer from a server (not informational 1xx): 2xx to 5xx.
export function isAnsweredStatus(status) {
    return status >= HTTP_STATUS.OK && status < STATUS_LIMIT;
}
