// SPDX-License-Identifier: GPL-3.0-only
// ttEncrypt and registration fields adapted from tsukiyo-zero/hongguoTV,
// commit 388931852ddc614db8b00775a3dc54c5ede6307f,
// kotlin-tv/core/src/main/kotlin/com/hongguotv/core/DeviceRegister.kt
// (itself adapted from charlie901208/HGTV feat/phone-login, GPL-3.0-only).
// Changes: persistent anonymous phone profile; reuse installation identifiers on updates.
const crypto = require('node:crypto');
const { APP_UA, registrationHeader } = require('./device-profile');
const { gzipSync } = require('node:zlib');
const { abortError, throwIfAborted, boundedSignal, networkFailure } = require('./request-signal');

const REGISTER_URL = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const KDF_SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
let registration;
let refreshAfter = 0;
let retryAfter = 0;
const legacySession = {};

function responseId(response, name) {
    const preferred = response?.[`${name}_str`];
    const value = preferred === undefined || preferred === null || preferred === '' ? response?.[name] : preferred;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : '';
}

async function registerPlaybackDevice(requestJson, { signal, previous = {}, session = legacySession } = {}) {
    throwIfAborted(signal);
    if (Date.now() < session.registrationRetryAfter) throw Object.assign(new Error('匿名播放设备注册失败，请检查网络，10 秒后重试'), {
        code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: session.lastRegistrationFailure,
        status: session.lastRegistrationStatus, retryAfterMs: Math.max(0, session.registrationRetryAfter - Date.now()),
        ...(session.lastNetworkFailure ? { networkFailure: session.lastNetworkFailure } : {}),
    });
    const request = boundedSignal(signal, 8000);
    try {
            throwIfAborted(request.signal);
            const now = Date.now();
            const cdid = previous.cdid || crypto.randomUUID();
            const header = {
                ...registrationHeader(), cdid,
                openudid: previous.openudid || crypto.randomBytes(8).toString('hex'),
                clientudid: previous.clientudid || crypto.randomUUID(), req_id: crypto.randomUUID(),
                apk_first_install_time: previous.firstInstallAt || now,
            };
            if (previous.device_id && previous.iid) {
                header.device_id = previous.device_id;
                header.install_id = previous.iid;
            }
            const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
            const random = crypto.randomBytes(32);
            const derived = crypto.createHash('sha512').update(Buffer.concat([
                crypto.createHash('sha512').update(random).digest(), KDF_SALT,
            ])).digest();
            const cipher = crypto.createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
            const plaintext = Buffer.concat([crypto.createHash('sha512').update(compressed).digest(), compressed]);
            const data = Buffer.concat([Buffer.from('746305100000', 'hex'), random, cipher.update(plaintext), cipher.final()]);
            const response = await requestJson(REGISTER_URL, {
                method: 'POST',
                headers: {
                    'User-Agent': APP_UA,
                    Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
                    'log-encode-type': 'gzip', 'x-ss-dp': '8662', 'x-ss-req-ticket': String(now),
                    'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
                    'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
                    'x-ss-stub': crypto.createHash('md5').update(data).digest('hex').toUpperCase(),
                },
                data,
            }, Date.now() + 8000, request.signal);
            throwIfAborted(request.signal);
            const device_id = responseId(response, 'device_id');
            const iid = responseId(response, 'install_id');
            if (Number(response?.code ?? response?.Code ?? 0) !== 0) throw Object.assign(new Error('Registration rejected'), { code: 'BUSINESS_REJECTED' });
            if (!device_id || !iid) throw Object.assign(new Error('Invalid registration'), { code: 'INVALID_RESPONSE' });
        session.registrationRetryAfter = 0;
        return Object.freeze({ ...previous, device_id, iid, cdid, clientudid: header.clientudid,
            openudid: header.openudid, firstInstallAt: header.apk_first_install_time, registeredAt: now });
    } catch (error) {
        if (request.signal.aborted) error = abortError(request.signal);
        if (error?.code === 'ERR_CANCELED') throw abortError();
        const status = Number(error?.status);
        const detail = networkFailure(error?.code);
        const registrationFailure = Number.isInteger(status) && status >= 300 && status <= 599 ? `HTTP_${status}`
            : ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code) ? 'TIMEOUT'
            : detail || error?.code === 'ERR_NETWORK' ? 'NETWORK_ERROR'
            : ['EMPTY_RESPONSE', 'INVALID_RESPONSE', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED'].includes(error?.code) ? error.code : 'UNKNOWN';
        session.registrationRetryAfter = Date.now() + Math.max(10000, error.retryAfterMs || 0);
        session.lastRegistrationStatus = Number.isInteger(status) ? status : undefined;
        session.lastRegistrationFailure = registrationFailure;
        session.lastNetworkFailure = registrationFailure === 'NETWORK_ERROR' ? detail : undefined;
        throw Object.assign(new Error('匿名播放设备注册失败，请检查网络，10 秒后重试'), {
            code: 'DEVICE_REGISTRATION_FAILED', registrationFailure,
            status: session.lastRegistrationStatus, retryAfterMs: error.retryAfterMs,
            ...(session.lastNetworkFailure ? { networkFailure: session.lastNetworkFailure } : {}),
        });
    } finally {
        request.dispose();
    }
}

function getPlaybackDevice(requestJson, rejectedDevice) {
    if (retryAfter && Date.now() >= retryAfter) {
        registration = undefined;
        retryAfter = 0;
    }
    if (rejectedDevice && registration) {
        const previous = registration;
        return previous.then(current => {
            // Concurrent and late failures must share the newest device, with at most one renewal per minute.
            if (registration !== previous || current !== rejectedDevice || Date.now() < refreshAfter) return registration;
            refreshAfter = Date.now() + 60000;
            const renewal = Promise.resolve().then(() => registerPlaybackDevice(requestJson, { previous: current })).catch(error => {
                if (registration === renewal) registration = previous;
                throw error;
            });
            registration = renewal;
            return registration;
        });
    }
    // Share failures briefly to avoid concurrent retries, then allow recovery without restarting.
    registration ||= Promise.resolve().then(() => registerPlaybackDevice(requestJson)).catch(error => {
        if (error.code === 'ERR_CANCELED') registration = undefined;
        else retryAfter = Date.now() + 10000;
        throw error;
    });
    return registration;
}

module.exports = { getPlaybackDevice, registerPlaybackDevice };
