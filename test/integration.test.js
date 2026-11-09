// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Harness that faithfully simulates:
 * 1. VS Code Workbench (Main Window #1 + Floating Window #2, Auxiliary Bar, TabGroups,
 *    ExtHostWebview identical-HTML caching, OverlayWebview window-transfer lifecycle,
 *    and `pre/index.html`'s `#active-frame` / `#pending-frame` / `loadTimeout` / `pendingMessages`).
 * 2. Google Antigravity's built-in extension (`JetskiWebviewProvider`, `WebviewRenderer`,
 *    `ExtensionApiImpl`, `bridge.js`, and `JetskiInstance` postmessage-rpc channel).
 */
function createAntigravityIdeHarness() {
  const registeredCommands = new Map();
  const registeredWebviewViewProviders = new Map();
  const contextKeys = new Map();
  const tabChangeListeners = new Set();
  const tabGroupChangeListeners = new Set();
  const commandLog = [];

  // Window & UI state
  let activeWindowId = 1; // 1 = Main IDE Window, 2 = Floating Agent Window
  let isAuxiliaryBarOpen = true; // Right-hand Agent side panel in Main Window
  let isFloatingWindowCompact = false; // Compact Mode state of Floating Agent Window (#2)
  let isInnerAgentSidebarOpen = false; // Inner Agent Sidebar state in Floating Window (#2)
  const mainWindowGroup = { viewColumn: 1, windowId: 1, tabs: [] };
  const floatingWindowGroup = { viewColumn: 1, windowId: 2, tabs: [] };
  const tabGroupsAll = [mainWindowGroup];

  const workspaceStateStore = new Map();
  const storageItems = new Map([['agy.onboarding.lastLoginUsername', 'user@example.com']]);
  const conversationHistory = [];
  let activeFileDiffs = [];
  let htmlRenderNonce = 0;

  function fireTabChange(opened, closed, changed = []) {
    const event = { opened, closed, changed };
    for (const listener of Array.from(tabChangeListeners)) {
      listener(event);
    }
  }

  function fireTabGroupsChange(opened, closed, changed = []) {
    const event = { opened, closed, changed };
    for (const listener of Array.from(tabGroupChangeListeners)) {
      listener(event);
    }
  }

  /**
   * Simulates ExtHostWebview + OverlayWebview + VS Code's `pre/index.html` host page:
   * - Maintains `activeFrame` (`#active-frame`) and `pendingFrame` (`#pending-frame`).
   * - Models `pre/index.html`'s single shared `loadTimeout` (200ms) and `<iframe id="jetski-frame">`
   *   `window.onload` (~320ms). If a second content update arrives at ~250ms (after `Frame A`'s
   *   200ms `loadTimeout` promoted `Frame A` to `#active-frame`, but before `Frame A`'s 320ms
   *   `window.onload` fires), `Frame A`'s `window.onload` clears `Frame B`'s `loadTimeout` and calls
   *   `onLoad(Frame A)`, which no-ops because `pendingFrame` is `Frame B`. That leaves `Frame B`
   *   stuck as `#pending-frame` forever and traps all Extension Host `postMessage` calls in
   *   `pendingMessages`!
   * - Models `bridge.js` + `chat.html` startup handshake:
   *   1. When `#jetski-frame` boots, it sends `StorageGetItems` to the Extension Host.
   *   2. `connectionScript` (`kq`) sees `source: 'antigravity-iframe'`, hides `#loading-indicator`,
   *      and sets `iframe.style.opacity = '1'` (`loadingIndicatorHidden = true`).
   *   3. `chat.html` waits for `StorageGetItems` response via `webview.postMessage` before hydrating
   *      the chat UI (`chatUiRendered = true`) and sending `OnAntigravityReady`.
   *   4. If `StorageGetItems` response is trapped in `pre/index.html`'s `pendingMessages`,
   *      `loadingIndicatorHidden` is `true` while `chatUiRendered` is `false` => Blank Window!
   */
  function createSimulatedWebviewSurface(initialWindowId, surfaceName) {
    let cachedExtHostHtml = '';
    let currentWindowId = initialWindowId;
    let elementGeneration = 0;
    const extHostMessageListeners = new Set();
    const receivedByWebview = [];
    const disposeListeners = new Set();
    let isDisposed = false;

    // State inside the current WebviewElement (`pre/index.html`)
    let preState = createFreshPreIndexHtmlState(elementGeneration);

    function createFreshPreIndexHtmlState(gen) {
      return {
        gen,
        activeFrame: null,
        pendingFrame: null,
        loadTimeout: undefined,
        pendingMessages: [],
        frameCounter: 0
      };
    }

    function sendFromWebviewToExtHost(msg) {
      if (isDisposed) {
        return false;
      }
      let handled = false;
      for (const listener of Array.from(extHostMessageListeners)) {
        const res = listener(msg);
        if (res !== undefined) {
          handled = true;
        }
      }
      return handled;
    }

    function deliverContentToPreIndexHtml(htmlContent) {
      const state = preState;
      if (isDisposed || state.gen !== elementGeneration) {
        return;
      }

      const isFirstLoad = !state.activeFrame && !state.pendingFrame;

      // Clean up old pending frame (`previousPendingFrame.remove()`)
      if (state.pendingFrame) {
        state.pendingFrame.removed = true;
        state.pendingFrame = null;
      }
      if (!isFirstLoad) {
        state.pendingMessages = [];
      }

      const frame = {
        frameId: ++state.frameCounter,
        htmlContent,
        isIframeHtml: htmlContent.includes('id="jetski-frame"'),
        removed: false,
        visibility: 'hidden',
        loadingIndicatorHidden: false,
        chatUiRendered: false,
        readySent: false,
        onPostMessageFromHost(msg) {
          if (this.removed || isDisposed || state.gen !== elementGeneration) {
            return;
          }
          // When StorageGetItems response arrives from Extension Host, chat.html hydrates
          // and fires OnAntigravityReady!
          if (
            msg &&
            msg.type === 'postmessage-rpc' &&
            msg.rpcPath &&
            msg.rpcPath.endsWith('/StorageGetItems') &&
            !this.readySent
          ) {
            this.chatUiRendered = true;
            this.readySent = true;
            sendFromWebviewToExtHost({
              type: 'postmessage-rpc',
              channel: 'agy-ext-extension-api',
              requestId: 4,
              rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/OnAntigravityReady',
              payload: {}
            });
          }
        }
      };

      state.pendingFrame = frame;

      // Mirrors `onLoad(contentDocument, contentWindow)` in `pre/index.html` lines 1133-1179
      function onLoad(targetFrame) {
        if (isDisposed || state.gen !== elementGeneration) {
          return;
        }
        const currentPending = state.pendingFrame;
        if (currentPending && currentPending === targetFrame) {
          if (state.activeFrame) {
            state.activeFrame.removed = true;
          }
          state.activeFrame = currentPending;
          state.pendingFrame = null;
          currentPending.visibility = 'visible';

          const queued = state.pendingMessages.slice();
          state.pendingMessages = [];
          for (const item of queued) {
            currentPending.onPostMessageFromHost(item);
          }
        }
      }

      // Mirrors `hookupOnLoadHandlers(newFrame)` in `pre/index.html` lines 1184-1203
      if (state.loadTimeout) {
        clearTimeout(state.loadTimeout);
        state.loadTimeout = undefined;
      }
      state.loadTimeout = setTimeout(() => {
        if (state.loadTimeout) {
          clearTimeout(state.loadTimeout);
          state.loadTimeout = undefined;
        }
        onLoad(frame);
      }, 200);

      // Simulate `contentWindow.addEventListener('load', ...)` in `pre/index.html` lines 1195-1203:
      // - Loading HTML (no child iframe) fires `window.onload` in ~15ms.
      // - Jetski Iframe HTML (with `<iframe id="jetski-frame" src=".../chat.html">`) fires
      //   `window.onload` at ~320ms (after the 200ms `loadTimeout`!) and sends `StorageGetItems`.
      const windowOnLoadDelayMs = frame.isIframeHtml ? 320 : 15;
      setTimeout(() => {
        if (frame.removed || isDisposed || state.gen !== elementGeneration) {
          return;
        }
        if (state.loadTimeout) {
          clearTimeout(state.loadTimeout);
          state.loadTimeout = undefined;
          onLoad(frame);
        }
        if (frame.isIframeHtml && !frame.removed) {
          // `jetski-frame` sends `StorageGetItems` via `bridge.js`, and `connectionScript` (`kq`)
          // immediately hides `#loading-indicator` and sets `iframe.style.opacity = '1'`.
          frame.loadingIndicatorHidden = true;
          sendFromWebviewToExtHost({
            type: 'postmessage-rpc',
            channel: 'agy-ext-extension-api',
            requestId: 2,
            rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/StorageGetItems',
            payload: {}
          });
        }
      }, windowOnLoadDelayMs);
    }

    function resetWebviewElementForWindowTransfer() {
      elementGeneration += 1;
      preState = createFreshPreIndexHtmlState(elementGeneration);
      if (cachedExtHostHtml) {
        deliverContentToPreIndexHtml(cachedExtHostHtml);
      }
    }

    const webview = {
      options: {},
      get html() {
        return cachedExtHostHtml;
      },
      set html(newHtml) {
        // Mirrors ExtHostWebview: `this.#a !== e && this.#t.$setHtml(...)`
        if (cachedExtHostHtml !== newHtml) {
          cachedExtHostHtml = newHtml;
          deliverContentToPreIndexHtml(newHtml);
        }
      },
      onDidReceiveMessage(listener) {
        extHostMessageListeners.add(listener);
        return {
          dispose() {
            extHostMessageListeners.delete(listener);
          }
        };
      },
      async postMessage(msg) {
        if (isDisposed) {
          return false;
        }
        receivedByWebview.push({ windowId: currentWindowId, elementGeneration, msg });
        // Mirrors `hostMessaging.onMessage('message')` in `pre/index.html` lines 1286-1296:
        // If `getPendingFrame()` is non-null, ALL messages from Extension Host are pushed
        // into `pendingMessages` and NOT delivered to `getActiveFrame()`!
        if (!preState.pendingFrame) {
          if (preState.activeFrame) {
            preState.activeFrame.onPostMessageFromHost(msg);
          }
        } else {
          preState.pendingMessages.push(msg);
        }
        return true;
      }
    };

    return {
      surfaceName,
      webview,
      get windowId() {
        return currentWindowId;
      },
      get elementGeneration() {
        return elementGeneration;
      },
      get currentElementReady() {
        return Boolean(preState.activeFrame && preState.activeFrame.chatUiRendered);
      },
      get hasStuckPendingFrame() {
        return Boolean(preState.pendingFrame && !preState.loadTimeout);
      },
      get isBlankWindow() {
        // Blank window occurs when `#active-frame` hid `#loading-indicator` after sending
        // `StorageGetItems`, or `#pending-frame` is stuck, so `chatUiRendered` is false!
        if (!preState.activeFrame) {
          return true;
        }
        return !preState.activeFrame.chatUiRendered;
      },
      get receivedByWebview() {
        return receivedByWebview;
      },
      get activeListenerCount() {
        return extHostMessageListeners.size;
      },
      transferToWindow(newWindowId) {
        if (currentWindowId !== newWindowId) {
          currentWindowId = newWindowId;
          resetWebviewElementForWindowTransfer();
        }
      },
      async sendChatMessage(promptText, conversationId = `conv-${Date.now()}`) {
        if (extHostMessageListeners.size === 0 || this.isBlankWindow) {
          return {
            processed: false,
            reason: this.isBlankWindow
              ? 'Webview is blank (StorageGetItems / OnAntigravityReady handshake incomplete)'
              : 'No active JetskiInstance RPC listener on webview'
          };
        }

        const chatSentHandled = sendFromWebviewToExtHost({
          type: 'postmessage-rpc',
          channel: 'agy-ext-extension-api',
          rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/OnDidSendChatMessage',
          payload: { prompt: promptText }
        });

        const urlChangedHandled = sendFromWebviewToExtHost({
          type: 'postmessage-rpc',
          channel: 'agy-ext-extension-api',
          rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/OnDidChangeUrl',
          payload: { path: `/c/${conversationId}` }
        });

        const storageHandled = sendFromWebviewToExtHost({
          type: 'postmessage-rpc',
          channel: 'agy-ext-extension-api',
          rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/StorageUpdateItems',
          payload: { key: conversationId, prompt: promptText }
        });

        const convChangedHandled = sendFromWebviewToExtHost({
          type: 'postmessage-rpc',
          channel: 'agy-ext-extension-api',
          rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/OnDidChangeConversations',
          payload: { conversationId, prompt: promptText }
        });

        return {
          processed: Boolean(
            chatSentHandled && urlChangedHandled && storageHandled && convChangedHandled
          ),
          conversationId
        };
      },
      onDidDispose(listener) {
        disposeListeners.add(listener);
        return {
          dispose() {
            disposeListeners.delete(listener);
          }
        };
      },
      dispose() {
        if (isDisposed) {
          return;
        }
        isDisposed = true;
        if (preState.loadTimeout) {
          clearTimeout(preState.loadTimeout);
          preState.loadTimeout = undefined;
        }
        for (const l of Array.from(disposeListeners)) {
          l();
        }
      }
    };
  }

  // Simulated sidebarView ("antigravity.panel")
  const sidebarSurface = createSimulatedWebviewSurface(1, 'sidebarView');

  // Simulated ExtensionApiImpl + JetskiWebviewProvider (mirrors extensions/agy/vscode/extension.js)
  const agyViews = [];
  let cachedServerInfo = { effectiveUrl: 'http://127.0.0.1:49500' };

  function createJetskiInstance(viewSurface, type) {
    let readyResolved = false;
    let resolveReady;
    const readyPromise = new Promise((r) => {
      resolveReady = r;
    });

    const sub = viewSurface.webview.onDidReceiveMessage((msg) => {
      if (!msg || msg.type !== 'postmessage-rpc') {
        return undefined;
      }
      if (msg.rpcPath.endsWith('/StorageGetItems')) {
        // Mirrors JetskiInstance responding to StorageGetItems via webview.postMessage
        viewSurface.webview.postMessage({
          type: 'postmessage-rpc',
          channel: 'agy-ext-extension-api',
          requestId: msg.requestId || 2,
          rpcPath: '/gemini_coder.agent_ui_toolkit.iframe.ExtensionApi/StorageGetItems',
          payload: { items: Object.fromEntries(storageItems.entries()) },
          source: 'antigravity-extension',
          error: false
        });
        return { ok: true };
      }
      if (msg.rpcPath.endsWith('/OnAntigravityReady')) {
        if (!readyResolved) {
          readyResolved = true;
          resolveReady();
        }
        return { ok: true };
      }
      if (msg.rpcPath.endsWith('/OnDidSendChatMessage')) {
        return { ok: true };
      }
      if (msg.rpcPath.endsWith('/OnDidChangeUrl')) {
        const match = msg.payload && msg.payload.path && msg.payload.path.match(/^\/c\/([^/]+)$/);
        if (match) {
          workspaceStateStore.set('lastConversationId', match[1]);
        }
        return { ok: true };
      }
      if (msg.rpcPath.endsWith('/StorageUpdateItems')) {
        storageItems.set(msg.payload.key, msg.payload.prompt);
        return { ok: true };
      }
      if (msg.rpcPath.endsWith('/OnDidChangeConversations')) {
        conversationHistory.push({
          conversationId: msg.payload.conversationId,
          prompt: msg.payload.prompt,
          surface: viewSurface.surfaceName,
          windowId: viewSurface.windowId
        });
        return { ok: true };
      }
      return { ok: true };
    });

    const instance = {
      type,
      view: viewSurface,
      webview: viewSurface.webview,
      ready: readyPromise,
      seededGeneration: null,
      dispose() {
        sub.dispose();
      }
    };

    readyPromise.then(() => {
      if (agyViews.includes(instance)) {
        instance.seededGeneration = viewSurface.elementGeneration;
        viewSurface.webview.postMessage({
          type: 'SetFileDiffs',
          fileDiffs: activeFileDiffs
        });
      }
    });

    return instance;
  }

  function registerWebview(viewSurface, type) {
    const existingIdx = agyViews.findIndex(
      (h) => h.webview === viewSurface.webview || (type === 'main' && h.type === 'main')
    );
    if (existingIdx > -1) {
      agyViews.splice(existingIdx, 1)[0].dispose();
    }
    const instance = createJetskiInstance(viewSurface, type);
    agyViews.push(instance);
    return instance;
  }

  const jetskiProvider = {
    isSidebarVisible: true,
    sidebarView: sidebarSurface,
    editorPanel: undefined,
    view: sidebarSurface,
    async renderWebview() {
      if (!this.view) {
        return;
      }
      const targetView = this.view;
      const isColdRefresh = !cachedServerInfo;
      if (isColdRefresh) {
        targetView.webview.html = '<html><body>Checking your setup...</body></html>';
        // Mirrors async getServerInfo() (`pR` -> `vscode.env.asExternalUri`)
        await sleep(5);
        cachedServerInfo = { effectiveUrl: 'http://127.0.0.1:49500' };
      }
      const convId = workspaceStateStore.get('lastConversationId') || '';
      // Mirrors `tv("Loading Antigravity...")` which embeds `animation-delay: -${Date.now()%1600}ms`
      htmlRenderNonce += 1;
      targetView.webview.html = `<html><body><div class="progress-bar" style="animation-delay: -${htmlRenderNonce}ms"></div><iframe id="jetski-frame" src="${cachedServerInfo.effectiveUrl}/c/${convId}"></iframe></body></html>`;
      registerWebview(targetView, 'main');
    },
    refresh() {
      cachedServerInfo = undefined;
      if (this.view) {
        this.renderWebview();
      }
    },
    async toggle() {
      this.isSidebarVisible = !this.isSidebarVisible;
      if (this.isSidebarVisible) {
        if (this.editorPanel) {
          this.editorPanel.dispose();
          this.editorPanel = undefined;
          this.view = this.sidebarView;
          await this.renderWebview();
        }
      } else if (!this.editorPanel) {
        const panelSurface = createSimulatedWebviewSurface(1, 'editorPanel');
        const tabObj = {
          label: 'Antigravity',
          input: { viewType: 'mainThreadWebview-jetski-web.editor' }
        };
        mainWindowGroup.tabs.push(tabObj);
        activeWindowId = 1;
        fireTabChange([tabObj], []);

        panelSurface.tabObj = tabObj;
        panelSurface.onDidDispose(() => {
          this.editorPanel = undefined;
          this.view = this.sidebarView;
          this.isSidebarVisible = true;

          for (const grp of [mainWindowGroup, floatingWindowGroup]) {
            const idx = grp.tabs.indexOf(tabObj);
            if (idx !== -1) {
              grp.tabs.splice(idx, 1);
              if (grp === floatingWindowGroup && floatingWindowGroup.tabs.length === 0) {
                const gIdx = tabGroupsAll.indexOf(floatingWindowGroup);
                if (gIdx !== -1) {
                  tabGroupsAll.splice(gIdx, 1);
                }
                isFloatingWindowCompact = false;
                isInnerAgentSidebarOpen = false;
                if (activeWindowId === 2) {
                  activeWindowId = 1;
                }
              }
              fireTabChange([], [tabObj]);
            }
          }
        });

        this.editorPanel = panelSurface;
        this.view = this.editorPanel;
        await this.renderWebview();
      }
    }
  };

  registeredCommands.set('antigravity.moveBetweenEditorAndSidebar', async () => {
    commandLog.push('antigravity.moveBetweenEditorAndSidebar');
    await jetskiProvider.toggle();
  });

  registeredCommands.set('antigravity.reconnect', async () => {
    commandLog.push('antigravity.reconnect');
    jetskiProvider.refresh();
  });

  registeredCommands.set('antigravity.panel.focus', async () => {
    commandLog.push('antigravity.panel.focus');
    isAuxiliaryBarOpen = true;
    activeWindowId = 1;
  });

  registeredCommands.set('workbench.action.closeAuxiliaryBar', async () => {
    commandLog.push('workbench.action.closeAuxiliaryBar');
    if (activeWindowId === 1) {
      isAuxiliaryBarOpen = false;
    }
  });

  registeredCommands.set('workbench.action.focusActiveEditorGroup', async () => {
    commandLog.push('workbench.action.focusActiveEditorGroup');
  });

  registeredCommands.set('workbench.action.enableCompactAuxiliaryWindow', async () => {
    commandLog.push('workbench.action.enableCompactAuxiliaryWindow');
    if (activeWindowId === 2) {
      isFloatingWindowCompact = true;
    }
  });

  registeredCommands.set('workbench.action.disableCompactAuxiliaryWindow', async () => {
    commandLog.push('workbench.action.disableCompactAuxiliaryWindow');
    if (activeWindowId === 2) {
      isFloatingWindowCompact = false;
    }
  });

  registeredCommands.set('workbench.action.toggleCompactAuxiliaryWindow', async () => {
    commandLog.push('workbench.action.toggleCompactAuxiliaryWindow');
    if (activeWindowId === 2) {
      isFloatingWindowCompact = !isFloatingWindowCompact;
    }
  });

  registeredCommands.set('setContext', async (key, val) => {
    contextKeys.set(key, val);
  });

  registeredCommands.set('antigravity.dynamic.sidebar.toggleSidebar', async () => {
    commandLog.push('antigravity.dynamic.sidebar.toggleSidebar');
    if (activeWindowId === 2) {
      isInnerAgentSidebarOpen = !isInnerAgentSidebarOpen;
    }
  });

  registeredCommands.set('workbench.action.moveEditorToNewWindow', async () => {
    commandLog.push('workbench.action.moveEditorToNewWindow');
    if (!jetskiProvider.editorPanel) {
      throw new Error('No active editor panel to move to new window');
    }
    const tabObj = jetskiProvider.editorPanel.tabObj;
    const idx = mainWindowGroup.tabs.indexOf(tabObj);
    if (idx !== -1) {
      mainWindowGroup.tabs.splice(idx, 1);
    }
    if (!tabGroupsAll.includes(floatingWindowGroup)) {
      tabGroupsAll.push(floatingWindowGroup);
    }
    floatingWindowGroup.tabs.push(tabObj);
    activeWindowId = 2;

    jetskiProvider.editorPanel.transferToWindow(2);
    fireTabChange([tabObj], [tabObj]);
  });

  const vscodeMock = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    extensions: {
      getExtension(id) {
        if (id === 'google.google-antigravity') {
          return {
            id,
            isActive: true,
            async activate() {}
          };
        }
        return undefined;
      }
    },
    commands: {
      registerCommand(id, handler) {
        registeredCommands.set(id, handler);
        return {
          dispose() {
            registeredCommands.delete(id);
          }
        };
      },
      async getCommands() {
        return Array.from(registeredCommands.keys());
      },
      async executeCommand(id, ...args) {
        const handler = registeredCommands.get(id);
        if (!handler) {
          throw new Error(`Command not found: ${id}`);
        }
        return handler(...args);
      }
    },
    window: {
      tabGroups: {
        get all() {
          return tabGroupsAll;
        },
        onDidChangeTabs(listener) {
          tabChangeListeners.add(listener);
          return {
            dispose() {
              tabChangeListeners.delete(listener);
            }
          };
        },
        onDidChangeTabGroups(listener) {
          tabGroupChangeListeners.add(listener);
          return {
            dispose() {
              tabGroupChangeListeners.delete(listener);
            }
          };
        },
        async close(groupsOrGroup) {
          commandLog.push('tabGroups.close');
          const groups = Array.isArray(groupsOrGroup) ? groupsOrGroup : [groupsOrGroup];
          for (const group of groups) {
            if (!group) {
              continue;
            }
            const closedTabs = group.tabs.slice();
            group.tabs.length = 0;
            if (closedTabs.length > 0) {
              fireTabChange([], closedTabs);
            }
            // Mirrors `MainThreadEditorTabs.$closeGroup` -> `this._editorGroupsService.removeGroup(s)`
            // -> `V2n.removeGroup` -> `V2n.doClose(false)` -> `u.window.close()` for auxiliary parts
            if (group !== mainWindowGroup) {
              const gIdx = tabGroupsAll.indexOf(group);
              if (gIdx !== -1) {
                tabGroupsAll.splice(gIdx, 1);
                isFloatingWindowCompact = false;
                isInnerAgentSidebarOpen = false;
                if (activeWindowId === 2) {
                  activeWindowId = 1;
                }
                fireTabGroupsChange([], [group]);
              }
            }
          }
          return true;
        }
      },
      createStatusBarItem(id, alignment, priority) {
        return {
          id,
          alignment,
          priority,
          name: '',
          text: '',
          tooltip: '',
          command: '',
          visible: false,
          show() {
            this.visible = true;
          },
          hide() {
            this.visible = false;
          },
          dispose() {}
        };
      },
      showWarningMessage(msg) {
        commandLog.push(`warning:${msg}`);
      },
      registerWebviewViewProvider(viewId, provider) {
        registeredWebviewViewProviders.set(viewId, provider);
        return {
          dispose() {
            registeredWebviewViewProviders.delete(viewId);
          }
        };
      }
    }
  };

  return {
    vscodeMock,
    jetskiProvider,
    sidebarSurface,
    commandLog,
    contextKeys,
    registeredWebviewViewProviders,
    conversationHistory,
    storageItems,
    workspaceStateStore,
    createSimulatedWebviewSurface,
    getActiveWindowId: () => activeWindowId,
    getOpenWindowCount: () => tabGroupsAll.length,
    isAuxiliaryBarOpen: () => isAuxiliaryBarOpen,
    isFloatingWindowCompact: () => isFloatingWindowCompact,
    isInnerAgentSidebarOpen: () => isInnerAgentSidebarOpen,
    setActiveFileDiffs: (diffs) => {
      activeFileDiffs = diffs;
    },
    async initDefaultSidePanel() {
      await jetskiProvider.renderWebview();
      await sleep(360);
    },
    async closeFloatingWindowManually() {
      if (jetskiProvider.editorPanel) {
        jetskiProvider.editorPanel.dispose();
      }
    },
    /**
     * Simulates `Developer: Reload Window` (`workbench.action.reloadWindow`):
     * 1. `L2n.saveState()` runs during `onWillSaveState` in the renderer BEFORE Extension Host
     *    `deactivate()` finishes, persisting `e.auxiliary` in `workspaceMemento["editorparts.state"]`
     *    if the auxiliary floating window (`V2n`, Window #2) was open when reload began.
     * 2. Extension Host unloads (disposing old subscriptions).
     * 3. On reload, `jetski-web.editor` is an ephemeral webview with no `WebviewPanelSerializer`,
     *    so its editor input is NOT restored (`floatingWindowGroup.tabs = []`), while `L2n.restoreParts()`
     *    re-creates the empty auxiliary floating window (`V2n`, Window #2) from `editorparts.state`
     *    either synchronously before extension activation or asynchronously after `asyncRestoreDelayMs`.
     * 4. `google.google-antigravity` initializes `sidebarView` in the main window (`Window #1`).
     * 5. `joemerramos.antigravity-agent-tab` activates on reload (`activate(newContext)`).
     */
    async simulateDeveloperReloadWindow(extensionMod, oldContext, { asyncRestoreDelayMs = 0 } = {}) {
      commandLog.push('workbench.action.reloadWindow');
      const hadAuxiliaryWindowAtSaveState = tabGroupsAll.includes(floatingWindowGroup);

      // Tear down old extension host subscriptions
      if (oldContext && Array.isArray(oldContext.subscriptions)) {
        for (const sub of oldContext.subscriptions.splice(0)) {
          if (sub && typeof sub.dispose === 'function') {
            sub.dispose();
          }
        }
      }

      // Ephemeral `jetski-web.editor` webview is destroyed on window reload (no serializer)
      jetskiProvider.editorPanel = undefined;
      jetskiProvider.isSidebarVisible = true;
      jetskiProvider.view = sidebarSurface;
      mainWindowGroup.tabs.length = 0;
      floatingWindowGroup.tabs.length = 0;

      // Remove floating window temporarily if simulating async `L2n.restoreParts()`
      const gIdx = tabGroupsAll.indexOf(floatingWindowGroup);
      if (gIdx !== -1) {
        tabGroupsAll.splice(gIdx, 1);
      }

      if (hadAuxiliaryWindowAtSaveState && asyncRestoreDelayMs <= 0) {
        // Synchronous `L2n.restoreParts()` before extension activation:
        // Reopens the empty second IDE window (`floatingWindowGroup` with `tabs: []`)
        tabGroupsAll.push(floatingWindowGroup);
        activeWindowId = 2;
      } else {
        activeWindowId = 1;
      }

      // `google.google-antigravity` initializes the side panel in Window #1
      isAuxiliaryBarOpen = true;
      await jetskiProvider.renderWebview();

      // Activate our extension in the reloaded Extension Host
      const newContext = { subscriptions: [] };
      const newApi = extensionMod.activate(newContext);

      if (hadAuxiliaryWindowAtSaveState && asyncRestoreDelayMs > 0) {
        setTimeout(() => {
          if (!tabGroupsAll.includes(floatingWindowGroup)) {
            tabGroupsAll.push(floatingWindowGroup);
            activeWindowId = 2;
            fireTabGroupsChange([floatingWindowGroup], []);
          }
        }, asyncRestoreDelayMs);
      }

      await sleep(Math.max(380, asyncRestoreDelayMs + 250));
      return { context: newContext, api: newApi };
    }
  };
}

async function runIntegrationTests() {
  console.log('Running Antigravity Agent Floating Window integration tests...\n');

  const harness = createAntigravityIdeHarness();

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return harness.vscodeMock;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    await harness.initDefaultSidePanel();

    const extension = require('../extension.js');
    const context = { subscriptions: [] };
    const api = extension.activate(context);
    const statusBar = api.getStatusBarItem();

    // =========================================================================
    // TEST 1: Initial Side Panel State & Regular Chat Functionality
    // =========================================================================
    console.log('Test 1: Initial side panel state and regular chat functionality...');
    assert.equal(api.isDetached(), false, 'Agent should initially be attached in the side panel');
    assert.equal(harness.isAuxiliaryBarOpen(), true, 'Side panel (Auxiliary Bar) should be open');
    assert.equal(harness.getActiveWindowId(), 1, 'Main IDE window (Window #1) should be active');
    assert.equal(
      harness.sidebarSurface.isBlankWindow,
      false,
      'Side panel should be hydrated and not blank'
    );
    assert.equal(
      statusBar.text,
      '$(link-external) Detach Agent',
      'Status bar should show Detach Agent'
    );

    const sidePanelChat1 = await harness.sidebarSurface.sendChatMessage(
      'Hello from regular side panel',
      'conv-initial-1'
    );
    assert.equal(sidePanelChat1.processed, true, 'Side panel chat request should be processed');
    assert.equal(
      harness.workspaceStateStore.get('lastConversationId'),
      'conv-initial-1',
      'Side panel chat should update workspaceState lastConversationId'
    );
    assert.equal(
      harness.conversationHistory.length,
      1,
      'Side panel chat should append to conversation history'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 2: Detach to Floating Window (Cmd+Shift+A) — Hides Side Panel & Opens Non-Blank Floating Window in Front
    // =========================================================================
    console.log(
      'Test 2: Detach to floating window (Cmd+Shift+A) hides side panel, opens in front, and does not trigger overlapping reconnect...'
    );
    harness.commandLog.length = 0;
    harness.setActiveFileDiffs([{ uri: 'file:///Users/joemerramos/dev/app.js', hunks: 2 }]);

    await harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');

    assert.equal(api.isDetached(), true, 'Agent should be detached in floating window');
    assert.equal(
      harness.isAuxiliaryBarOpen(),
      false,
      'Side panel (Auxiliary Bar) MUST be hidden when detached'
    );
    assert.equal(
      harness.getActiveWindowId(),
      2,
      'Detached floating window (Window #2) MUST be in front (active)'
    );
    assert.equal(
      harness.isFloatingWindowCompact(),
      true,
      'Detached floating window MUST have Compact Mode enabled by default'
    );
    assert.equal(
      harness.commandLog.includes('workbench.action.enableCompactAuxiliaryWindow'),
      true,
      'detachToFloatingWindow MUST execute workbench.action.enableCompactAuxiliaryWindow'
    );
    assert.equal(
      harness.commandLog.includes('antigravity.panel.focus'),
      false,
      'onDidChangeTabs MUST NOT call antigravity.panel.focus during moveEditorToNewWindow'
    );
    assert.equal(
      harness.commandLog.includes('antigravity.reconnect'),
      false,
      'detachToFloatingWindow MUST NOT call antigravity.reconnect (which causes a stuck #pending-frame blank window)'
    );
    assert.equal(
      statusBar.text,
      '$(layout-sidebar-right) Reattach Agent',
      'Status bar should update to Reattach Agent'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 3: Detached Floating Window Renders Chat UI (Not Blank) & Works With IDE
    // =========================================================================
    console.log(
      'Test 3: Detached floating window completes StorageGetItems -> OnAntigravityReady handshake (not blank) and processes chat...'
    );
    // Wait for the floating window's 320ms iframe load + StorageGetItems handshake + 450ms sidebar toggle to complete
    await sleep(360);

    const floatingPanel = harness.jetskiProvider.editorPanel;
    assert.ok(floatingPanel, 'Floating editorPanel should exist');
    assert.equal(floatingPanel.windowId, 2, 'Floating editorPanel should be in Window #2');
    assert.equal(
      harness.isInnerAgentSidebarOpen(),
      true,
      'Floating window MUST invoke antigravity.dynamic.sidebar.toggleSidebar when available'
    );
    assert.equal(
      floatingPanel.hasStuckPendingFrame,
      false,
      'Floating window pre/index.html MUST NOT have a stuck #pending-frame'
    );
    assert.equal(
      floatingPanel.isBlankWindow,
      false,
      'Floating window MUST NOT be blank (StorageGetItemsResponse must be delivered and UI hydrated)'
    );
    assert.equal(
      floatingPanel.currentElementReady,
      true,
      'Floating window WebviewElement in Window #2 MUST complete OnAntigravityReady'
    );

    const floatingChat = await floatingPanel.sendChatMessage(
      'Refactor the authentication module',
      'conv-floating-2'
    );
    assert.equal(
      floatingChat.processed,
      true,
      'Detached floating window MUST process chat messages via JetskiInstance RPC'
    );
    assert.equal(
      harness.workspaceStateStore.get('lastConversationId'),
      'conv-floating-2',
      'Detached floating window MUST update lastConversationId in workspaceState'
    );
    assert.equal(
      harness.storageItems.get('conv-floating-2'),
      'Refactor the authentication module',
      'Detached floating window MUST persist chat changes to storage'
    );
    assert.equal(
      harness.conversationHistory.length,
      2,
      'Detached floating window MUST add changes to conversation history'
    );
    assert.equal(
      harness.conversationHistory[1].windowId,
      2,
      'Conversation history entry should originate from floating Window #2'
    );
    assert.ok(
      floatingPanel.receivedByWebview.some(
        (entry) => entry.windowId === 2 && entry.msg && entry.msg.type === 'SetFileDiffs'
      ),
      'Detached floating window WebviewElement in Window #2 MUST receive initial IDE file diffs (seedNewView)'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 4: Reattach to Side Panel (Cmd+Shift+A / Status Bar Click) & Regular Chat Works
    // =========================================================================
    console.log(
      'Test 4: Reattach to side panel closes floating window, restores side panel without blanking, and reconnects regular chat...'
    );
    harness.commandLog.length = 0;
    await harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');

    // Wait for sidebarView's 320ms iframe load + StorageGetItems handshake
    await sleep(160);

    assert.equal(api.isDetached(), false, 'Agent should be reattached to side panel');
    assert.equal(
      harness.isAuxiliaryBarOpen(),
      true,
      'Right-hand side panel (Auxiliary Bar) should be visible again'
    );
    assert.equal(
      harness.getActiveWindowId(),
      1,
      'Main IDE window (Window #1) should be focused again'
    );
    assert.equal(
      harness.commandLog.includes('antigravity.reconnect'),
      false,
      'reattachToSidePanel MUST NOT call redundant antigravity.reconnect after moveBetweenEditorAndSidebar'
    );
    assert.equal(
      harness.sidebarSurface.hasStuckPendingFrame,
      false,
      'Reattached side panel MUST NOT have a stuck #pending-frame'
    );
    assert.equal(
      harness.sidebarSurface.isBlankWindow,
      false,
      'Reattached side panel MUST NOT be blank'
    );
    assert.equal(
      statusBar.text,
      '$(link-external) Detach Agent',
      'Status bar should show Detach Agent after reattaching'
    );

    const sidePanelChat2 = await harness.sidebarSurface.sendChatMessage(
      'Add unit tests for the new module',
      'conv-reattached-3'
    );
    assert.equal(
      sidePanelChat2.processed,
      true,
      'Regular chat in side panel MUST work after reattaching'
    );
    assert.equal(
      harness.workspaceStateStore.get('lastConversationId'),
      'conv-reattached-3',
      'Regular chat in side panel MUST update conversation state after reattaching'
    );
    assert.equal(
      harness.conversationHistory.length,
      3,
      'Regular chat in side panel MUST add to conversation history after reattaching'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 5: Closing Floating Window via Red [x] / Cmd+W Automatically Reconnects Side Panel
    // =========================================================================
    console.log(
      'Test 5: Closing the floating window via [x] or Cmd+W automatically restores and reconnects the side panel...'
    );
    await harness.vscodeMock.commands.executeCommand('antigravityTab.detachToFloatingWindow');
    await sleep(120);
    assert.equal(api.isDetached(), true, 'Agent should be detached');
    assert.equal(harness.isAuxiliaryBarOpen(), false, 'Side panel should be hidden while detached');

    // Simulate user clicking red [x] on the floating window
    await harness.closeFloatingWindowManually();

    // Wait for onDidChangeTabs close handler (200ms debounce + 100ms + 325ms iframe load)
    await sleep(700);

    assert.equal(api.isDetached(), false, 'Agent should be marked attached after manual close');
    assert.equal(
      harness.isAuxiliaryBarOpen(),
      true,
      'Side panel should automatically reopen when floating window is closed'
    );
    assert.equal(
      harness.sidebarSurface.isBlankWindow,
      false,
      'Side panel should be hydrated (not blank) after manual floating window close'
    );
    assert.equal(
      statusBar.text,
      '$(link-external) Detach Agent',
      'Status bar should reset to Detach Agent when floating window is closed'
    );

    const sidePanelChat3 = await harness.sidebarSurface.sendChatMessage(
      'Does chat still work after closing floating window with [x]?',
      'conv-manual-close-4'
    );
    assert.equal(
      sidePanelChat3.processed,
      true,
      'Regular chat in side panel MUST work after manually closing the floating window'
    );
    assert.equal(
      harness.conversationHistory.length,
      4,
      'Conversation history should record message after manual floating window close'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 6: Rapid / Concurrent Toggle Calls Are Guarded by isTransitioning
    // =========================================================================
    console.log('Test 6: Concurrent toggle calls during transition are safely guarded...');
    const p1 = harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');
    const p2 = harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');
    await Promise.all([p1, p2]);
    await sleep(120);

    assert.equal(
      api.isDetached(),
      true,
      'Concurrent toggle during detach should not immediately cancel the detach'
    );
    assert.equal(
      harness.isAuxiliaryBarOpen(),
      false,
      'Side panel should remain hidden after guarded detach'
    );
    assert.equal(
      harness.jetskiProvider.editorPanel.isBlankWindow,
      false,
      'Floating window should not be blank after guarded detach'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 7: Regression Verification — Reproducing the v1.1.1 Blank Window Bug
    // =========================================================================
    console.log(
      'Test 7: Regression test verifying that calling reconnect 250ms after moveEditorToNewWindow reproduces the stuck #pending-frame blank window...'
    );
    const buggySurface = harness.createSimulatedWebviewSurface(2, 'buggyV111Surface');
    // 1. Initial iframe HTML is set when moved to floating window (t = 0ms)
    buggySurface.webview.html =
      '<html><body><iframe id="jetski-frame" src="http://127.0.0.1:49500/c/1"></iframe></body></html>';
    // 2. 250ms later (after Frame A's 200ms loadTimeout promoted Frame A to #active-frame,
    //    but before Frame A's 320ms window.onload fires), v1.1.1 called antigravity.reconnect:
    await sleep(250);
    buggySurface.webview.html =
      '<html><body><div style="animation-delay:-2ms"></div><iframe id="jetski-frame" src="http://127.0.0.1:49500/c/1"></iframe></body></html>';
    await sleep(350);

    assert.equal(
      buggySurface.hasStuckPendingFrame,
      true,
      'Calling reconnect at 250ms MUST reproduce the stuck #pending-frame bug in pre/index.html'
    );
    assert.equal(
      buggySurface.isBlankWindow,
      true,
      'Stuck #pending-frame blocks StorageGetItemsResponse and produces a blank window'
    );
    buggySurface.dispose();
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 8: Developer: Reload Window While Detached Closes Leftover 2nd Window
    // =========================================================================
    console.log(
      'Test 8: Developer: Reload Window while detached closes the leftover 2nd IDE window and restores side panel chat...'
    );
    assert.equal(
      harness.getOpenWindowCount(),
      2,
      'Precondition: 2 windows (Main IDE + Floating Agent) are open before reload'
    );

    const reload1 = await harness.simulateDeveloperReloadWindow(extension, context, {
      asyncRestoreDelayMs: 0
    });

    assert.equal(
      harness.getOpenWindowCount(),
      1,
      'Leftover empty 2nd IDE window restored from editorparts.state MUST be closed on reload'
    );
    assert.equal(
      harness.getActiveWindowId(),
      1,
      'Main IDE window (Window #1) should be active after reload'
    );
    assert.equal(
      reload1.api.isDetached(),
      false,
      'Extension should report attached state after window reload'
    );
    assert.equal(
      reload1.api.getStatusBarItem().text,
      '$(link-external) Detach Agent',
      'Status bar should reset to Detach Agent after reload'
    );
    assert.equal(
      harness.isAuxiliaryBarOpen(),
      true,
      'Side panel should be open in Main IDE window after reload'
    );
    assert.equal(
      harness.sidebarSurface.isBlankWindow,
      false,
      'Side panel should be hydrated and not blank after reload'
    );

    const postReloadChat = await harness.sidebarSurface.sendChatMessage(
      'Chat after Developer: Reload Window'
    );
    assert.equal(
      postReloadChat.processed,
      true,
      'Side panel chat should process requests normally after Developer: Reload Window'
    );
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 9: Delayed Auxiliary Window Restoration on Reload + Post-Reload Detach/Reattach
    // =========================================================================
    console.log(
      'Test 9: Delayed auxiliary window restoration on reload (async restoreParts) and subsequent detach/reattach cycle...'
    );
    await harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');
    assert.equal(
      harness.getOpenWindowCount(),
      2,
      'Detaching after reload should open the floating Agent window (2 windows total)'
    );
    assert.equal(reload1.api.isDetached(), true, 'Agent should be detached before second reload');

    const reload2 = await harness.simulateDeveloperReloadWindow(extension, reload1.context, {
      asyncRestoreDelayMs: 120
    });

    assert.equal(
      harness.getOpenWindowCount(),
      1,
      'Delayed auxiliary window restored 120ms after activate() MUST also be closed automatically'
    );
    assert.equal(
      harness.getActiveWindowId(),
      1,
      'Main IDE window (Window #1) should be active after delayed reload cleanup'
    );
    assert.equal(
      reload2.api.isDetached(),
      false,
      'Extension should be attached after delayed reload cleanup'
    );

    // Verify full detach -> chat -> reattach cycle after reload
    await harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');
    await sleep(150);
    assert.equal(harness.getOpenWindowCount(), 2, 'Floating window should open on detach');
    assert.equal(reload2.api.isDetached(), true, 'Agent should be detached');
    assert.equal(
      harness.jetskiProvider.editorPanel.isBlankWindow,
      false,
      'Detached floating window after reload should not be blank'
    );

    const postReloadDetachedChat = await harness.jetskiProvider.editorPanel.sendChatMessage(
      'Detached chat after 2nd reload'
    );
    assert.equal(
      postReloadDetachedChat.processed,
      true,
      'Detached floating window chat should work after reload'
    );

    await harness.vscodeMock.commands.executeCommand('antigravityTab.toggleFloatingWindow');
    assert.equal(
      harness.getOpenWindowCount(),
      1,
      'Reattaching should completely close the floating window (1 window remaining)'
    );
    assert.equal(reload2.api.isDetached(), false, 'Agent should be reattached to side panel');
    console.log('  ✓ Passed\n');

    // =========================================================================
    // TEST 10: Left Activity Bar Icon & View + High-Priority Status Bar Item
    // =========================================================================
    console.log(
      'Test 10: Activity Bar icon/view on the side and high-priority Status Bar item work when bottom toolbar is full...'
    );
    assert.equal(
      reload2.api.getStatusBarItem().priority,
      10000,
      'Status Bar item should use high priority (10000) so it resists being hidden when the bottom bar is crowded'
    );
    const activityBarProvider = harness.registeredWebviewViewProviders.get(
      'antigravityTab.sidebarView'
    );
    assert.ok(
      activityBarProvider,
      'Activity Bar WebviewViewProvider (antigravityTab.sidebarView) MUST be registered'
    );

    const viewMsgListeners = [];
    const visibilityListeners = [];
    const mockActivityBarView = {
      visible: false,
      webview: {
        options: {},
        html: '',
        onDidReceiveMessage(fn) {
          viewMsgListeners.push(fn);
        }
      },
      onDidChangeVisibility(fn) {
        visibilityListeners.push(fn);
      }
    };

    activityBarProvider.resolveWebviewView(mockActivityBarView);
    assert.equal(
      mockActivityBarView.webview.html.includes('Detach Agent to Floating Window'),
      true,
      'Activity Bar view HTML should show Detach Agent to Floating Window when attached'
    );
    assert.equal(
      harness.contextKeys.get('antigravityTab.isDetached'),
      false,
      'Context key antigravityTab.isDetached should be false when attached'
    );

    // Simulate clicking the Activity Bar icon on the left side (making the view visible)
    mockActivityBarView.visible = true;
    for (const fn of visibilityListeners) {
      await fn();
    }
    await sleep(150);

    assert.equal(
      reload2.api.isDetached(),
      true,
      'Clicking the Activity Bar icon on the left side should detach the Agent into a floating window'
    );
    assert.equal(
      harness.contextKeys.get('antigravityTab.isDetached'),
      true,
      'Context key antigravityTab.isDetached should update to true when detached'
    );
    assert.equal(
      mockActivityBarView.webview.html.includes('Reattach Agent to Side Panel'),
      true,
      'Activity Bar view HTML should update to Reattach Agent to Side Panel when detached'
    );

    // Simulate clicking the Reattach button inside the Activity Bar view
    for (const fn of viewMsgListeners) {
      await fn({ type: 'action', action: 'reattach' });
    }
    assert.equal(
      reload2.api.isDetached(),
      false,
      'Clicking Reattach inside the Activity Bar view should reattach the Agent to the side panel'
    );
    assert.equal(
      harness.getOpenWindowCount(),
      1,
      'Only 1 IDE window should remain open after reattaching via Activity Bar view'
    );
    console.log('  ✓ Passed\n');

    console.log('ALL 10 INTEGRATION TESTS PASSED SUCCESSFULLY!');
  } finally {
    Module._load = origLoad;
  }
}

runIntegrationTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
