"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const WINDOW_CLASS = "clawd-on-desk";
const ADDRESS = /^0x[0-9a-f]+$/;
const SOCKET_TIMEOUT_MS = 500;
const RECONCILE_INTERVAL_MS = 1000;
const FOCUS_RESTORE_DELAY_MS = 150;
const REHOME_SETTLE_MS = 250;
const DEBUG_LINE_LIMIT = 400;
const DISPLAY_EVENTS = ["display-added", "display-removed", "display-metrics-changed"];
const MONITOR_EVENTS = new Set(["workspacev2", "focusedmonv2", "monitoraddedv2", "monitorremovedv2"]);
const DEBUG_EVENTS = new Set(["openwindow", "closewindow", "activewindowv2", "configreloaded", ...MONITOR_EVENTS]);
const DEBUG_WINDOW_METHODS = ["focus", "show", "showInactive", "moveTop", "setAlwaysOnTop"];
const ROLE_FOCUS_RULES = Object.freeze({
  render: { focus: "no_focus = true" },
  hit: {},
  permission: {},
  "permission-queue": {},
  hud: {},
  "quota-ring": {},
  "update-bubble": {},
  "menu-owner": { pin: false },
  "resume-input": {},
  "roam-fence": {},
});

let activePlacement = null;

function luaQuote(value) {
  // Lua uses decimal escapes for control bytes. JSON's \u escapes are invalid.
  return '"' + value.replace(/["\\\x00-\x1f\x7f]/g, (char) => {
    if (char === '"' || char === "\\") return "\\" + char;
    return "\\" + String(char.charCodeAt(0)).padStart(3, "0");
  }) + '"';
}

function buildRuleCommand() {
  const rules = Object.entries(ROLE_FOCUS_RULES).map(([role, rule]) => {
    const { focus = "no_initial_focus = true, no_follow_mouse = true", pin = true } = rule;
    const name = luaQuote(`${WINDOW_CLASS}-native-${role}`);
    const title = luaQuote(`^clawd·${role}·[0-9]+·[0-9]+$`);
    return `hl.window_rule({ name = ${name}, match = { class = "^(clawd-on-desk)$", title = ${title} }, ` +
      `float = true, ${pin ? "pin = true, " : ""}no_anim = true, no_shadow = true, no_blur = true, no_dim = true, ` +
      `decorate = false, border_size = 0, rounding = 0, ${focus} })`;
  });
  return "eval " + rules.join("; ");
}

function positionOf(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const point = { x: Math.round(x), y: Math.round(y) };
  return Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) ? point : null;
}

function buildMove(address, position, workspaceId) {
  const selector = luaQuote(`address:${address}`);
  const move = `hl.dispatch(hl.dsp.window.move({ window = ${selector}, x = ${position.x}, y = ${position.y} }))`;
  if (!Number.isSafeInteger(workspaceId)) return move;
  const workspace = luaQuote(String(workspaceId));
  return `hl.dispatch(hl.dsp.window.move({ window = ${selector}, workspace = ${workspace} })); ${move}`;
}

function noWarpEval(lua) {
  return 'eval local prev = hl.get_config("cursor:no_warps"); hl.config({ cursor = { no_warps = true } }); ' +
    lua + "; hl.config({ cursor = { no_warps = prev } })";
}

function monitorLayout(monitor) {
  if (!monitor || !Number.isSafeInteger(monitor.id) || monitor.id < 0 ||
      !Number.isFinite(monitor.x) || !Number.isFinite(monitor.y) ||
      !Number.isSafeInteger(monitor.width) || !Number.isSafeInteger(monitor.height) ||
      !Number.isFinite(monitor.scale) || monitor.scale <= 0 ||
      !Number.isInteger(monitor.transform) || monitor.transform < 0 || monitor.transform > 7) return null;
  const rotated = monitor.transform % 2;
  const width = Math.round((rotated ? monitor.height : monitor.width) / monitor.scale);
  const height = Math.round((rotated ? monitor.width : monitor.height) / monitor.scale);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return null;
  return { id: monitor.id, x: monitor.x, y: monitor.y, width, height, workspaceId: monitor.activeWorkspace?.id };
}

function eventAddress(raw) {
  const address = raw.startsWith("0x") ? raw : `0x${raw}`;
  return ADDRESS.test(address) ? address : null;
}

// Electron 41's browser-window-created event exposes the window but has no
// public frame getter or constructor coordinates. Read the actual options and
// supply the title at construction so it can match rules on the first map.
function createOverlayWindow(BrowserWindow, role, options) {
  if (!activePlacement || options.frame !== false || !Object.hasOwn(ROLE_FOCUS_RULES, role)) {
    return new BrowserWindow(options);
  }
  return activePlacement.createWindow(BrowserWindow, role, options);
}

function isHyprlandPlacementActive() {
  return activePlacement !== null;
}

function setHyprlandMenuOpen(open) {
  activePlacement?.setMenuOpen(open);
}

// A focus change while a mouse button is held breaks the drag (measured live:
// the press on the hit window never produced a move). Hold the restore from
// pointer-down (drag-lock true) until release (drag-lock false).
function setHyprlandPointerHeld(held) {
  activePlacement?.setPointerHeld(held);
}

function logHyprlandMenu(action, win) {
  activePlacement?.logMenu?.(action, win);
}

function patchWindow(entry, queuePosition, debug) {
  const { win } = entry;
  const original = {
    setPosition: win.setPosition,
    setBounds: win.setBounds,
    setContentBounds: win.setContentBounds,
    getBounds: win.getBounds,
    getContentBounds: win.getContentBounds,
    getPosition: win.getPosition,
  };
  const preventPageTitle = (event) => event.preventDefault();
  // Wayland reports (0,0) for global position even when it is unknown.
  const unknownPosition = { x: undefined, y: undefined };
  win.on("page-title-updated", preventPageTitle);

  function setPosition(x, y) {
    const position = positionOf(x, y);
    if (position) queuePosition(entry, position);
  }

  function getBounds() {
    return { ...original.getBounds.call(win), ...(entry.position ?? unknownPosition) };
  }

  function getContentBounds() {
    return { ...original.getContentBounds.call(win), ...(entry.position ?? unknownPosition) };
  }

  function setBounds(bounds, animate) {
    const { x, y, ...size } = bounds;
    if (x !== undefined || y !== undefined) {
      const current = getBounds();
      setPosition(x === undefined ? current.x : x, y === undefined ? current.y : y);
    }
    if (size.width !== undefined || size.height !== undefined) original.setBounds.call(win, size, animate);
  }

  function setContentBounds(bounds, animate) {
    const { x, y, width, height } = bounds;
    setPosition(x, y);
    win.setContentSize(width, height, animate);
  }

  function getPosition() {
    const { x, y } = entry.position ?? unknownPosition;
    return [x, y];
  }

  Object.assign(win, { setPosition, setBounds, setContentBounds, getBounds, getContentBounds, getPosition });
  if (debug) {
    for (const method of DEBUG_WINDOW_METHODS) {
      const native = win[method];
      if (typeof native !== "function") continue;
      original[method] = native;
      win[method] = function (...args) {
        const caller = new Error().stack?.split("\n")[2]?.trim() ?? "unknown caller";
        debug(`window ${entry.title} ${method}() ${caller}`);
        return native.apply(this, args);
      };
    }
  }
  return () => {
    Object.assign(win, original);
    win.removeListener("page-title-updated", preventPageTitle);
    win.setTitle(entry.originalTitle);
  };
}

async function installHyprlandPlacement({
  app, screen, Notification, platform = process.platform, env = process.env,
  fs: filesystem = fs, net: sockets = net, clock = { setInterval, clearInterval, setTimeout, clearTimeout },
} = {}) {
  if (platform !== "linux" || app.commandLine.getSwitchValue("ozone-platform") !== "wayland") return false;
  const { HYPRLAND_INSTANCE_SIGNATURE: signature, XDG_RUNTIME_DIR: runtimeDir } = env;
  if (!signature || !runtimeDir) return false;

  const socketDir = path.join(runtimeDir, "hypr", signature);
  const commandPath = path.join(socketDir, ".socket.sock");
  const eventsPath = path.join(socketDir, ".socket2.sock");
  const debug = env.CLAWD_HYPRLAND_DEBUG === "1" ? (message) => {
    const line = message.length > DEBUG_LINE_LIMIT ? message.slice(0, DEBUG_LINE_LIMIT) + "…" : message;
    console.log(`[hyprland-placement] ${line}`);
  } : null;
  const windows = new Map();
  const ruleCommand = buildRuleCommand();
  let stopped = false;
  let ready = false;
  let eventSocket;
  let commandSocket;
  let reconcileTimer;
  let scheduled;
  let busy = false;
  let clientsDue = false;
  let rulesDue = false;
  let monitorsDue = false;
  let urgentOwnershipCheck = false;
  let monitors = [];
  let activeAddress = null;
  let lastNonOverlayAddress = null;
  // Hyprland sends activewindow>>CLASS,TITLE right before activewindowv2>>ADDR.
  // A Clawd window (this or another instance) must never become the restore
  // target, even before its address is known (addresses are also reused).
  let lastActiveClass = null;
  let previousNonOverlayAddress = null;
  let focusRestore = null;
  let menuOpen = false;
  let pointerHeld = false;

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    if (ready) activePlacement = null;
    if (reconcileTimer) clock.clearInterval(reconcileTimer);
    if (scheduled) clearImmediate(scheduled);
    cancelFocusRestore();
    for (const event of DISPLAY_EVENTS) screen.removeListener(event, onDisplayChange);
    app.removeListener("before-quit", onQuit);
    commandSocket?.destroy();
    eventSocket?.destroy();
    for (const entry of windows.values()) {
      clearSettleTimer(entry);
      entry.win.removeListener("closed", entry.onClosed);
      entry.win.removeListener("show", refreshClients);
      removeMenuListeners(entry);
      if (!entry.win.isDestroyed()) entry.restore();
    }
    windows.clear();
    if (reason) {
      const body = "Run Clawd in XWayland mode (CLAWD_OZONE_PLATFORM=x11).";
      console.warn(`Clawd: Hyprland placement disabled (${reason}). ${body}`);
      try {
        if (Notification?.isSupported()) new Notification({ title: "Clawd placement unavailable", body }).show();
      } catch {}
    }
  }

  function onQuit() { stop(); }

  function request(command, shouldWrite, onSend) {
    return new Promise((resolve, reject) => {
      const socket = sockets.createConnection({ path: commandPath, timeout: SOCKET_TIMEOUT_MS });
      commandSocket = socket;
      let reply = "";
      let ended = false;
      let failure;
      let cancelled = false;
      socket.unref();
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        if (shouldWrite && !shouldWrite()) {
          cancelled = true;
          socket.destroy();
          return;
        }
        debug?.(`command ${command}`);
        onSend?.();
        socket.write(command);
      });
      socket.on("data", (chunk) => { reply += chunk; });
      socket.once("end", () => { ended = true; });
      socket.on("error", (err) => { failure = `command socket error (${err.code || "unknown"})`; });
      socket.once("timeout", () => {
        failure = "command socket timeout";
        socket.destroy();
      });
      socket.once("close", () => {
        commandSocket = null;
        if (cancelled) resolve(null);
        else if (failure || !ended) reject(new Error(failure || "command socket closed before reply"));
        else resolve(reply.trim());
      });
    });
  }

  async function installRules() {
    if (await request(ruleCommand) !== "ok") throw new Error("window rule install failed");
  }

  function schedule() {
    if (!ready || stopped || scheduled || busy) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      void flush();
    });
    scheduled.unref();
  }

  function refreshClients() {
    clientsDue = true;
    schedule();
  }

  function clearSettleTimer(entry) {
    if (entry.settleTimer) clock.clearTimeout(entry.settleTimer);
    entry.settleTimer = null;
  }

  function queuePosition(entry, position) {
    if (entry.position?.x !== position.x || entry.position?.y !== position.y) {
      clearSettleTimer(entry);
      entry.position = position;
      entry.positionRevision++;
      entry.rehomeDue = false;
      entry.settleTimer = clock.setTimeout(() => {
        entry.settleTimer = null;
        entry.rehomeDue = true;
        schedule();
      }, REHOME_SETTLE_MS);
      entry.settleTimer.unref();
    }
    entry.pendingMove = true;
    schedule();
  }

  function refreshMonitors() {
    monitorsDue = true;
    schedule();
  }

  function onDisplayChange() {
    refreshMonitors();
    refreshClients();
  }

  async function readMonitors() {
    monitorsDue = false;
    const reply = JSON.parse(await request("j/monitors"));
    if (!Array.isArray(reply)) throw new Error("invalid monitor list");
    monitors = reply.map(monitorLayout).filter(Boolean);
  }

  function findOverlay(address) {
    for (const entry of windows.values()) {
      if (entry.address === address) return entry;
    }
    return null;
  }

  function cancelFocusRestore(reason) {
    if (focusRestore && reason) debug?.(`focus skipped ${focusRestore.entry.title}: ${reason}`);
    if (focusRestore?.timer) clock.clearTimeout(focusRestore.timer);
    focusRestore = null;
  }

  function dueFocusRestore() {
    const restore = focusRestore;
    if (menuOpen || pointerHeld || !restore || restore.timer || restore.target !== lastNonOverlayAddress) return null;
    if (restore.entry.role === "menu-owner") {
      return restore.menuDismissed && (activeAddress === restore.source || activeAddress === null) ? restore : null;
    }
    const sourceActive = activeAddress === restore.source || (restore.duringMenu && activeAddress === null);
    return sourceActive && restore.entry.address === restore.source ? restore : null;
  }

  function setMenuOpen(open) {
    if (menuOpen === open) return;
    menuOpen = open;
    if (!focusRestore) return;
    if (open) {
      focusRestore.duringMenu = true;
      debug?.(`focus deferred ${focusRestore.entry.title}: native menu open`);
    } else {
      if (focusRestore.timer) clock.clearTimeout(focusRestore.timer);
      focusRestore.timer = null;
      if (dueFocusRestore()) schedule();
      else debug?.(`focus skipped ${focusRestore.entry.title}: source no longer active`);
    }
  }

  function setPointerHeld(held) {
    if (pointerHeld === held) return;
    pointerHeld = held;
    if (!focusRestore) return;
    if (held) {
      debug?.(`focus deferred ${focusRestore.entry.title}: pointer held`);
    } else if (!focusRestore.timer) {
      if (dueFocusRestore()) schedule();
      else debug?.(`focus skipped ${focusRestore.entry.title}: source no longer active`);
    }
  }

  function startFocusRestore(entry) {
    if (!lastNonOverlayAddress || (entry.focusable && entry.role !== "menu-owner")) {
      debug?.(`focus skipped ${entry.title}: ${!lastNonOverlayAddress ? "no previous window" : "keyboard input enabled"}`);
      return;
    }
    const restore = {
      entry, source: entry.address, target: lastNonOverlayAddress, menuDismissed: false, duringMenu: menuOpen,
    };
    restore.timer = clock.setTimeout(() => {
      restore.timer = null;
      if (dueFocusRestore()) schedule();
      else debug?.(`focus deferred ${entry.title}: ${menuOpen ? "native menu open" : pointerHeld ? "pointer held" : "waiting for menu owner dismissal"}`);
    }, FOCUS_RESTORE_DELAY_MS);
    restore.timer.unref();
    focusRestore = restore;
    debug?.(`focus scheduled ${entry.title} ${restore.source} -> ${restore.target}`);
  }

  function onActiveWindow(address) {
    if (address === activeAddress) return;
    activeAddress = address;
    // Unmapping a menu can leave no active window. Keep its restore available
    // until the owner hides or blurs, or a different window becomes active.
    if (address === null && (focusRestore?.entry.role === "menu-owner" || focusRestore?.duringMenu)) return;
    cancelFocusRestore("active window changed");
    if (!address) return;
    const entry = findOverlay(address);
    if (entry) {
      startFocusRestore(entry);
    } else if (lastActiveClass === WINDOW_CLASS) {
      debug?.(`focus target ignored ${address}: ${WINDOW_CLASS} window`);
    } else if (address !== lastNonOverlayAddress) {
      previousNonOverlayAddress = lastNonOverlayAddress;
      lastNonOverlayAddress = address;
    }
  }

  function onOverlayInactive(entry) {
    if (focusRestore?.entry !== entry) return;
    if (entry.role === "menu-owner") {
      focusRestore.menuDismissed = true;
      if (dueFocusRestore()) schedule();
    } else {
      cancelFocusRestore("overlay unmapped");
    }
  }

  function removeMenuListeners(entry) {
    if (!entry.onMenuDismissed) return;
    entry.win.removeListener("hide", entry.onMenuDismissed);
    entry.win.removeListener("blur", entry.onMenuDismissed);
  }

  function setAddress(entry, address) {
    if (entry.address === address) return;
    if (!address) onOverlayInactive(entry);
    if (entry.address && entry.position) entry.pendingMove = true;
    entry.address = address;
    entry.addressRevision++;
    entry.clientKnown = false;
    entry.monitorId = null;
    if (address && entry.position && !entry.settleTimer) entry.rehomeDue = true;
    // Focus can arrive before openwindow or a j/clients snapshot identifies the overlay.
    if (address) {
      if (previousNonOverlayAddress === address) previousNonOverlayAddress = null;
      if (lastNonOverlayAddress === address) {
        lastNonOverlayAddress = previousNonOverlayAddress;
        previousNonOverlayAddress = null;
      }
      if (focusRestore?.target === address) cancelFocusRestore("target identified as an overlay");
      if (activeAddress === address) {
        cancelFocusRestore("overlay address updated");
        startFocusRestore(entry);
      }
    }
    schedule();
  }

  async function reconcileClients() {
    // The event stream can map or unmap a window while this snapshot is in flight.
    const snapshot = [...windows.values()].map((entry) => [entry, entry.addressRevision]);
    const clients = JSON.parse(await request("j/clients"));
    if (!Array.isArray(clients)) throw new Error("invalid client list");
    if (stopped) return;

    const byTitle = new Map();
    for (const client of clients) {
      if (client?.class === WINDOW_CLASS && client.pid === process.pid && client.xwayland === false &&
          typeof client.address === "string" && ADDRESS.test(client.address)) {
        byTitle.set(client.title, client);
      }
    }
    for (const [entry, revision] of snapshot) {
      if (windows.get(entry.title) !== entry || revision !== entry.addressRevision) continue;
      const client = byTitle.get(entry.title);
      setAddress(entry, client?.address ?? null);
      if (client) {
        entry.clientKnown = true;
        const workspaceId = client.workspace?.id;
        entry.monitorId = Number.isSafeInteger(client.monitor) && client.monitor >= 0 ? client.monitor
          : Number.isSafeInteger(workspaceId) ? monitors.find((monitor) => monitor.workspaceId === workspaceId)?.id ?? null
            : null;
      }
      // Keep the requested point through a drag or an outstanding re-home.
      if (!client || entry.pendingMove || entry.settleTimer || entry.rehomeDue || !Array.isArray(client.at)) continue;
      const position = positionOf(client.at[0], client.at[1]);
      if (!position) continue;
      const previous = entry.position;
      entry.position = position;
      if (previous && (position.x !== previous.x || position.y !== previous.y)) {
        // Electron cannot see compositor moves. Wake the existing geometry reconcile.
        entry.win.emit("move");
      }
    }
  }

  async function flush() {
    busy = true;
    try {
      const restore = dueFocusRestore();
      if (rulesDue) {
        rulesDue = false;
        await installRules();
      } else if (restore) {
        const target = luaQuote(`address:${restore.target}`);
        // Recheck at socket connect, since a focus event can arrive after
        // the debounce while waiting to send the IPC command.
        const outcome = await request(
          noWarpEval(`hl.dispatch(hl.dsp.focus({ window = ${target} }))`),
          () => dueFocusRestore() === restore,
          debug && (() => debug(`focus sent ${restore.entry.title} -> ${restore.target}`)),
        );
        if (outcome === null) debug?.(`focus skipped ${restore.entry.title}: restore superseded or paused before send`);
        if (outcome !== null && focusRestore === restore) cancelFocusRestore();
      } else if (monitorsDue) {
        await readMonitors();
        urgentOwnershipCheck = true;
      } else {
        const urgent = urgentOwnershipCheck;
        urgentOwnershipCheck = false;
        const moves = [];
        const writes = [];
        for (const entry of windows.values()) {
          // openwindow provides an address but has no monitor ID. Wait for
          // j/clients so the first move can re-home as well as position.
          if (!entry.clientKnown || !entry.position || (!entry.pendingMove && !entry.rehomeDue && !urgent)) continue;
          const { x, y } = entry.position;
          const destination = monitors.find((monitor) => (
            x >= monitor.x && x < monitor.x + monitor.width && y >= monitor.y && y < monitor.y + monitor.height
          ));
          const rehome = (entry.rehomeDue || urgent) && entry.monitorId !== null &&
            destination && destination.id !== entry.monitorId &&
            Number.isSafeInteger(destination.workspaceId);
          const { pendingMove, rehomeDue, positionRevision } = entry;
          entry.rehomeDue = false;
          if (!pendingMove && !rehome) continue;
          moves.push(buildMove(entry.address, entry.position, rehome ? destination.workspaceId : null));
          writes.push({
            entry, revision: entry.addressRevision, monitorId: rehome ? destination.id : null,
            positionRevision, pendingMove, rehomeDue,
          });
          entry.pendingMove = false;
        }
        if (moves.length) {
          const lua = moves.join("; ");
          const command = writes.some(({ monitorId }) => monitorId !== null) ? noWarpEval(lua) : "eval " + lua;
          const outcome = await request(command, () => !monitorsDue && writes.every((write) => (
            windows.get(write.entry.title) === write.entry &&
            write.entry.addressRevision === write.revision &&
            (write.monitorId === null || write.entry.positionRevision === write.positionRevision)
          )));
          if (outcome === null && urgent) urgentOwnershipCheck = true;
          for (const { entry, revision, monitorId, positionRevision, pendingMove, rehomeDue } of writes) {
            if (entry.addressRevision !== revision) continue;
            if (outcome === null) {
              entry.pendingMove ||= pendingMove;
              if (entry.positionRevision === positionRevision) entry.rehomeDue ||= rehomeDue;
            } else if (outcome === "ok" && monitorId !== null) {
              entry.monitorId = monitorId;
            }
          }
          if (outcome !== null && outcome !== "ok") clientsDue = true;
        }
        if (!stopped && clientsDue && !rulesDue && !monitorsDue && !urgentOwnershipCheck) {
          clientsDue = false;
          if (windows.size) await reconcileClients();
        }
      }
    } catch (err) {
      stop(err.message);
    } finally {
      busy = false;
      // Writes queued during an IPC request join the next setImmediate batch.
      if (rulesDue || clientsDue || monitorsDue || urgentOwnershipCheck || dueFocusRestore() ||
          [...windows.values()].some((entry) => entry.clientKnown && (entry.pendingMove || entry.rehomeDue))) {
        schedule();
      }
    }
  }

  function receiveEvent(line) {
    const event = line.split(">>", 1)[0];
    if (debug && DEBUG_EVENTS.has(event)) debug(`event ${line}`);
    if (MONITOR_EVENTS.has(event)) {
      refreshMonitors();
      return;
    }
    if (line === "configreloaded>>") {
      rulesDue = true;
      schedule();
      return;
    }
    const activeV1 = /^activewindow>>([^,]*),/.exec(line);
    if (activeV1) {
      lastActiveClass = activeV1[1];
      return;
    }
    const active = /^activewindowv2>>(.*)$/.exec(line);
    if (active) {
      const address = eventAddress(active[1]);
      if (address || !active[1]) onActiveWindow(address);
      return;
    }
    const opened = /^openwindow>>([^,]+),[^,]*,([^,]+),(.*)$/.exec(line);
    const closed = /^closewindow>>(.+)$/.exec(line);
    if (!opened && !closed) return;
    const address = eventAddress((opened || closed)[1]);
    if (!address) return;
    if (opened) {
      if (opened[2] !== WINDOW_CLASS) return;
      const entry = windows.get(opened[3]);
      if (entry) {
        setAddress(entry, address);
        refreshClients();
      }
    } else {
      if (lastNonOverlayAddress === address) lastNonOverlayAddress = null;
      if (previousNonOverlayAddress === address) previousNonOverlayAddress = null;
      if (focusRestore?.target === address) cancelFocusRestore("target closed");
      if (activeAddress === address) onActiveWindow(null);
      const entry = findOverlay(address);
      if (entry) setAddress(entry, null);
    }
  }

  function connectEvents() {
    return new Promise((resolve, reject) => {
      const socket = sockets.createConnection({ path: eventsPath, timeout: SOCKET_TIMEOUT_MS });
      eventSocket = socket;
      let buffer = "";
      let failure;
      socket.unref();
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.setTimeout(0);
        resolve();
      });
      socket.on("data", (chunk) => {
        if (stopped) return;
        const lines = (buffer + chunk).split("\n");
        buffer = lines.pop();
        for (const line of lines) receiveEvent(line);
      });
      socket.on("error", (err) => { failure = `event socket error (${err.code || "unknown"})`; });
      socket.once("timeout", () => {
        failure = "event socket timeout";
        socket.destroy();
      });
      socket.once("close", () => {
        const reason = failure || "event socket closed";
        reject(new Error(reason));
        stop(reason);
      });
    });
  }

  try {
    if (!filesystem.existsSync(commandPath)) throw new Error("Hyprland socket unavailable");
    app.once("before-quit", onQuit);
    await connectEvents();
    while (!stopped) {
      rulesDue = false;
      await installRules();
      if (stopped) break;
      await readMonitors();
      if (!rulesDue) break;
    }
    if (stopped) return false;
  } catch (err) {
    stop(err.message);
    return false;
  }

  let sequence = 0;
  function createWindow(BrowserWindow, role, options) {
    const title = `clawd·${role}·${process.pid}·${++sequence}`;
    const win = new BrowserWindow({ ...options, title });
    const position = positionOf(options.x, options.y);
    const entry = {
      // Electron defaults focusable to true, including the resume input.
      win, title, role, focusable: options.focusable !== false, originalTitle: options.title ?? app.getName(),
      position: null, positionRevision: 0, settleTimer: null, rehomeDue: false,
      pendingMove: false, address: null, addressRevision: 0, clientKnown: false, monitorId: null,
    };
    entry.restore = patchWindow(entry, queuePosition, debug);
    entry.onClosed = () => {
      clearSettleTimer(entry);
      onOverlayInactive(entry);
      removeMenuListeners(entry);
      windows.delete(title);
    };
    if (role === "menu-owner") {
      entry.onMenuDismissed = () => onOverlayInactive(entry);
      win.on("hide", entry.onMenuDismissed);
      win.on("blur", entry.onMenuDismissed);
    }
    windows.set(title, entry);
    win.once("closed", entry.onClosed);
    win.on("show", refreshClients);
    if (position) queuePosition(entry, position);
    refreshClients();
    return win;
  }
  activePlacement = {
    createWindow, setMenuOpen, setPointerHeld,
    logMenu: debug && ((action, win) => {
      const entry = [...windows.values()].find((candidate) => candidate.win === win);
      debug(`menu ${action} host=${entry?.title ?? "untracked"}`);
    }),
  };
  ready = true;
  for (const event of DISPLAY_EVENTS) screen.on(event, onDisplayChange);
  if (monitorsDue) schedule();
  reconcileTimer = clock.setInterval(refreshClients, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
  return true;
}

module.exports = {
  createOverlayWindow, installHyprlandPlacement, isHyprlandPlacementActive, setHyprlandMenuOpen, setHyprlandPointerHeld,
  logHyprlandMenu, luaQuote,
};
