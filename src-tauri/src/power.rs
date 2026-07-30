//! Power-state and connectivity signals for the session-refresh loop.
//!
//! Two things the loop could not see before:
//!
//! 1. **Resume from sleep / standby.** The loop used to be a bare
//!    `tokio::time::sleep(20 min)`, which rides `Instant` (QPC on
//!    Windows). Whether that clock advances across S3 sleep and S0
//!    Modern Standby is not something to bet a session on: if it does
//!    not advance, the timer effectively never fires across a long
//!    standby; if it does, it fires the instant the machine wakes, into
//!    a network stack that has not come back yet. Either way the
//!    snapshot goes stale exactly when users reported being logged out.
//!    `PowerRegisterSuspendResumeNotification` gives us the wake event
//!    directly, with no HWND and no message pump.
//!
//! 2. **Whether there is any internet.** A refresh that runs before the
//!    NIC reassociates fails, and a failed refresh used to cost a full
//!    20-minute cycle. Checking `GetNetworkConnectivityHint` first is a
//!    cheap local call.
//!
//! Non-Windows targets get stubs: the resume signal simply never fires
//! (the loop still runs on its wall-clock deadline) and connectivity is
//! reported as available.

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::Notify;

/// Signalled when the machine wakes from sleep or standby.
///
/// `notify_one` semantics on purpose: a wake that lands while the loop
/// is busy refreshing stores a permit instead of being dropped, so the
/// next `notified().await` returns immediately.
fn resume_notify() -> &'static Arc<Notify> {
    static RESUME: OnceLock<Arc<Notify>> = OnceLock::new();
    RESUME.get_or_init(|| Arc::new(Notify::new()))
}

/// Handle for the refresh loop to await.
pub fn resume_signal() -> Arc<Notify> {
    resume_notify().clone()
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::NetworkManagement::IpHelper::GetNetworkConnectivityHint;
    use windows_sys::Win32::Networking::WinSock::{
        NetworkConnectivityLevelHintConstrainedInternetAccess,
        NetworkConnectivityLevelHintInternetAccess, NL_NETWORK_CONNECTIVITY_HINT,
    };
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    };

    /// Called by the OS on a pool thread. Must be cheap and must not
    /// unwind, so it does nothing but flip a `Notify`.
    unsafe extern "system" fn on_power_event(
        _context: *const core::ffi::c_void,
        event: u32,
        _setting: *const core::ffi::c_void,
    ) -> u32 {
        // PBT_APMRESUMEAUTOMATIC covers unattended wakes too;
        // PBT_APMRESUMESUSPEND only arrives when the wake was
        // user-initiated, and Windows may send either or both.
        if event == PBT_APMRESUMEAUTOMATIC || event == PBT_APMRESUMESUSPEND {
            super::resume_notify().notify_one();
        }
        0 // ERROR_SUCCESS
    }

    pub fn register() -> Result<(), String> {
        // Leaked on purpose: the subscription lives for the whole
        // process, and the OS keeps a pointer to these parameters.
        let params = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: std::ptr::null_mut(),
        }));
        let mut handle: *mut core::ffi::c_void = std::ptr::null_mut();
        let rc = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                params as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS as HANDLE,
                &mut handle,
            )
        };
        if rc != 0 {
            return Err(format!("PowerRegisterSuspendResumeNotification failed: {rc}"));
        }
        Ok(())
    }

    /// `None` when Windows can't tell us (treated as "assume online" by
    /// the caller, so an unknown never blocks a refresh forever).
    pub fn has_internet() -> Option<bool> {
        let mut hint: NL_NETWORK_CONNECTIVITY_HINT = unsafe { std::mem::zeroed() };
        let rc = unsafe { GetNetworkConnectivityHint(&mut hint) };
        if rc != 0 {
            return None;
        }
        // "Constrained" is a captive portal or a metered link that still
        // routes; worth attempting, unlike None/LocalAccess.
        Some(
            hint.ConnectivityLevel == NetworkConnectivityLevelHintInternetAccess
                || hint.ConnectivityLevel
                    == NetworkConnectivityLevelHintConstrainedInternetAccess,
        )
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn register() -> Result<(), String> {
        Ok(())
    }
    pub fn has_internet() -> Option<bool> {
        None
    }
}

/// Subscribe to resume notifications. Safe to call once, from `setup`.
pub fn init() -> Result<(), String> {
    imp::register()
}

/// Best-effort connectivity check. `None` means "can't tell".
pub fn has_internet() -> Option<bool> {
    imp::has_internet()
}

/// Block until the OS reports internet access, or until `timeout`.
///
/// Returns `true` when it is worth attempting a network call: either
/// connectivity was confirmed, or the platform could not tell us (in
/// which case refusing to try would strand the refresh forever).
pub async fn wait_for_network(timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match has_internet() {
            None => return true,
            Some(true) => return true,
            Some(false) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
