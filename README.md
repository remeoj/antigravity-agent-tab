# Antigravity Agent Floating Window (`antigravity-agent-tab`)

A lightweight extension for **Antigravity IDE** that lets you detach the right-hand Antigravity Agent side panel into a standalone **floating window** (hiding the side panel while detached) and reattach it back to the side panel at any time.

## Features & Usage

- **Keyboard Shortcut (`Cmd + Shift + A` on macOS / `Ctrl + Shift + A` on Windows & Linux)**:
  - When attached in the right-hand side panel → detaches the Antigravity Agent into its own separate floating window in front (with **Compact Mode** enabled by default) and hides the right-hand side panel.
  - When detached in a floating window → closes the floating window and reattaches the Agent back into the right-hand side panel.
- **Compact Mode by Default**:
  - Newly detached floating Agent windows automatically open in **Compact Mode** (`workbench.action.enableCompactAuxiliaryWindow`), hiding the redundant editor tab bar, editor action toolbar, and bottom status bar for a clean standalone Agent window.
- **Left Activity Bar Icon & Control Panel**:
  - Adds an **Antigravity Floating Window** icon directly on the left-hand Activity Bar alongside your other extensions — clicking the icon toggles the floating Agent window and opens a quick control panel with **Detach Window** / **Reattach Side Panel** buttons.
- **Top-Right Editor Title Button & High-Priority Status Bar Toggle**:
  - Adds a 1-click Detach/Reattach icon button in the top-right Editor Title bar as well as a high-priority (`10000`) **`Detach Agent`** / **`Reattach Agent`** button in the bottom-right status bar so it remains accessible even when the bottom toolbar is crowded.
- **Automatic Reattachment on Window Close & Reload**:
  - Closing the floating window directly via its red `[x]` button or `Cmd + W` automatically restores and reconnects the Agent in the right-hand side panel.
  - Reloading the IDE window (`Developer: Reload Window`) while detached automatically closes any leftover restored auxiliary window so you never end up with two IDE windows on reload.

## Installation

### Option 1: Install via Antigravity IDE CLI

```bash
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --install-extension antigravity-agent-tab-1.1.6.vsix --force
```

### Option 2: Install from VSIX in the IDE

1. Open **Antigravity IDE**.
2. Press `Cmd + Shift + P` (or `Ctrl + Shift + P`) and run **`Extensions: Install from VSIX...`**.
3. Select `antigravity-agent-tab-1.1.6.vsix` and reload the window.

## Development & Testing

- **Build `.vsix` package**:
  ```bash
  python3 build-vsix.py
  ```
- **Run integration tests**:
  ```bash
  npm test
  ```

## License

MIT
