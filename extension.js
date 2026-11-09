// @ts-nocheck
'use strict';

const vscode = require('vscode');

const AGY_EXTENSION_ID = 'google.google-antigravity';
const DETACHED_VIEW_TYPE = 'jetski-web.editor';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether a tab is the detached Antigravity Agent webview tab ("jetski-web.editor").
 */
function isDetachedAgentTab(tab) {
  if (!tab || !tab.input || typeof tab.input.viewType !== 'string') {
    return false;
  }
  return (
    tab.input.viewType === DETACHED_VIEW_TYPE ||
    tab.input.viewType.endsWith(DETACHED_VIEW_TYPE)
  );
}

/**
 * Find the detached Antigravity webview tab ("jetski-web.editor") across all windows/tab groups.
 */
function findDetachedAgentTab() {
  if (!vscode.window.tabGroups || !Array.isArray(vscode.window.tabGroups.all)) {
    return undefined;
  }
  for (const group of vscode.window.tabGroups.all) {
    if (!group || !Array.isArray(group.tabs)) {
      continue;
    }
    for (const tab of group.tabs) {
      if (isDetachedAgentTab(tab)) {
        return { tab, group };
      }
    }
  }
  return undefined;
}

/**
 * Close any leftover empty or detached-agent auxiliary window tab groups (at index > 0).
 *
 * Why this is needed on Reload Window (`workbench.action.reloadWindow`) and Reattach:
 * - In VS Code / Antigravity IDE, `workbench.editorParts` (`L2n`) always registers `mainPart`
 *   (the main IDE window) at index 0 (`tabGroups.all[0]`) and any floating `AuxiliaryWindow`
 *   (`V2n`) at index >= 1.
 * - When `Developer: Reload Window` runs while the floating Agent window is open, `L2n.saveState()`
 *   persists the auxiliary window in `editorparts.state`. On reload, `L2n.restoreParts()` reopens
 *   that auxiliary window, but because `jetski-web.editor` has no `WebviewPanelSerializer`, its
 *   tab is not restored, leaving a second blank/empty IDE window (`group.tabs.length === 0`) on screen.
 * - Calling `vscode.window.tabGroups.close(group)` invokes `MainThreadEditorTabs.$closeGroup`,
 *   which calls `editorGroupsService.removeGroup(group)` -> `V2n.removeGroup()` -> `V2n.doClose()`
 *   -> `auxiliaryWindow.window.close()`, completely closing the extra floating window.
 */
async function closeLeftoverAuxiliaryWindows(specificGroup = undefined) {
  if (
    !vscode.window.tabGroups ||
    !Array.isArray(vscode.window.tabGroups.all) ||
    typeof vscode.window.tabGroups.close !== 'function'
  ) {
    return false;
  }

  const allGroups = vscode.window.tabGroups.all;
  const groupsToClose = [];

  for (let i = 1; i < allGroups.length; i++) {
    const group = allGroups[i];
    if (!group || !Array.isArray(group.tabs)) {
      continue;
    }
    const isTargetGroup = specificGroup && group === specificGroup;
    const isEmptyGroup = group.tabs.length === 0;
    const hasOnlyDetachedAgentTabs =
      group.tabs.length > 0 && group.tabs.every((t) => isDetachedAgentTab(t));

    if (isTargetGroup || isEmptyGroup || hasOnlyDetachedAgentTabs) {
      groupsToClose.push(group);
    }
  }

  if (groupsToClose.length === 0) {
    return false;
  }

  for (const grp of groupsToClose) {
    try {
      await vscode.window.tabGroups.close(grp, true);
    } catch {}
  }
  return true;
}

async function ensureAntigravityExtension() {
  const ext = vscode.extensions.getExtension(AGY_EXTENSION_ID);
  if (ext && !ext.isActive) {
    await ext.activate();
  }
}

async function closeRightSidePanel() {
  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  } catch {}
}

function activate(context) {
  let isTransitioning = false;
  let hasDetachedInThisSession = false;

  const statusBarItem = vscode.window.createStatusBarItem(
    'antigravityTab.statusBar',
    vscode.StatusBarAlignment.Right,
    101
  );
  statusBarItem.name = 'Antigravity Agent Window Toggle';
  statusBarItem.command = 'antigravityTab.toggleFloatingWindow';
  context.subscriptions.push(statusBarItem);

  function updateStatusBar() {
    const isDetached = Boolean(findDetachedAgentTab());
    if (isDetached) {
      statusBarItem.text = '$(layout-sidebar-right) Reattach Agent';
      statusBarItem.tooltip =
        'Click (or press Cmd+Shift+A) to reattach the Antigravity Agent window back to the side panel';
    } else {
      statusBarItem.text = '$(link-external) Detach Agent';
      statusBarItem.tooltip =
        'Click (or press Cmd+Shift+A) to detach the Antigravity Agent side panel into a floating window';
    }
    statusBarItem.show();
  }

  /**
   * Close any leftover floating auxiliary window restored by `Developer: Reload Window`
   * (`workbench.action.reloadWindow`) or IDE restart so a second empty IDE window never lingers.
   */
  async function cleanupReloadedFloatingWindows() {
    if (hasDetachedInThisSession || isTransitioning) {
      return false;
    }

    const detached = findDetachedAgentTab();
    const hasExtraEmptyGroup =
      vscode.window.tabGroups &&
      Array.isArray(vscode.window.tabGroups.all) &&
      vscode.window.tabGroups.all
        .slice(1)
        .some((g) => g && Array.isArray(g.tabs) && g.tabs.length === 0);

    if (!detached && !hasExtraEmptyGroup) {
      return false;
    }

    isTransitioning = true;
    try {
      if (detached) {
        try {
          await vscode.commands.executeCommand('antigravity.moveBetweenEditorAndSidebar');
        } catch {}
      }
      await closeLeftoverAuxiliaryWindows(detached ? detached.group : undefined);
      if (detached) {
        try {
          await vscode.commands.executeCommand('antigravity.panel.focus');
        } catch {}
      }
      return true;
    } finally {
      isTransitioning = false;
      updateStatusBar();
    }
  }

  /**
   * Detach the right-hand Antigravity side panel into its own separate floating window,
   * hide the side panel in the main window, and connect the floating window to the IDE.
   */
  async function detachToFloatingWindow() {
    if (isTransitioning) {
      return;
    }

    hasDetachedInThisSession = true;
    await ensureAntigravityExtension();

    if (findDetachedAgentTab()) {
      await closeRightSidePanel();
      updateStatusBar();
      return;
    }

    isTransitioning = true;
    try {
      // 1. Move the Antigravity Agent from the side panel into an active editor tab ("jetski-web.editor").
      //    JetskiWebviewProvider.toggle() creates editorPanel, renders the iframe HTML once using cachedServerInfo,
      //    and registers editorPanel as the active "main" JetskiInstance.
      await vscode.commands.executeCommand('antigravity.moveBetweenEditorAndSidebar');

      // 2. Hide the right-hand Antigravity side panel (Auxiliary Bar) in the main IDE window
      //    while the main IDE window is still the active window.
      await closeRightSidePanel();

      // 3. Pop the active "jetski-web.editor" tab out into its own standalone floating OS window
      //    so the new floating window opens in front.
      //    IMPORTANT: Do NOT call antigravity.reconnect after moveEditorToNewWindow!
      //    OverlayWebview automatically mounts the WebviewElement in the new window with the existing HTML.
      //    Calling antigravity.reconnect ~250ms later triggers a second frame creation in VS Code's
      //    pre/index.html while the first frame's <iframe id="jetski-frame"> window.onload is still pending
      //    after the 200ms loadTimeout, which clears the second frame's loadTimeout and leaves #pending-frame
      //    stuck in the DOM (blocking all Extension Host postMessage RPC responses and causing a blank window).
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');

      try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      } catch {}

      // 4. Enable Compact Mode on the detached floating window by default
      //    (hides the redundant editor tab bar, editor toolbar, and bottom status bar).
      //    Because `enableCompactAuxiliaryWindow` targets `getActiveWindow().vscodeWindowId`
      //    (which checks `document.hasFocus()` across auxiliary windows) and is idempotent,
      //    we invoke it immediately and once more after 100ms once macOS grants OS focus.
      try {
        await vscode.commands.executeCommand('workbench.action.enableCompactAuxiliaryWindow');
      } catch {}

      await sleep(100);

      try {
        await vscode.commands.executeCommand('workbench.action.enableCompactAuxiliaryWindow');
      } catch {}

      // 5. If Antigravity's dynamic sidebar command (`antigravity.dynamic.sidebar.toggleSidebar`
      //    or `antigravity.dynamic.openSidebar`) is registered, invoke it once the detached
      //    webview finishes hydrating so the Agent's inner sidebar defaults to open.
      if (typeof vscode.commands.getCommands === 'function') {
        setTimeout(async () => {
          try {
            if (!findDetachedAgentTab()) {
              return;
            }
            const availableCommands = await vscode.commands.getCommands(true);
            for (const cmd of [
              'antigravity.dynamic.openSidebar',
              'antigravity.dynamic.sidebar.toggleSidebar'
            ]) {
              if (Array.isArray(availableCommands) && availableCommands.includes(cmd)) {
                await vscode.commands.executeCommand(cmd);
                break;
              }
            }
          } catch {}
        }, 450);
      }

      // Wait for any trailing onDidChangeTabs events from moveEditorToNewWindow to settle
      await sleep(150);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Could not detach Antigravity Agent to floating window: ${err && err.message ? err.message : err}`
      );
    } finally {
      isTransitioning = false;
      updateStatusBar();
    }
  }

  /**
   * Reattach the floating Antigravity Agent window back into the right-hand side panel.
   */
  async function reattachToSidePanel() {
    if (isTransitioning) {
      return;
    }

    await ensureAntigravityExtension();

    isTransitioning = true;
    try {
      const detached = findDetachedAgentTab();
      const wasDetached = Boolean(detached);
      if (wasDetached) {
        // Disposes the detached editor tab (which automatically closes the floating window),
        // switches JetskiWebviewProvider back to sidebarView, and calls renderWebview() +
        // registerWebview(sidebarView, "main") with a single HTML update.
        await vscode.commands.executeCommand('antigravity.moveBetweenEditorAndSidebar');
      }

      // Ensure the floating auxiliary window's TabGroup is completely closed even if
      // Compact Mode was disabled or `workbench.editor.closeEmptyGroups` is false.
      await closeLeftoverAuxiliaryWindows(detached ? detached.group : undefined);

      // Reveal and focus the right-hand Antigravity side panel in the main window.
      // Do NOT call antigravity.reconnect here when moveBetweenEditorAndSidebar already ran,
      // to avoid overlapping frame loads in sidebarView's pre/index.html.
      try {
        await vscode.commands.executeCommand('antigravity.panel.focus');
      } catch {}

      if (!wasDetached) {
        try {
          await vscode.commands.executeCommand('antigravity.reconnect');
        } catch {}
      }

      await sleep(200);
    } finally {
      isTransitioning = false;
      updateStatusBar();
    }
  }

  /**
   * Toggle between the right-hand side panel and a separate floating window.
   */
  async function toggleFloatingWindow() {
    if (isTransitioning) {
      return;
    }
    if (findDetachedAgentTab()) {
      await reattachToSidePanel();
    } else {
      await detachToFloatingWindow();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityTab.toggleFloatingWindow', toggleFloatingWindow),
    vscode.commands.registerCommand('antigravityTab.detachToFloatingWindow', detachToFloatingWindow),
    vscode.commands.registerCommand('antigravityTab.reattachToSidePanel', reattachToSidePanel)
  );

  // If the user closes the floating window directly via its red [x] button or Cmd+W,
  // automatically restore and reconnect the right-hand side panel.
  // IMPORTANT: Moving a tab to a new window via workbench.action.moveEditorToNewWindow
  // also fires onDidChangeTabs with event.closed containing the tab from the main window's
  // tab group while opening it in the floating window's tab group. We must ignore those
  // window-transfer events by checking isTransitioning and findDetachedAgentTab().
  if (vscode.window.tabGroups && typeof vscode.window.tabGroups.onDidChangeTabs === 'function') {
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(async (event) => {
        updateStatusBar();

        if (isTransitioning) {
          return;
        }

        if (event && Array.isArray(event.closed) && event.closed.some(isDetachedAgentTab)) {
          await sleep(200);

          // If a transition started or the detached tab still exists in any window/group,
          // this was a tab move (not a close) — do NOT reopen the side panel!
          if (isTransitioning || findDetachedAgentTab()) {
            updateStatusBar();
            return;
          }

          isTransitioning = true;
          try {
            await closeLeftoverAuxiliaryWindows();
            await vscode.commands.executeCommand('antigravity.panel.focus');
            await sleep(100);
            await vscode.commands.executeCommand('antigravity.reconnect');
          } catch {} finally {
            isTransitioning = false;
            updateStatusBar();
          }
        }
      })
    );
  }

  // On startup / after `Developer: Reload Window` (`workbench.action.reloadWindow`),
  // immediately close any leftover restored auxiliary floating window so 2 IDE windows
  // never remain open after reloading.
  cleanupReloadedFloatingWindows();
  for (const delayMs of [100, 300, 700, 1500]) {
    setTimeout(() => {
      cleanupReloadedFloatingWindows();
    }, delayMs);
  }

  if (
    vscode.window.tabGroups &&
    typeof vscode.window.tabGroups.onDidChangeTabGroups === 'function'
  ) {
    const startupGroupSub = vscode.window.tabGroups.onDidChangeTabGroups(() => {
      if (!hasDetachedInThisSession) {
        cleanupReloadedFloatingWindows();
      }
    });
    context.subscriptions.push(startupGroupSub);
    setTimeout(() => {
      try {
        startupGroupSub.dispose();
      } catch {}
    }, 2500);
  }

  updateStatusBar();

  return {
    isDetached: () => Boolean(findDetachedAgentTab()),
    isTransitioning: () => isTransitioning,
    getStatusBarItem: () => statusBarItem,
    detachToFloatingWindow,
    reattachToSidePanel,
    toggleFloatingWindow,
    cleanupReloadedFloatingWindows,
    closeLeftoverAuxiliaryWindows
  };
}

async function deactivate() {
  try {
    await closeLeftoverAuxiliaryWindows();
  } catch {}
}

module.exports = {
  activate,
  deactivate,
  findDetachedAgentTab,
  isDetachedAgentTab,
  closeLeftoverAuxiliaryWindows
};
