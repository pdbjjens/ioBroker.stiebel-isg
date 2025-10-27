'use strict';

/**
 * stiebel-eltron / tecalor isg adapter - main.js v13
 *
 * Changes in v13:
 * - Fixes min/max handling and updates existing objects that were created previously with incorrect min/max = 0.
 * - Adds diagnostic debug logs for encountered valMin/valMax (as before).
 * - Concurrency limiter, native fetch + fetch-cookie + tough-cookie, and timeout handling preserved.
 *
 * Requirements:
 *  - Node >= 18 (global fetch + AbortController)
 *  - npm i --save fetch-cookie tough-cookie cheerio
 *  - optionally: npm i --save undici
 */

const utils = require('@iobroker/adapter-core');
const querystring = require('querystring');
const cheerio = require('cheerio');
const tough = require('tough-cookie');

const fetchCookieModule = (() => {
    try {
        return require('fetch-cookie');
    } catch {
        return null;
    }
})();

let undiciDispatcher = null;
try {
    const undici = require('undici');
    if (typeof undici.Agent === 'function') {
        undiciDispatcher = new undici.Agent({ keepAliveTimeout: 60000, connections: 6 });
    } else {
        undiciDispatcher = null;
    }
} catch {
    undiciDispatcher = null;
}

let adapter;
let systemLanguage;
let nameTranslation;
let isgIntervall;
let isgCommandIntervall;
let commands = [];
let CommandTimeout;
let jar;
let host;
let commandPaths = [];
let valuePaths = [];
let statusPaths = [];

/* -------------------------
   Concurrency queue (simple, dependency-free)
   ------------------------- */

let queue = [];
let running = 0;
let maxConcurrentFetches = 3; // default; updated from adapter.config in ready()

function schedule(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        runQueue();
    });
}

function runQueue() {
    while (running < maxConcurrentFetches && queue.length > 0) {
        const item = queue.shift();
        running++;
        Promise.resolve()
            .then(() => item.fn())
            .then(res => item.resolve(res))
            .catch(err => item.reject(err))
            .finally(() => {
                running--;
                setImmediate(runQueue);
            });
    }
}

/* -------------------------
   Cookie jar & fetch helpers
   ------------------------- */

function setJar(j) {
    jar = j;
}

function getJar() {
    if (jar) {
        return jar;
    }
    jar = new tough.CookieJar();
    return jar;
}

function ensureNativeFetch() {
    if (typeof globalThis.fetch !== 'function') {
        const msg =
            'Global fetch() is not available. This adapter requires Node.js >= 18 for native fetch. ' +
            'Install Node >= 18 or request a node-fetch fallback.';
        if (adapter && adapter.log) {
            adapter.log.error(msg);
        }
        throw new Error(msg);
    }
}

function getFetchFactory() {
    if (!fetchCookieModule) {
        const msg =
            'fetch-cookie is not installed. Please install fetch-cookie and tough-cookie: npm i --save fetch-cookie tough-cookie';
        if (adapter && adapter.log) {
            adapter.log.error(msg);
        }
        throw new Error(msg);
    }
    if (typeof fetchCookieModule === 'function') {
        return fetchCookieModule;
    }
    if (fetchCookieModule && typeof fetchCookieModule.default === 'function') {
        return fetchCookieModule.default;
    }
    const msg = 'fetch-cookie export shape is unexpected. Ensure fetch-cookie is installed and compatible.';
    if (adapter && adapter.log) {
        adapter.log.error(msg);
    }
    throw new Error(msg);
}

function getFetch() {
    ensureNativeFetch();
    const fetchFactory = getFetchFactory();
    const jarInst = getJar();
    try {
        return fetchFactory(globalThis.fetch, jarInst);
    } catch (err) {
        try {
            return fetchFactory(jarInst, globalThis.fetch);
        } catch (err2) {
            const msg = `Failed to create cookie-wrapped fetch: ${err.message}; ${err2 && err2.message}`;
            if (adapter && adapter.log) {
                adapter.log.error(msg);
            }
            throw new Error(msg);
        }
    }
}

/*
 * Build fetch options and timeout/abort logic.
 * Returns { options, clearTimeout }.
 */

function buildFetchOptions(url, extra = {}) {
    let configuredTimeout = 60000;
    try {
        if (adapter && typeof adapter.config !== 'undefined' && adapter.config.requestTimeout != null) {
            const num = Number(adapter.config.requestTimeout);
            if (!isNaN(num)) {
                configuredTimeout = num;
            }
        }
    } catch {
        configuredTimeout = 60000;
    }
    const timeout = Number(configuredTimeout) || 0;

    const controller = new AbortController();
    let timer = null;
    if (timeout > 0) {
        timer = setTimeout(() => {
            try {
                controller.abort();
            } catch {
                /* ignore */
            }
        }, timeout);
    }

    const opts = Object.assign(
        {
            signal: controller.signal,
            credentials: 'include',
        },
        extra,
    );

    if (undiciDispatcher) {
        opts.dispatcher = undiciDispatcher;
    }

    return {
        options: opts,
        clearTimeout: () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
}

/* -------------------------
   Translation / helpers
   ------------------------- */

function translateName(strName, intType) {
    if (typeof intType === 'undefined') {
        intType = 0;
    }

    switch (intType) {
        case 1:
            if (nameTranslation[strName]) {
                return nameTranslation[strName][1];
            }
            return strName;

        case 0:
        default:
            if (nameTranslation[strName]) {
                return nameTranslation[strName];
            }
            return strName;
    }
}

function Umlauts(text_string) {
    if (!text_string) {
        return text_string;
    }
    return text_string
        .replace(/[\u00c4]+/g, 'AE')
        .replace(/[\u00d6]+/g, 'OE')
        .replace(/[\u00dc]+/g, 'UE');
}

function updateState(strGroup, valTag, valTagLang, valType, valUnit, valRole, valValue) {
    if (valTag == null) {
        return;
    }

    let ValueExpire = null;

    if (
        strGroup.startsWith(translateName('settings')) ||
        strGroup.startsWith(`${translateName('info')}.ANLAGE.STATISTIK`)
    ) {
        ValueExpire = adapter.config.isgCommandIntervall * 2;
    } else {
        ValueExpire = adapter.config.isgIntervall * 2;
    }

    if (adapter.config.isgUmlauts == 'no') {
        valTag = Umlauts(valTag);
        strGroup = Umlauts(strGroup);
    }

    valTag = valTag.replace(/[*]+/g, '_');

    adapter.setObjectNotExists(
        `${strGroup}.${valTag}`,
        {
            type: 'state',
            common: {
                name: valTagLang,
                type: valType,
                read: true,
                write: false,
                unit: valUnit,
                role: valRole,
            },
            native: {},
        },
        function () {
            adapter.setState(`${strGroup}.${valTag}`, { val: valValue, ack: true, expire: ValueExpire });
        },
    );
}

/* -------------------------
   HTTP helpers: getHTML/getIsgStatus/getIsgValues
   ------------------------- */

async function getHTML(sidePath) {
    const strURL = `${host}/?s=${sidePath}`;

    const payload = querystring.stringify({
        user: adapter.config.isgUser,
        pass: adapter.config.isgPassword,
    });

    const fetch = getFetch();
    const built = buildFetchOptions(strURL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Connection: 'keep-alive',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        body: payload,
    });

    try {
        const res = await fetch(strURL, built.options);
        built.clearTimeout();

        const status = res && typeof res.status !== 'undefined' ? res.status : null;
        if (status === 200) {
            const text = await res.text();
            adapter.setState('info.connection', true, true);
            return cheerio.load(text);
        }
        adapter.log.error(`statusCode: ${status || 'no response'}`);
        adapter.log.error(`statusText: ${res && res.statusText ? res.statusText : ''}`);
        adapter.setState('info.connection', false, true);
        throw new Error(`HTTP ${status}`);
    } catch (error) {
        built.clearTimeout();
        if (error && (error.name === 'AbortError' || String(error).toLowerCase().includes('aborted'))) {
            adapter.log.debug(`getHTML(${sidePath}) aborted: ${error.message || error}`);
        } else {
            adapter.log.error(`Error: ${error.message || error} to ${strURL} - Check ISG Address!`);
        }
        adapter.setState('info.connection', false, true);
        throw error;
    }
}

async function getIsgStatus(sidePath) {
    try {
        const $ = await getHTML(sidePath);
        if ($) {
            const submenu = $('#sub_nav')
                .children()
                .first()
                .text()
                .replace(/[-/]+/g, '_')
                .replace(/[ .]+/g, '')
                .replace(/[\u00df]+/g, 'SS');

            $('.info').each((_i, el) => {
                let group = $(el)
                    .find('.round-top')
                    .text()
                    .replace(/[ -]+/g, '_')
                    .replace(/[.]+/g, '')
                    .replace(/[\u00df]+/, 'SS');

                group = `${submenu}.${group}`;

                $(el)
                    .find('tr')
                    .each(function () {
                        const valueName = $(this).find('.key').text();

                        const key = $(this)
                            .find('.key')
                            .text()
                            .replace(/[ -]+/g, '_')
                            .replace(/[.]+/g, '')
                            .replace(/[\u00df]+/, 'SS');

                        const param = $(this).find('.value').html();
                        let value;
                        if (param !== null) {
                            if (param.search('symbol_an') > -1) {
                                value = true;
                            }
                        }

                        const valType = typeof value;
                        let valThisType = 'state';
                        if (valType !== null) {
                            if (value === true || value === false) {
                                valThisType = 'boolean';
                            } else {
                                valThisType = 'state';
                            }
                        }

                        if (value === true) {
                            updateState(
                                `${translateName('info')}.${group}`,
                                key,
                                translateName(valueName),
                                valThisType,
                                '',
                                'indicator.state',
                                value,
                            );
                        }
                    });
            });
        }
    } catch (e) {
        adapter.log.debug(`getIsgStatus(${sidePath}) error: ${e.message || e}`);
    }
}

async function getIsgValues(sidePath) {
    try {
        const $ = await getHTML(sidePath);
        if ($) {
            const submenu = $('#sub_nav')
                .children()
                .first()
                .text()
                .replace(/[-/]+/g, '_')
                .replace(/[ .]+/g, '')
                .replace(/[\u00df]+/g, 'SS');

            $('.info').each((_i, el) => {
                let group = $(el)
                    .find('.round-top')
                    .text()
                    .replace(/[ -]+/g, '_')
                    .replace(/[.]+/g, '')
                    .replace(/[\u00df]+/, 'SS');

                group = `${submenu}.${group}`;

                $(el)
                    .find('tr')
                    .each(function () {
                        const valueName = $(this).find('.key').text();

                        const key = $(this)
                            .find('.key')
                            .text()
                            .replace(/[ -]+/g, '_')
                            .replace(/[.]+/g, '')
                            .replace(/[\u00df]+/, 'SS');

                        const param = $(this).find('.value').text().replace(/,/, '.');

                        const value = parseFloat(param);
                        const unit = (param || '')
                            .replace(/[ ]{0,2}/, '')
                            .replace(/ /g, '')
                            .replace(value, '')
                            .replace(/([.0][0]){1}?/, '')
                            .replace(/^0+/, '');

                        let valueRole;
                        if (
                            key.search('TEMP') > -1 ||
                            key.search('FROST') > -1 ||
                            key.search('SOLLWERT_HK') == 0 ||
                            key.search('ISTWERT_HK') == 0
                        ) {
                            valueRole = 'value.temperature';
                        } else if (key.search('DRUCK') > -1) {
                            valueRole = 'value.pressure';
                        } else if (key.search('P_') == 0) {
                            valueRole = 'value.power.consumption';
                        } else if (key.search('FEUCHTE') > -1) {
                            valueRole = 'value.humidity';
                        } else {
                            valueRole = 'value';
                        }

                        if (key && value != null && !isNaN(value)) {
                            updateState(
                                `${translateName('info')}.${group}`,
                                key,
                                translateName(valueName),
                                typeof value,
                                unit,
                                valueRole,
                                value,
                            );
                        }
                    });
            });
        }
    } catch (e) {
        adapter.log.debug(`getIsgValues(${sidePath}) error: ${e.message || e}`);
    }
}

/* -------------------------
   Commands creation & parsing (v13: correct min/max + object update)
   ------------------------- */

function createISGCommands(
    strGroup,
    valTag,
    valTagLang,
    valType,
    valUnit,
    valRole,
    valValue,
    valStates,
    valMin,
    valMax,
) {
    if (valTag == null) {
        return;
    }

    if (adapter.config.isgUmlauts == 'no') {
        valTag = Umlauts(valTag);
        strGroup = Umlauts(strGroup);
    }

    valTag = valTag.replace(/[*]+/g, '_');
    valUnit = (valUnit || '').replace(/ +0+/g, '');

    // Build desired common object (what we want the state's common to contain)
    const desiredCommon = {
        name: valTagLang,
        type: valType,
        read: true,
        write: true,
        unit: valUnit,
        role: valRole,
    };

    // Diagnostic debug: print the raw valMin/valMax encountered (debug-only)
    try {
        adapter &&
            adapter.log &&
            adapter.log.debug &&
            adapter.log.debug(
                `createISGCommands: encountered valMin="${valMin}" valMax="${valMax}" for ${strGroup}.${valTag}`,
            );
    } catch {
        // ignore logging errors
    }

    // Only include min/max if explicitly provided and parseable as finite number
    if (typeof valMin !== 'undefined' && valMin !== null) {
        const sMin = String(valMin).trim();
        if (sMin !== '') {
            const minNum = Number(sMin);
            if (Number.isFinite(minNum)) {
                desiredCommon.min = minNum;
            } else {
                adapter &&
                    adapter.log &&
                    adapter.log.debug &&
                    adapter.log.debug(`createISGCommands: invalid min "${valMin}" for ${strGroup}.${valTag} - ignored`);
            }
        } else {
            adapter &&
                adapter.log &&
                adapter.log.debug &&
                adapter.log.debug(`createISGCommands: empty min for ${strGroup}.${valTag} - ignored`);
        }
    }

    if (typeof valMax !== 'undefined' && valMax !== null) {
        const sMax = String(valMax).trim();
        if (sMax !== '') {
            const maxNum = Number(sMax);
            if (Number.isFinite(maxNum)) {
                desiredCommon.max = maxNum;
            } else {
                adapter &&
                    adapter.log &&
                    adapter.log.debug &&
                    adapter.log.debug(`createISGCommands: invalid max "${valMax}" for ${strGroup}.${valTag} - ignored`);
            }
        } else {
            adapter &&
                adapter.log &&
                adapter.log.debug &&
                adapter.log.debug(`createISGCommands: empty max for ${strGroup}.${valTag} - ignored`);
        }
    }

    // Ensure states is an object (js-controller expects object)
    if (valStates) {
        if (typeof valStates === 'object') {
            desiredCommon.states = valStates;
        } else if (typeof valStates === 'string') {
            const s = valStates.trim();
            if (s.startsWith('{') || s.startsWith('[')) {
                try {
                    desiredCommon.states = JSON.parse(s);
                } catch {
                    try {
                        desiredCommon.states = JSON.parse(s.replace(/'/g, '"'));
                    } catch {
                        adapter.log &&
                            adapter.log.warn &&
                            adapter.log.warn(
                                `createISGCommands: could not parse states for ${valTag}. states will be ignored.`,
                            );
                    }
                }
            } else {
                // try "0:Off,1:On" style
                try {
                    const obj = {};
                    s.split(',').forEach(pair => {
                        const parts = pair.split(':');
                        if (parts.length >= 2) {
                            const k = parts[0].trim();
                            const v = parts.slice(1).join(':').trim();
                            if (k) {
                                obj[k] = v;
                            }
                        }
                    });
                    if (Object.keys(obj).length) {
                        desiredCommon.states = obj;
                    }
                } catch {
                    // ignore
                }
            }
        }
    }

    const id = `${strGroup}.${valTag}`;

    // First check whether object exists; if not: create it with desiredCommon.
    adapter.getObject(id, (err, obj) => {
        if (err) {
            adapter.log &&
                adapter.log.error &&
                adapter.log.error(`createISGCommands: getObject error for ${id}: ${err}`);
            return;
        }

        if (!obj) {
            // object doesn't exist -> create with desiredCommon
            adapter.setObjectNotExists(
                id,
                {
                    type: 'state',
                    common: desiredCommon,
                    native: {},
                },
                function () {
                    adapter.setState(id, { val: valValue, ack: true });
                },
            );
        } else {
            // object exists -> we may need to update common.min/common.max/states/name/unit/role if changed
            const existingCommon = obj.common || {};
            const newCommon = Object.assign({}, existingCommon);

            // update basic fields from desiredCommon
            newCommon.name = desiredCommon.name;
            newCommon.type = desiredCommon.type;
            newCommon.read = desiredCommon.read;
            newCommon.write = desiredCommon.write;
            newCommon.unit = desiredCommon.unit;
            newCommon.role = desiredCommon.role;

            // min: if desiredCommon has min -> set, otherwise ensure it's removed if previously present but now no min
            if (Object.prototype.hasOwnProperty.call(desiredCommon, 'min')) {
                newCommon.min = desiredCommon.min;
            } else {
                if (Object.prototype.hasOwnProperty.call(newCommon, 'min')) {
                    // remove erroneous min
                    delete newCommon.min;
                }
            }

            // max: same logic
            if (Object.prototype.hasOwnProperty.call(desiredCommon, 'max')) {
                newCommon.max = desiredCommon.max;
            } else {
                if (Object.prototype.hasOwnProperty.call(newCommon, 'max')) {
                    delete newCommon.max;
                }
            }

            // states
            if (Object.prototype.hasOwnProperty.call(desiredCommon, 'states')) {
                newCommon.states = desiredCommon.states;
            } else {
                // if desiredCommon has no states, do nothing: keep existing states if any
            }

            // Only update the object if newCommon differs from existingCommon.
            // Minimal deep-check for properties we care about:
            let needUpdate = false;
            const keysToCheck = ['name', 'type', 'read', 'write', 'unit', 'role', 'min', 'max', 'states'];
            for (const k of keysToCheck) {
                const a = existingCommon[k];
                const b = newCommon[k];
                const same =
                    typeof a === 'object' && typeof b === 'object'
                        ? JSON.stringify(a) === JSON.stringify(b)
                        : String(a) === String(b);
                if (!same) {
                    needUpdate = true;
                    break;
                }
            }

            if (needUpdate) {
                // Use extendObject to update only the common part
                adapter.extendObject(id, { common: newCommon }, err2 => {
                    if (err2) {
                        adapter.log &&
                            adapter.log.error &&
                            adapter.log.error(`createISGCommands: extendObject failed for ${id}: ${err2}`);
                    }
                    // Always set the state value after ensuring object exists/updated
                    adapter.setState(id, { val: valValue, ack: true });
                });
            } else {
                // No update required; just set the state value
                adapter.setState(id, { val: valValue, ack: true });
            }
        }
    });
}

/* -------------------------
   Get & parse commands page
   ------------------------- */

async function getIsgCommands(sidePath) {
    try {
        const $ = await getHTML(sidePath);
        if ($) {
            let group;
            try {
                group = $('#sub_nav')
                    .children()
                    .first()
                    .text()
                    .replace(/[-/]+/g, '_')
                    .replace(/[ .]+/g, '')
                    .replace(/[\u00df]+/g, 'SS');
            } catch (e) {
                adapter.log.error('#sub_nav error:');
                adapter.log.error(e);
                group = 'Allgemein';
            }

            const submenu = $.html().match(/#subnavactivename"\)\.html\('(.*?)'/);
            let submenupath = '';

            if (String(sidePath) === '0') {
                // parse infographics on start page
                let scriptValues = null;
                try {
                    scriptValues = $('#buehne').next().next().get()[0].children[0].data;
                } catch {
                    try {
                        scriptValues = $('#buehne').next().next().next().get()[0].children[0].data;
                    } catch {
                        scriptValues = null;
                    }
                }
                if (scriptValues) {
                    const regexp = /charts\[(\d)\]\['([\w]*)'\]\s*= [[]{1}(.*?)\];{1}/gm;
                    let graphsValues;
                    const group = 'ANLAGE.STATISTIK';
                    do {
                        graphsValues = regexp.exec(scriptValues);
                        if (graphsValues) {
                            const tabs = $(`#tab${graphsValues[1]}`).find('h3').text().split('in ');
                            const valueName = tabs[0];
                            const graphUnit = tabs[1];
                            const valThisType = 'number';
                            let valueArray = [];
                            let values = graphsValues[3].substring(1, graphsValues[3].length - 1);
                            valueArray = values.split('],[');
                            let prevValue;
                            valueArray.forEach(function (item) {
                                const valueact = item.split(',');
                                const key = `${valueName}_${graphsValues[2]}`;
                                const value = parseInt(valueact[1]);

                                let valueRole;
                                if (key.search('temperatur') > -1 || key.search('frost') > -1) {
                                    valueRole = 'value.temperature';
                                } else if (key.search('energie') > -1) {
                                    valueRole = 'value.power.consumption';
                                } else {
                                    valueRole = 'indicator.state';
                                }

                                if (prevValue !== valueact[0]) {
                                    updateState(
                                        `${translateName('info')}.${group}.${valueName.toLocaleUpperCase()}.LATEST_VALUE`,
                                        key.toLocaleUpperCase(),
                                        valueName,
                                        valThisType,
                                        graphUnit,
                                        valueRole,
                                        value,
                                    );
                                }
                                prevValue = valueact[0];

                                updateState(
                                    `${translateName('info')}.${group}.${valueName.toLocaleUpperCase()}.${valueact[0]
                                        .slice(1, valueact[0].length - 1)
                                        .toLocaleUpperCase()}`,
                                    key.toLocaleUpperCase(),
                                    valueName,
                                    valThisType,
                                    graphUnit,
                                    valueRole,
                                    value,
                                );
                            });
                        }
                    } while (graphsValues);
                }
            }

            // parse inputs and command widgets
            $('#werte')
                .find('input')
                .each(function (_i, el) {
                    try {
                        if (String(sidePath) === '0') {
                            let valCommand;
                            let idCommand;
                            let statesCommand = '';
                            const nameCommand = $(el).parent().parent().find('h3').text();
                            if (nameCommand == 'Betriebsart') {
                                const idStartCommand = $(el).attr('name');
                                if (idStartCommand && idStartCommand.match(/aval/)) {
                                    statesCommand = '{';
                                    $(el)
                                        .parent()
                                        .parent()
                                        .parent()
                                        .parent()
                                        .find('div.values')
                                        .each(function (_j, ele) {
                                            $(ele)
                                                .find('input')
                                                .each(function (_k, elem) {
                                                    idCommand = $(elem).attr('name');
                                                    if (!(idCommand.match(/aval/) || idCommand.match(/info/))) {
                                                        if (idCommand.match(/[0-9]s/)) {
                                                            if (statesCommand !== '{') {
                                                                statesCommand += ',';
                                                            }
                                                            statesCommand += `"${$(elem).attr('value')}":"${$(elem).next().text()}"`;
                                                        } else {
                                                            valCommand = $(elem).attr('value');
                                                            valCommand = parseFloat(
                                                                valCommand.replace(',', '.').replace(' ', ''),
                                                            );
                                                        }
                                                    }
                                                });
                                        });
                                    statesCommand += '}';
                                    createISGCommands(
                                        translateName('start'),
                                        idCommand,
                                        nameCommand,
                                        'number',
                                        '',
                                        'level',
                                        valCommand,
                                        statesCommand,
                                        '',
                                        '',
                                    );
                                }
                            }
                        } else if ($(this).parent().find('div.black').html()) {
                            $(this)
                                .parent()
                                .find('div.black')
                                .each(function (_j, ele) {
                                    const nameCommand = $(ele).parent().parent().parent().find('h3').text();
                                    const idCommand = $(ele).find('input').attr('name');
                                    let valCommand;

                                    let statesCommand = '{';
                                    $(ele)
                                        .find('input')
                                        .each(function (_j, el) {
                                            if (statesCommand !== '{') {
                                                statesCommand += ',';
                                            }
                                            statesCommand += `"${$(el).attr('value')}":"${$(el).attr('alt')}"`;

                                            if ($(el).attr('checked') == 'checked') {
                                                valCommand = $(el).attr('value');
                                                valCommand = parseFloat(valCommand.replace(',', '.').replace(' ', ''));
                                            }
                                        });
                                    statesCommand += '}';
                                    if (submenu) {
                                        submenupath = '';
                                        submenupath += `.${submenu[1]}`;
                                    }
                                    createISGCommands(
                                        `${translateName('settings')}.${group}${submenupath}`,
                                        idCommand,
                                        nameCommand,
                                        'number',
                                        '',
                                        'level',
                                        valCommand,
                                        statesCommand,
                                        '',
                                        '',
                                    );
                                });
                        } else {
                            const parentsClass = $(el).parent().attr('class');
                            let scriptValues;

                            if (parentsClass == 'current') {
                                $(el)
                                    .parent()
                                    .parent()
                                    .find('div.black')
                                    .each(function (_j, ele) {
                                        const nameCommand = $(ele)
                                            .parent()
                                            .parent()
                                            .parent()
                                            .parent()
                                            .find('h3')
                                            .text();
                                        const idCommand = $(ele).parent().find('input').attr('id');
                                        let valCommand;

                                        $(ele)
                                            .parent()
                                            .find('input')
                                            .each(function (_j, inp) {
                                                if ($(inp).attr('checked') == 'checked') {
                                                    valCommand = $(inp).attr('value');
                                                    valCommand = parseFloat(
                                                        valCommand.replace(',', '.').replace(' ', ''),
                                                    );
                                                }
                                            });
                                        if (submenu) {
                                            submenupath = '';
                                            submenupath += `.${submenu[1]}`;
                                        }
                                        updateState(
                                            `${translateName('settings')}.${group}${submenupath}`,
                                            idCommand,
                                            translateName(nameCommand),
                                            'number',
                                            '',
                                            'level',
                                            valCommand,
                                        );
                                    });
                            } else {
                                let parentsID = $(el).parent().attr('id') || '';
                                if (parentsID === undefined) {
                                    parentsID = '';
                                }

                                if (parentsID.includes('chval')) {
                                    try {
                                        scriptValues = $(el).parent().parent().next().next().next().get()[0]
                                            .children[0].data;
                                    } catch {
                                        try {
                                            scriptValues = $(el).parent().parent().next().next().next().text();
                                        } catch {
                                            scriptValues = null;
                                        }
                                    }

                                    if (scriptValues) {
                                        const nameCommand = $(el).parent().parent().parent().find('h3').text();
                                        const minCommand = scriptValues.match(/\['min'] = '(.*?)'/);
                                        const maxCommand = scriptValues.match(/\['max'] = '(.*?)'/);
                                        const valCommand = scriptValues.match(/\['val']='(.*?)'/);
                                        const idCommand = scriptValues.match(/\['id']='(.*?)'/);
                                        const unitCommand = $(el).parent().parent().parent().find('.append-1').text();

                                        if (idCommand) {
                                            if (submenu) {
                                                submenupath = '';
                                                submenupath += `.${submenu[1]}`;
                                            }
                                            createISGCommands(
                                                `${translateName('settings')}.${group}${submenupath}`,
                                                idCommand[1],
                                                nameCommand,
                                                'number',
                                                unitCommand,
                                                'state',
                                                parseFloat(
                                                    valCommand ? valCommand[1].replace(',', '.').replace(' ', '') : NaN,
                                                ),
                                                '',
                                                parseFloat(
                                                    minCommand ? minCommand[1].replace(',', '.').replace(' ', '') : NaN,
                                                ),
                                                parseFloat(
                                                    maxCommand ? maxCommand[1].replace(',', '.').replace(' ', '') : NaN,
                                                ),
                                            );
                                        }
                                    }
                                } else {
                                    try {
                                        scriptValues = $(el).next().get()[0].children[0].data;
                                    } catch {
                                        try {
                                            scriptValues = $(el).next().text();
                                        } catch {
                                            scriptValues = null;
                                        }
                                    }

                                    if (scriptValues) {
                                        const nameCommand = $(el).parent().parent().find('h3').text();

                                        const minCommand = scriptValues.match(/\['min'] = '(.*?)'/);
                                        const maxCommand = scriptValues.match(/\['max'] = '(.*?)'/);
                                        const valCommand = scriptValues.match(/\['val']='(.*?)'/);
                                        const idCommand = scriptValues.match(/\['id']='(.*?)'/);
                                        const unitCommand = $(el).parent().parent().find('.append-1').text();

                                        if (idCommand) {
                                            if (submenu) {
                                                submenupath = '';
                                                submenupath += `.${submenu[1]}`;
                                            }
                                            createISGCommands(
                                                `${translateName('settings')}.${group}${submenupath}`,
                                                idCommand[1],
                                                nameCommand,
                                                'number',
                                                unitCommand,
                                                'state',
                                                parseFloat(
                                                    valCommand ? valCommand[1].replace(',', '.').replace(' ', '') : NaN,
                                                ),
                                                '',
                                                parseFloat(
                                                    minCommand ? minCommand[1].replace(',', '.').replace(' ', '') : NaN,
                                                ),
                                                parseFloat(
                                                    maxCommand ? maxCommand[1].replace(',', '.').replace(' ', '') : NaN,
                                                ),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    } catch (errInner) {
                        adapter.log.debug(`getIsgCommands input-parse error: ${errInner.message || errInner}`);
                    }
                });
        }
    } catch (e) {
        adapter.log.debug(`getIsgCommands(${sidePath}) error: ${e.message || e}`);
    }
}

/* -------------------------
   Sending queued commands (debounced)
   ------------------------- */

function setIsgCommands(strKey, strValue) {
    const newCommand = { name: strKey, value: strValue };
    commands.push(newCommand);

    const payload = querystring.stringify({
        user: adapter.config.isgUser,
        pass: adapter.config.isgPassword,
        data: JSON.stringify(commands),
    });

    clearTimeout(CommandTimeout);
    CommandTimeout = setTimeout(async function () {
        const fetch = getFetch();
        const built = buildFetchOptions(`${host}/save.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: '*/*',
            },
            body: payload,
        });

        try {
            const res = await fetch(`${host}/save.php`, built.options);
            built.clearTimeout();
            if (res && res.status == 200) {
                commandPaths.forEach(function (item) {
                    schedule(() => getIsgCommands(item));
                });
            } else {
                adapter.log.error(`statusCode: ${res ? res.status : 'no response'}`);
                adapter.log.error(`statusText: ${res ? res.statusText : ''}`);
            }
        } catch (error) {
            built.clearTimeout();
            if (error && (error.name === 'AbortError' || String(error).toLowerCase().includes('aborted'))) {
                adapter.log.debug(`setIsgCommands aborted: ${error.message || error}`);
            } else {
                adapter.log.error(`Error: ${error.message || error}`);
            }
        }
        commands = [];
    }, 5000);
}

/* -------------------------
   Reboot / main loop
   ------------------------- */

function rebootISG() {
    const url = `${host}/reboot.php`;
    const fetch = getFetch();
    const built = buildFetchOptions(url, { method: 'GET' });

    fetch(url, built.options)
        .then(() => {
            built.clearTimeout();
            adapter.log.info('Reboot request sent to ISG.');
        })
        .catch(err => {
            built.clearTimeout();
            if (err && (err.name === 'AbortError' || String(err).toLowerCase().includes('aborted'))) {
                adapter.log.debug(`rebootISG aborted: ${err.message || err}`);
            } else {
                adapter.log.error(`Reboot request failed: ${err.message || err}`);
            }
        });
}

function main() {
    adapter.setObjectNotExists(
        'ISGReboot',
        {
            type: 'state',
            common: {
                name: translateName('ISGReboot'),
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
            },
            native: {},
        },
        () => adapter.subscribeStates('ISGReboot'),
    );

    const ipformat =
        /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const fqdnformat = /^(?!:\/\/)(?=.{1,255}$)((.{1,63}\.){1,127}(?![0-9]*$)[a-z0-9-]+\.?)$/;

    if (!adapter.config.isgAddress || adapter.config.isgAddress.trim() === '') {
        adapter.log.error('Invalid configuration - isgAddress not set.');
        adapter.setState('info.connection', false, true);
        return;
    } else if (!adapter.config.isgAddress.match(ipformat) && !adapter.config.isgAddress.match(fqdnformat)) {
        adapter.log.error(
            `ISG Address ${adapter.config.isgAddress} format not valid. Should be e.g. 192.168.123.123 or servicewelt.fritz.box`,
        );
        return;
    }

    host = adapter.config.isgAddress.trim();
    if (!/^\s*https?:\/\//i.test(host)) {
        host = `http://${host}`;
    }
    adapter.log.info(`Connecting to ISG: ${host} ...`);

    // remove trailing slashes
    // host = host.replace(/\/+$/, '');

    adapter.subscribeStates('*');

    // schedule initial fetches with concurrency control
    statusPaths.forEach(function (item) {
        schedule(() => getIsgStatus(item));
    });

    valuePaths.forEach(function (item) {
        schedule(() => getIsgValues(item));
    });

    commandPaths.forEach(function (item) {
        schedule(() => getIsgCommands(item));
    });

    if (isgIntervall) {
        clearInterval(isgIntervall);
    }
    if (isgCommandIntervall) {
        clearInterval(isgCommandIntervall);
    }

    isgIntervall = setInterval(
        function () {
            valuePaths.forEach(function (item) {
                schedule(() => getIsgValues(item));
            });
            statusPaths.forEach(function (item) {
                schedule(() => getIsgStatus(item));
            });
        },
        Math.max(1, Number(adapter.config.isgIntervall) || 60) * 1000,
    );

    isgCommandIntervall = setInterval(
        function () {
            commandPaths.forEach(function (item) {
                schedule(() => getIsgCommands(item));
            });
        },
        Math.max(1, Number(adapter.config.isgCommandIntervall) || 60) * 1000,
    );
}

/* -------------------------
   Adapter lifecycle
   ------------------------- */

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'stiebel-isg',
        stateChange: function (id, state) {
            const command = id.split('.').pop();
            if (!state || state.ack) {
                return;
            }

            if (command == 'ISGReboot') {
                adapter.log.info('ISG rebooting');
                rebootISG();
                setTimeout(main, 60000);
                return;
            }

            setIsgCommands(command, state.val);
        },
        ready: function () {
            adapter.getForeignObject('system.config', function (err, obj) {
                if (err) {
                    adapter.log.error(err);
                    if (obj) {
                        adapter.log.error(`statusCode: ${obj.statusCode}`);
                        adapter.log.error(`statusText: ${obj.statusText}`);
                    }
                    return;
                } else if (obj) {
                    if (!obj.common.language) {
                        adapter.log.info('Language not set. English set therefore.');
                        nameTranslation = require('./admin/i18n/en/translations.json');
                    } else {
                        systemLanguage = obj.common.language;
                        try {
                            nameTranslation = require(`./admin/i18n/${systemLanguage}/translations.json`);
                        } catch {
                            adapter.log.warn(`Translations for ${systemLanguage} not found, falling back to English.`);
                            nameTranslation = require('./admin/i18n/en/translations.json');
                        }
                    }

                    // set cookie jar
                    setJar(new tough.CookieJar());
                    // Reset the connection indicator during startup
                    adapter.setState('info.connection', false, true);

                    // read concurrency configuration (default 3)
                    try {
                        const cfgVal = Number(adapter.config.maxConcurrentFetches);
                        if (!isNaN(cfgVal) && cfgVal > 0) {
                            maxConcurrentFetches = cfgVal;
                        } else {
                            maxConcurrentFetches = 3;
                        }
                    } catch {
                        maxConcurrentFetches = 3;
                    }

                    main();
                }
            });

            commandPaths = (adapter.config.isgCommandPaths || '').split(';').filter(Boolean);
            valuePaths = (adapter.config.isgValuePaths || '').split(';').filter(Boolean);
            statusPaths = (adapter.config.isgStatusPaths || '').split(';').filter(Boolean);

            if (adapter.config.isgExpert === true && adapter.config.isgExpertPaths) {
                commandPaths = commandPaths.concat(adapter.config.isgExpertPaths.split(';').filter(Boolean));
            }
        },
        unload: function (callback) {
            try {
                if (isgIntervall) {
                    clearInterval(isgIntervall);
                }
                if (isgCommandIntervall) {
                    clearInterval(isgCommandIntervall);
                }
                if (CommandTimeout) {
                    clearTimeout(CommandTimeout);
                }
                adapter.log.info('cleaned everything up...');
                callback();
            } catch {
                callback();
            }
        },
    });

    adapter = new utils.Adapter(options);
    return adapter;
}

/* -------------------------
   Export / start
   ------------------------- */

if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
