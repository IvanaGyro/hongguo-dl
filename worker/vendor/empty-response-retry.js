// SPDX-License-Identifier: GPL-3.0-only
// Only HTTP 200 with an empty upstream body is retryable here.
// Explicit refusal, 429, invalid responses and network errors are not retried.
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
            if (error?.code !== 'EMPTY_RESPONSE' || attempt + 1 >= attempts ||
                deadline - Date.now() < 1500) throw error;
            await afterEmpty(attempt);
            throwIfAborted(signal);
            if (deadline - Date.now() < 1500) throw error;
        }
    }
    throw new Error('Unreachable retry state');
}

module.exports = { retryEmptyResponse };
