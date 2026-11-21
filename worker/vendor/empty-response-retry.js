// SPDX-License-Identifier: GPL-3.0-only
// Only HTTP 200 with an empty upstream body moves to the next request.
// Explicit refusal, 429, invalid responses and network errors are not retried;
// an empty body carrying Retry-After is a server backoff and ends recovery.
// Each attempt is a different signed endpoint, so no fixed delay is inserted.
const { throwIfAborted } = require('./request-signal');

async function retryEmptyResponse(request, {
    attempts = 3, deadline = Date.now() + 12000, signal,
    afterEmpty = async () => {}
} = {}) {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3)
        throw new TypeError('Invalid bounded retry count');
    for (let attempt = 0; attempt < attempts; attempt++) {
        throwIfAborted(signal);
        try { return await request(attempt); }
        catch (error) {
            throwIfAborted(signal);
            if (error?.code === 'EMPTY_RESPONSE') {
                error.emptyResponseCount = attempt + 1;
                error.upstreamStatus = 200;
            }
            if (error?.code !== 'EMPTY_RESPONSE' || error.retryAfter || attempt + 1 >= attempts ||
                deadline - Date.now() < 1500) throw error;
            await afterEmpty(attempt);
            throwIfAborted(signal);
            if (deadline - Date.now() < 1500) throw error;
        }
    }
    throw new Error('Unreachable retry state');
}

module.exports = { retryEmptyResponse };
