// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes("'use strict'"));

// Only DOM/timer/storage boundaries are doubled; execute the complete game script.
function createGame() {
    const elements = new Map();
    const storage = new Map();
    const timers = new Map();
    const documentListeners = new Map();
    let timerId = 0;
    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                value: '', textContent: '0', innerHTML: '', style: {}, listeners: {}, dataset: {},
                classList: {
                    add: name => classes.add(name), remove: name => classes.delete(name),
                    contains: name => classes.has(name),
                    toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
                },
                addEventListener(type, handler) { this.listeners[type] = handler; },
                focus() {}, select() {}, querySelector: () => null, querySelectorAll: () => [],
                setAttribute() {}
            });
        }
        return elements.get(id);
    }
    const context = vm.createContext({
        document: {
            documentElement: { lang: 'en' }, getElementById: element,
            querySelectorAll: () => [], querySelector: () => null,
            addEventListener(type, handler) { documentListeners.set(type, handler); },
            dispatchEvent(event) { documentListeners.get(event.type)?.(event); }
        },
        addEventListener() {}, CustomEvent: class { constructor(type) { this.type = type; } },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}, console
    });
    // Load the same shared language scripts that the browser loads before the game.
    for (const file of ['translations.js', 'i18n.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    vm.runInContext(script, context);
    vm.runInContext(`state.players = [
        { name: '张三', stack: 980, bet: 20, folded: false, handContrib: 20 },
        { name: '李四', stack: 0, bet: 1000, folded: false, handContrib: 1000 }
    ]; state.roundActive = true; state.pot = 1020; state.currentBet = 1000;
    state.toAct = new Set([0]); state.handHistory = [{hand: 1, winner: '张三', amount: 40}];
    render();`, context);
    return {
        element,
        language(value) { context.I18n.setLanguage(value); },
        snapshot: () => JSON.parse(vm.runInContext('JSON.stringify(serializeState())', context)),
        open(idx = 0) {
            const button = { dataset: { action: 'rename', idx: String(idx) } };
            element('players').listeners.click({ target: { closest: () => button } });
        },
        remove(idx) {
            const button = { dataset: { action: 'remove', idx: String(idx) } };
            element('players').listeners.click({ target: { closest: () => button } });
        },
        idle(buttonPosition = 0) {
            vm.runInContext(`state.roundActive = false; state.buttonPosition = ${buttonPosition}; render();`, context);
        },
        save(name, key) {
            element('renamePlayerName').value = name;
            if (key) element('renamePlayerModal').listeners.keydown({ key, isComposing: false, preventDefault() {} });
            else element('confirmRename').onclick();
        },
        flush() { for (const callback of [...timers.values()]) callback(); timers.clear(); },
        restore() { vm.runInContext('loadSavedState(); render();', context); }
    };
}

test('removing a player with chips before a hand preserves the other player and dealer', () => {
    const game = createGame();
    game.idle(1);
    game.element('playerName').value = '王五';
    game.element('playerStack').value = '1000';
    game.element('addPlayer').onclick();
    game.remove(0);
    assert.deepEqual(game.snapshot().players, [
        { name: '李四', stack: 0, bet: 1000, folded: false, handContrib: 1000 },
        { name: '王五', stack: 1000, bet: 0, folded: false, handContrib: 0 }
    ]);
    assert.equal(game.snapshot().buttonPosition, 0);
    game.flush();
    game.restore();
    assert.equal(game.snapshot().players.length, 2);
});

test('removing a player during a hand is rejected without changing game state', () => {
    const game = createGame();
    const before = game.snapshot();
    game.remove(0);
    assert.deepEqual(game.snapshot(), before);
});

test('deleting the last player leaves an empty table with a valid dealer index', () => {
    const game = createGame();
    game.idle();
    game.remove(1);
    game.remove(0);
    assert.deepEqual(game.snapshot().players, []);
    assert.equal(game.snapshot().buttonPosition, 0);
});

test('clicking a player name opens an editor with the existing name', () => {
    const game = createGame();
    game.open();
    assert.equal(game.element('renamePlayerModal').classList.contains('active'), true);
    assert.equal(game.element('renamePlayerName').value, '张三');
});

test('renaming during a hand persists only the name and updates the active-player banner', () => {
    const game = createGame();
    const before = game.snapshot();
    game.open();
    game.save('  小明-1  ');
    before.players[0].name = '小明-1';
    assert.deepEqual(game.snapshot(), before);
    assert.equal(game.element('currentPlayerName').textContent, '小明-1');
    game.flush();
    game.restore();
    assert.deepEqual(game.snapshot(), before);
});

test('Enter saves the selected player, including a player with no chips', () => {
    const game = createGame();
    game.open(1);
    game.save('Alice_2', 'Enter');
    assert.equal(game.snapshot().players[1].name, 'Alice_2');
    assert.equal(game.snapshot().players[1].stack, 0);
});

test('cancel discards the name draft', () => {
    const game = createGame();
    game.open();
    game.element('renamePlayerName').value = '未保存';
    game.element('cancelRename').onclick();
    assert.equal(game.snapshot().players[0].name, '张三');
    assert.equal(game.element('renamePlayerModal').classList.contains('active'), false);
});

test('switching languages during a hand preserves game state and an open name draft', () => {
    const game = createGame();
    const before = game.snapshot();
    game.open();
    game.element('renamePlayerName').value = '未保存草稿';
    game.language('zh-CN');
    assert.deepEqual(game.snapshot(), before);
    assert.equal(game.element('renamePlayerName').value, '未保存草稿');
    assert.equal(game.element('renamePlayerModal').classList.contains('active'), true);
    assert.equal(game.element('callBtn').textContent, '跟注 980');
    game.language('en');
    assert.deepEqual(game.snapshot(), before);
    assert.equal(game.element('callBtn').textContent, 'Call 980');
});

for (const name of ['   ', '<b>小明</b>', '名'.repeat(21)]) {
    test(`invalid name ${JSON.stringify(name)} cannot replace the saved name`, () => {
        const game = createGame();
        game.open();
        game.save(name);
        assert.equal(game.snapshot().players[0].name, '张三');
        assert.equal(game.element('renamePlayerModal').classList.contains('active'), true);
        assert.ok(game.element('toast').textContent.length > 0);
    });
}
