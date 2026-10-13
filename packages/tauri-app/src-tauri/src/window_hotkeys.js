(() => {
  // Installed only on owned primary/Preferences builders, never preview guests.
  if (window.top !== window) return
  const actions = __NATIVE_ACTIONS__
  let current
  let pending = Promise.resolve()
  Object.defineProperty(window, '__CODENOMAD_SET_NATIVE_HOTKEYS__', { value(snapshot, generation) {
    if (current && generation < current.generation) return false
    current = { snapshot, generation }
    return true
  } })
  const aliases = { esc: 'escape', space: ' ', spacebar: ' ', bracketleft: '[', bracketright: ']', '{': '[', '}': ']' }
  const canonical = key => /^digit[0-9]$/i.test(key) ? key.slice(-1)
    : Object.prototype.hasOwnProperty.call(aliases, key.toLowerCase()) ? aliases[key.toLowerCase()] : key.toLowerCase()
  function matches(binding, event) {
    // Same single identity as renderer capture/matching/conflict detection.
    const code = event.code ?? ''
    const key = /^(?:Digit[0-9]|BracketLeft|BracketRight)$/i.test(code) ? canonical(code) : canonical(event.key)
    return key === canonical(binding.key)
      && event.ctrlKey === binding.ctrl && event.metaKey === binding.meta
      && event.shiftKey === binding.shift && event.altKey === binding.alt
  }
  window.addEventListener('keydown', event => {
    if (!current || event.isTrusted === false || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
    // Leave recording input delivery intact. The accepted native map blocks
    // every queued invocation as well as menu actions before the UI gets its ack.
    if (current.snapshot.recording) return
    const action = actions.find(id => current.snapshot.bindings[id].some(binding => matches(binding, event)))
    if (!action) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    const generation = current.generation
    pending = pending.then(async () => {
      if (current.generation !== generation || current.snapshot.recording) return
      await window.__TAURI_INTERNALS__?.invoke('native_hotkey_action', { action, generation })
    }).catch(() => { /* Never retry a native mutation or fall back to browser actions. */ })
  }, { capture: true })
})()
