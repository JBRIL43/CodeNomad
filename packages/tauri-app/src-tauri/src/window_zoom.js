(() => {
  const platform = __HOST_PLATFORM__
  // Windows keeps native WebView2 wheel/zoom observation. Never attach to
  // subframes, even on WebKit versions that inject initialization scripts there.
  if (platform === 'windows' || window.top !== window) return

  let pending = Promise.resolve()
  function submit(event, action) {
    event.preventDefault()
    event.stopImmediatePropagation()
    // The host reads its current (possibly restored or menu-changed) zoom for
    // every relative action. There is deliberately no renderer zoom counter.
    pending = pending.then(async () => {
      const internals = window.__TAURI_INTERNALS__
      if (typeof internals?.invoke !== 'function') return
      await internals.invoke('owned_webview_zoom', { action })
    }).catch(() => {
      // Bootstrap/untrusted navigation may have no invoke authority. Do not
      // retry or fall back to the generic webview command or browser zoom.
    })
  }

  // Managed keyboard zoom belongs exclusively to window_hotkeys.js. This
  // gesture-only script also serves remote windows, without any fallback keys.
  let lastWheel
  function wheel(event) {
    if (event.defaultPrevented || event.isTrusted === false || !event.ctrlKey || event.altKey) return
    const delta = Number.isFinite(event.deltaY) ? event.deltaY : -event.wheelDelta
    if (!Number.isFinite(delta) || delta === 0) return
    const direction = Math.sign(delta)
    // Keep the pinned runtime's legacy mousewheel route for WebKit, alongside
    // standard wheel. Engines emitting both for the same native gesture must
    // cancel both defaults but request only one host mutation.
    const duplicate = lastWheel && lastWheel.type !== event.type &&
      Number.isFinite(event.timeStamp) && Math.abs(event.timeStamp - lastWheel.timeStamp) <= 8 &&
      lastWheel.direction === direction && lastWheel.x === event.clientX && lastWheel.y === event.clientY
    if (duplicate) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    lastWheel = { type: event.type, timeStamp: event.timeStamp, direction, x: event.clientX, y: event.clientY }
    submit(event, delta < 0 ? 'in' : 'out')
  }
  window.addEventListener('wheel', wheel, { capture: true, passive: false })
  window.addEventListener('mousewheel', wheel, { capture: true, passive: false })
})()
