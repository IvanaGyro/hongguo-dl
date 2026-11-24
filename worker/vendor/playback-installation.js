// Anonymous installation state belongs to a browser, never to the Worker user population.
const { registerPlaybackDevice } = require('./playback-device');
const { PROFILE } = require('./device-profile');
const sessions = new Map();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const id = value => typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value);
function validateInstallation(value) {
    const invalid = () => { throw Object.assign(new Error('無效的播放裝置資料'), { status: 400, code: 'INVALID_DEVICE' }); };
    if (!value || value.profile !== PROFILE || !UUID.test(value.clientId || '') ||
        !UUID.test(value.cdid || '') || !UUID.test(value.clientudid || '') ||
        !/^[a-f0-9]{16}$/i.test(value.openudid || '') ||
        !Number.isSafeInteger(value.firstInstallAt) || value.firstInstallAt <= 0 || value.firstInstallAt > Date.now() + 60000) invalid();
    const clean = Object.fromEntries(['profile', 'clientId', 'cdid', 'clientudid', 'openudid', 'firstInstallAt'].map(key => [key, value[key]]));
    if (value.device_id !== undefined || value.iid !== undefined) {
        if (!id(value.device_id) || !id(value.iid) || !Number.isSafeInteger(value.registeredAt) ||
            value.registeredAt <= 0 || value.registeredAt > Date.now() + 60000) invalid();
        Object.assign(clean, { device_id: value.device_id, iid: value.iid, registeredAt: value.registeredAt });
        // Trust tokens and the cookie jar the register step issued. Sanitized and
        // bounded: they are replayed on later fqnovel.com requests, never shown.
        if (typeof value.device_token === 'string' && value.device_token && value.device_token.length <= 512) clean.device_token = value.device_token;
        if (typeof value.klink_egdi === 'string' && value.klink_egdi && value.klink_egdi.length <= 256) clean.klink_egdi = value.klink_egdi;
        if (value.cookies && typeof value.cookies === 'object' && !Array.isArray(value.cookies)) {
            const jar = {};
            for (const [name, cookie] of Object.entries(value.cookies)) {
                if (/^[a-z0-9_-]{1,64}$/i.test(name) && typeof cookie === 'string' && cookie.length <= 256 && !/[\r\n;,]/.test(cookie)) jar[name] = cookie;
            }
            if (Object.keys(jar).length) clean.cookies = jar;
        }
    }
    return clean;
}
function installationSession(value) {
    const identity = validateInstallation(value);
    // Include installation seeds: a malformed client cannot merge two installations by clientId alone.
    const key = [identity.clientId, identity.cdid, identity.clientudid, identity.openudid, identity.firstInstallAt].join(':');
    let session = sessions.get(key);
    if (!session) {
        // In-flight entries remain pinned so eviction cannot duplicate registration.
        if (sessions.size >= 256) {
            const idle = [...sessions].find(([, entry]) => !entry.registering && !entry.pendingSources);
            if (!idle) throw Object.assign(new Error('播放服務忙碌，請稍後再試'), { status: 503, code: 'DEVICE_BUSY' });
            sessions.delete(idle[0]);
        }
        session = { identity };
    } else if (identity.registeredAt > (session.identity.registeredAt || 0)) session.identity = identity;
    sessions.delete(key); sessions.set(key, session);
    return session;
}
async function prepareInstallation(value, requestJson, { background = false } = {}) {
    const session = installationSession(value);
    const interval = (background ? 12 : 6) * 3600000;
    // This schedules an update; the stored IDs do not expire at this interval.
    if (session.identity.device_id && Date.now() - session.identity.registeredAt < interval) return session.identity;
    session.registering ||= registerPlaybackDevice(requestJson, { previous: session.identity, session })
        .then(identity => session.identity = identity).finally(() => { session.registering = null; });
    try { return await session.registering; }
    catch (error) { if (session.identity.device_id) return session.identity; throw error; }
}
module.exports = { PROFILE, validateInstallation, installationSession, prepareInstallation };
