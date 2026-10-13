// Executes the production native initialization script without opening an app.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
const source = fs.readFileSync(new URL('../src-tauri/src/window_hotkeys.js', import.meta.url), 'utf8')
const protocol = JSON.parse(fs.readFileSync(new URL('../../ui/src/lib/native/hotkeys-protocol.json', import.meta.url), 'utf8'))
const actions = protocol.actions.filter(id => !['new-instance', 'open-command-palette'].includes(id))
const binding = (key, modifiers = {}) => ({ key, ctrl: false, meta: false, shift: false, alt: false, ...modifiers })
const snapshot = (bindings = {}, recording = false) => ({ version: protocol.version, recording, bindings: Object.fromEntries(protocol.actions.map(id => [id, bindings[id] ?? []])) })
function harness(child = false) {
  const packets = [], handlers = []
  const window = { addEventListener(type, handler) { assert.equal(type, 'keydown'); handlers.push(handler) }, __TAURI_INTERNALS__: { async invoke(command, payload) { packets.push({ command, ...payload }) } } }
  window.top = child ? {} : window
  vm.runInNewContext(source.replace('__NATIVE_ACTIONS__', JSON.stringify(actions)), { window, Promise, Object })
  const emit = values => {
    const event = { key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isTrusted: true, defaultPrevented: false, repeat: false, isComposing: false,
      preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() { this.stopped = true }, ...values }
    for (const handler of handlers) handler(event)
    return event
  }
  const sync = (map, generation = 1) => window.__CODENOMAD_SET_NATIVE_HOTKEYS__(map, generation)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return { window, packets, emit, sync, flush, handlers }
}
test('empty boot, configured keys, reset/unassigned map and renderer-owned keys', async () => {
  const h = harness()
  assert.equal(h.emit({ key: 'F11' }).defaultPrevented, false)
  h.sync(snapshot({ 'window-fullscreen': [binding('f11')], 'new-instance': [binding('n', { ctrl: true })] }))
  assert.equal(h.emit({ key: 'F11' }).defaultPrevented, true)
  assert.equal(h.emit({ key: 'n', ctrlKey: true }).defaultPrevented, false)
  await h.flush()
  assert.deepEqual(h.packets, [{ command: 'native_hotkey_action', action: 'window-fullscreen', generation: 1 }])
  h.sync(snapshot(), 2)
  assert.equal(h.sync(snapshot({ 'window-fullscreen': [binding('f11')] }), 1), false)
  assert.equal(h.emit({ key: 'F11' }).defaultPrevented, false)
  await h.flush(); assert.equal(h.packets.length, 1)
})
test('capture delivers keys but suppresses pending mutations before acknowledgment', async () => {
  const h = harness(), map = { 'window-close': [binding('w', { ctrl: true, alt: true })] }
  h.sync(snapshot(map))
  h.emit({ key: 'w', ctrlKey: true, altKey: true })
  assert.equal(h.sync(snapshot(map, true), 2), true)
  assert.equal(h.emit({ key: 'w', ctrlKey: true, altKey: true }).defaultPrevented, false)
  await h.flush(); assert.equal(h.packets.length, 0)
  h.sync(snapshot(map), 3)
  h.emit({ key: 'w', ctrlKey: true, altKey: true })
  await h.flush(); assert.equal(h.packets[0].generation, 3)
})
test('exact modifiers, logical numpad and physical identities, repeated/synthetic/IME/handled events', async () => {
  const h = harness()
  h.sync(snapshot({ 'window-zoom-in': [binding('=', { ctrl: true }), binding('+', { ctrl: true, shift: true }), binding('+', { ctrl: true })],
    'window-zoom-reset': [binding('0', { ctrl: true })], 'window-new': [binding('n', { meta: true, alt: true })] }))
  for (const values of [{ key: '=', ctrlKey: true }, { key: '+', shiftKey: true, ctrlKey: true }, { key: '+', code: 'NumpadAdd', ctrlKey: true },
    { key: 'à', code: 'Digit0', ctrlKey: true }, { key: 'N', metaKey: true, altKey: true }]) {
    assert.equal(h.emit(values).defaultPrevented, true); await h.flush()
  }
  for (const extra of [{ altKey: true }, { metaKey: true }, { shiftKey: true }, { isTrusted: false }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) h.emit({ key: '=', ctrlKey: true, ...extra })
  assert.equal(h.emit({ key: '=', ctrlKey: true, repeat: true }).defaultPrevented, true)
  await h.flush(); assert.equal(h.packets.length, 5)
})
test('non-US physical identities exclude legacy layout symbols and arbitrary code aliases (#1)', async () => {
  for (const [key, code, physical] of [['&', 'Digit1', '1'], ['ü', 'BracketLeft', '['], ['!', 'Digit1', '1']]) {
    const h = harness(), shift = key === '!'
    h.sync(snapshot({ 'window-new': [binding(key, { ctrl: true, shift })], 'window-close': [binding(physical, { ctrl: true, shift })] }))
    h.emit({ key, code, ctrlKey: true, shiftKey: shift }); await h.flush()
    assert.deepEqual(h.packets.map(packet => packet.action), ['window-close'], 'one identity, not legacy key OR physical code')
    h.sync(snapshot({ 'window-new': [binding(key, { ctrl: true, shift })] }), 2)
    assert.equal(h.emit({ key, code, ctrlKey: true, shiftKey: shift }).defaultPrevented, false)
    assert.equal(h.emit({ key, code: 'Quote', ctrlKey: true, shiftKey: shift }).defaultPrevented, true)
    await h.flush(); assert.equal(h.packets[1].action, 'window-new')
  }
  const h = harness()
  h.sync(snapshot({ 'window-new': [binding('z', { ctrl: true })], 'window-close': [binding('KeyY', { ctrl: true })] }))
  h.emit({ key: 'z', code: 'KeyY', ctrlKey: true }); await h.flush()
  assert.deepEqual(h.packets.map(packet => packet.action), ['window-new'], 'ordinary letters stay logical')
})
test('replacement fences queued keys; rejected invokes are never replayed', async () => {
  const h = harness(), map = snapshot({ 'window-fullscreen': [binding('f11')] })
  h.sync(map); h.emit({ key: 'F11' }); h.sync(map, 2)
  await h.flush(); assert.equal(h.packets.length, 0)
  h.window.__TAURI_INTERNALS__.invoke = async () => { throw Error('denied') }
  h.emit({ key: 'F11' }); await h.flush()
  h.window.__TAURI_INTERNALS__.invoke = async (command, payload) => h.packets.push({ command, ...payload })
  h.emit({ key: 'F11' }); await h.flush(); assert.equal(h.packets.length, 1)
})
test('subframes install neither keyboard route nor synchronization hook', () => {
  const h = harness(true)
  assert.equal(h.handlers.length, 0); assert.equal(h.window.__CODENOMAD_SET_NATIVE_HOTKEYS__, undefined)
})
test('Mac Hide defaults, remap, reset and explicit disable retain one route and capture suppresses queued hiding', async () => {
  const h = harness()
  const defaults = { 'window-hide': [binding('h', { meta: true })], 'window-hide-others': [binding('h', { meta: true, alt: true })] }
  h.sync(snapshot(defaults))
  h.emit({ key: 'h', metaKey: true }); h.emit({ key: 'h', metaKey: true, altKey: true })
  await h.flush()
  assert.deepEqual(h.packets.map(packet => packet.action), ['window-hide', 'window-hide-others'])
  h.sync(snapshot({ 'window-hide': [binding('f9')], 'window-hide-others': [] }), 2)
  assert.equal(h.emit({ key: 'h', metaKey: true }).defaultPrevented, false)
  assert.equal(h.emit({ key: 'h', metaKey: true, altKey: true }).defaultPrevented, false)
  h.emit({ key: 'F9' }); await h.flush()
  assert.equal(h.packets[2].action, 'window-hide')
  h.sync(snapshot(defaults), 3)
  h.emit({ key: 'h', metaKey: true }); await h.flush()
  assert.equal(h.packets[3].action, 'window-hide')
  h.sync(snapshot({ 'window-hide': [], 'window-hide-others': [] }), 4)
  assert.equal(h.emit({ key: 'h', metaKey: true }).defaultPrevented, false)
  assert.equal(h.emit({ key: 'h', metaKey: true, altKey: true }).defaultPrevented, false)
  h.sync(snapshot(defaults), 5)
  h.emit({ key: 'h', metaKey: true })
  h.sync(snapshot(defaults, true), 6)
  assert.equal(h.emit({ key: 'h', metaKey: true }).defaultPrevented, false)
  assert.equal(h.emit({ key: 'h', metaKey: true, altKey: true }).defaultPrevented, false)
  await h.flush(); assert.equal(h.packets.length, 4)
})
test('native host has no menu/global/legacy keyboard accelerator route', () => {
  const main = fs.readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /global_shortcut|fullscreen_shortcut|Some\("(?:Cmd|Ctrl|Alt)|\\tCtrl|\\tF11/)
  const menu = main.slice(main.indexOf('fn build_menu('), main.indexOf('#[cfg(any(windows, test))]', main.indexOf('fn build_menu(')))
  assert.doesNotMatch(menu, /\.close_window\(\)|\.minimize\(\)|\.maximize\(\)/)
  assert.doesNotMatch(menu, /\.hide\(\)|\.hide_others\(\)|PredefinedMenuItem::hide/)
  assert.match(menu, /\.text\("hide", "Hide CodeNomad"\)/)
  assert.match(menu, /\.text\("hide_others", "Hide Others"\)/)
  assert.match(main, /native_hotkeys::hide_application\(app_handle, native_hotkeys::Action::WindowHide\)/)
  assert.match(main, /native_hotkeys::hide_application\(app_handle, native_hotkeys::Action::WindowHideOthers\)/)
  const zoom = fs.readFileSync(new URL('../src-tauri/src/window_zoom.js', import.meta.url), 'utf8')
  assert.doesNotMatch(zoom, /addEventListener\('keydown'/)
  for (const file of ['main-window.json', 'preferences-window.json']) {
    const acl = JSON.parse(fs.readFileSync(new URL(`../src-tauri/capabilities/${file}`, import.meta.url)))
    assert.equal(acl.windows?.length ?? 0, 0)
    assert.ok(acl.permissions.includes('allow-set-native-hotkeys') && acl.permissions.includes('allow-native-hotkey-action'))
    assert.ok(!acl.webviews.some(value => value.includes('preview') || value === '*'))
  }
})
