# Start Minimized acceptance test

Run these checks with an installed production build on each supported desktop OS. Development builds intentionally reject enabling Launch at Startup. Record the OS, build version, and pass or fail for each case.

| Setup | Action | Expected result |
| --- | --- | --- |
| Launch at Startup on; Start Minimized off | Sign out and sign in | Main window appears and receives focus. |
| Both switches on | Sign out and sign in | Windows: main window is minimized in the taskbar. macOS: no main window appears; the menu bar or Dock can open it. Linux: no main window appears; the tray can open it. |
| Both switches on | Quit the app, then open it manually | Main window appears and receives focus. |
| Both switches on | Hide or minimize the running window, then start a second instance with `--autostart` | Existing window stays hidden or minimized. |
| Both switches on | Start a second instance manually | Existing window appears and receives focus. |
| Both switches on | Disable Launch at Startup, then enable it again | Start Minimized remains on; the next automatic launch uses it. |
| Both switches on | Save a maximized or fullscreen window state, then sign out and sign in | Automatic launch does not briefly expose the saved window state. |

On macOS and Linux, repeat the automatic-launch case with the tray or menu-bar icon unavailable. The main window must appear so the app remains accessible. On macOS, also confirm a Dock reopen opens the hidden window.

For an upgrade from a release that registered startup without `--autostart`, leave Launch at Startup enabled during installation. After the upgraded app has run once, sign out and sign in. Start Minimized must take effect without toggling Launch at Startup off and on.
