//! AppKit's Hide Others action, called only by the owned main-thread dispatcher.
use std::ffi::{c_char, c_void};

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

pub(super) fn hide_others() {
    // SAFETY: both selectors are public NSApplication methods, invoked on the
    // main thread with their exact Objective-C signatures and a nil sender.
    unsafe {
        let shared: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let hide: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let app = shared(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        hide(
            app,
            sel_registerName(c"hideOtherApplications:".as_ptr()),
            std::ptr::null_mut(),
        );
    }
}
