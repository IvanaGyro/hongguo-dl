// One anonymous Android profile for registration, API signing and media requests.
// App version/package are confirmed by the analyzed 7.4.5.32 APK manifest.
// Hardware and SDK protocol fields retain the existing adapter configuration;
// they are not a claim that a captured APK request used this exact device/SDK.
const APP = Object.freeze({ version: '7.4.5.32', code: 74532, package: 'com.phoenix.read', aid: 8662,
    channel: 'update_64', model: '25053RT47C', brand: 'Redmi', manufacturer: 'Redmi',
    os: '16', api: 36, build: 'BP2A.250605.031.A3', width: 1280, height: 2772, dpi: 520, abi: 'arm64-v8a' });
const PROFILE = `android-${APP.code}-redmi-v1`;
const APP_UA = `${APP.package}/${APP.code} (Linux; U; Android ${APP.os}; zh_CN; ${APP.model}; Build/${APP.build})`;
const DEVICE_QUERY = Object.freeze({
    ac: 'wifi', channel: APP.channel, aid: String(APP.aid), app_name: 'novelread',
    version_code: String(APP.code), version_name: APP.version, device_platform: 'android', os: 'android',
    ssmix: 'a', device_type: APP.model, device_brand: APP.brand, language: 'zh', os_api: String(APP.api),
    os_version: APP.os, manifest_version_code: String(APP.code), resolution: `${APP.width}*${APP.height}`, dpi: String(APP.dpi),
    update_version_code: String(APP.code), host_abi: APP.abi, dragon_device_type: 'phone', pv_player: String(APP.code),
    compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0',
});
function registrationHeader() {
    return {
        display_name: '红果免费短剧', update_version_code: APP.code, manifest_version_code: APP.code,
        app_version_minor: APP.version, aid: APP.aid, channel: APP.channel, package: APP.package,
        app_version: APP.version, version_code: APP.code, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
        sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: APP.os, os_api: APP.api,
        device_model: APP.model, device_brand: APP.brand, device_manufacturer: APP.manufacturer,
        cpu_abi: APP.abi, release_build: 'b5e187f', density_dpi: APP.dpi, display_density: 'mdpi',
        resolution: `${APP.width}x${APP.height}`, language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
        carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340', rom_version: 'W528JS release-keys',
        sig_hash: '56a962410c494bbaf0b58dba20cae56f', ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai',
        tz_offset: 28800, sim_region: 'cn', sim_serial_number: [], oaid_may_support: false, device_platform: 'android',
        custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' },
        pre_installed_channel: '', is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
    };
}
module.exports = { APP, PROFILE, APP_UA, DEVICE_QUERY, registrationHeader };
