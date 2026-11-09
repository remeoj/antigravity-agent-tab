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
   * Detach the right-hand Antigravity side panel into its own separate floating window,
   * hide the side panel in the main window, and connect the floating window to the IDE.
   */
  async function detachToFloatingWindow() {
    if (isTransitioning) {
      return;
    }

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

      // Wait for any trailing onDidChangeTabs events from moveEditorToNewWindow to settle
      await sleep(250);
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
      const wasDetached = Boolean(findDetachedAgentTab());
      if (wasDetached) {
        // Disposes the detached editor tab (which automatically closes the floating window),
        // switches JetskiWebviewProvider back to sidebarView, and calls renderWebview() +
        // registerWebview(sidebarView, "main") with a single HTML update.
        await vscode.commands.executeCommand('antigravity.moveBetweenEditorAndSidebar');
      }

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

  updateStatusBar();

  return {
    isDetached: () => Boolean(findDetachedAgentTab()),
    isTransitioning: () => isTransitioning,
    getStatusBarItem: () => statusBarItem,
    detachToFloatingWindow,
    reattachToSidePanel,
    toggleFloatingWindow
  };
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  findDetachedAgentTab,
  isDetachedAgentTab
};
