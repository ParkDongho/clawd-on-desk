"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { physicalToDipPoint } = require("./linux-x11-cursor");

const CURSOR_INTERVAL_MS = 33;
const MONITOR_INTERVAL_MS = 2000;
const MAX_CURSOR_AGE_MS = 150;
const SOCKET_TIMEOUT_MS = 150;
const DISPLAY_EVENTS = ["display-added", "display-removed", "display-metrics-changed"];
const defaultClock = { now: () => performance.now(), setInterval, clearInterval };

function isPoint(value) {
  return value != null && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function groupBySize(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.width}x${item.height}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function matchMonitorsToDisplays(monitors, displays) {
  if (!Array.isArray(monitors) || !monitors.length || !monitors.every((monitor) => (
    isPoint(monitor) && Number.isInteger(monitor.id) &&
    Number.isInteger(monitor.width) && monitor.width > 0 &&
    Number.isInteger(monitor.height) && monitor.height > 0 &&
    Number.isFinite(monitor.scale) && monitor.scale > 0 &&
    Number.isInteger(monitor.transform) && monitor.transform >= 0 && monitor.transform <= 7
  ))) return { reason: "invalid monitor layout" };
  if (!Array.isArray(displays) || displays.length !== monitors.length) {
    return { reason: "monitor/display count mismatch" };
  }
  if (!displays.every((display) => (
    isPoint(display?.nativeOrigin) && isPoint(display.bounds) &&
    Number.isFinite(display.bounds.width) && display.bounds.width > 0 &&
    Number.isFinite(display.bounds.height) && display.bounds.height > 0 &&
    Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
  ))) return { reason: "invalid X11 display geometry" };

  const monitorGroups = groupBySize(monitors.map((monitor) => ({
    monitor,
    width: monitor.transform % 2 ? monitor.height : monitor.width,
    height: monitor.transform % 2 ? monitor.width : monitor.height,
  })));
  // Electron's display bounds already include rotation and are in DIP.
  const displayGroups = groupBySize(displays.map((display) => ({
    display,
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  })));

  let mode = "physical-size";
  const pairs = [];
  for (const [key, sameSizeMonitors] of monitorGroups) {
    const sameSizeDisplays = displayGroups.get(key);
    if (sameSizeDisplays?.length !== sameSizeMonitors.length) {
      return { reason: "monitor/display physical size mismatch" };
    }
    if (sameSizeMonitors.length > 1) {
      mode = "id-order";
      sameSizeMonitors.sort((a, b) => a.monitor.id - b.monitor.id);
      sameSizeDisplays.sort((a, b) => a.display.nativeOrigin.x - b.display.nativeOrigin.x);
      if (sameSizeMonitors.some(({ monitor }, index) => index > 0 && (
        monitor.id === sameSizeMonitors[index - 1].monitor.id ||
        sameSizeDisplays[index].display.nativeOrigin.x === sameSizeDisplays[index - 1].display.nativeOrigin.x
      ))) return { reason: "ambiguous monitor/display order" };
    }
    for (const [index, geometry] of sameSizeMonitors.entries()) {
      pairs.push({ ...geometry, display: sameSizeDisplays[index].display });
    }
  }
  return { mode, pairs, displays };
}

function convertHyprlandPoint(point, matching) {
  if (!isPoint(point) || !matching?.pairs) return null;
  for (const { monitor, width, height, display } of matching.pairs) {
    const dx = point.x - monitor.x;
    const dy = point.y - monitor.y;
    if (dx < 0 || dy < 0 || dx >= width / monitor.scale || dy >= height / monitor.scale) continue;
    return physicalToDipPoint(matching.displays, {
      x: display.nativeOrigin.x + dx * monitor.scale,
      y: display.nativeOrigin.y + dy * monitor.scale,
    });
  }
  return null;
}

function readHyprlandJson(socket, command) {
  return new Promise((resolve, reject) => {
    let reply = "";
    let ended = false;
    let failure;
    socket.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(command));
    socket.on("data", (chunk) => { reply += chunk; });
    socket.once("end", () => { ended = true; });
    socket.on("error", (err) => { failure = `socket error (${err.code || "unknown"})`; });
    socket.once("timeout", () => {
      failure = "socket timeout";
      socket.destroy();
    });
    // Wait for close so the next request always opens a fresh connection.
    socket.once("close", () => {
      if (failure || !ended) return reject(new Error(failure || "socket closed before reply"));
      try {
        resolve(JSON.parse(reply));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
  });
}

function installHyprlandCursor(screen, options = {}) {
  const {
    app, platform = process.platform, env = process.env,
    fs: filesystem = fs, net: sockets = net, clock = defaultClock,
  } = options;
  const { HYPRLAND_INSTANCE_SIGNATURE: signature, XDG_RUNTIME_DIR: runtimeDir } = env;
  const logged = new Set();
  function report(status, reason, mode = "none") {
    const message = `Clawd: Hyprland cursor ${status} (reason=${reason}, matching=${mode})`;
    // Failure reasons can recur on every poll, even after a recovery.
    const key = status === "enabled" ? mode : reason;
    if (logged.has(key)) return;
    logged.add(key);
    if (status === "enabled") console.log(message);
    else console.warn(message);
  }
  function disabled(reason) {
    report("disabled", reason);
    return false;
  }

  if (platform !== "linux" || app.commandLine.getSwitchValue("ozone-platform") !== "x11") {
    return disabled("requires Linux with the X11 ozone backend");
  }
  if (!signature || !runtimeDir) return disabled("missing Hyprland environment");
  const socketPath = path.join(runtimeDir, "hypr", signature, ".socket.sock");
  if (!filesystem.existsSync(socketPath)) return disabled("Hyprland socket unavailable");

  const previous = screen.getCursorScreenPoint;
  let sample = null;
  let matching = null;
  let activeSocket = null;
  let monitorsDue = false;
  let displayRevision = 0;
  let stopped = false;

  function getCursorScreenPoint() {
    if (sample && matching && clock.now() - sample.at <= MAX_CURSOR_AGE_MS) {
      const point = convertHyprlandPoint(sample, matching);
      if (point) return point;
    }
    return previous.call(screen);
  }

  async function poll(command) {
    if (stopped || activeSocket) return;
    const refresh = command === "j/monitors";
    const revision = displayRevision;
    if (refresh) monitorsDue = false;
    try {
      activeSocket = sockets.createConnection({ path: socketPath, timeout: SOCKET_TIMEOUT_MS });
      const value = await readHyprlandJson(activeSocket, command);
      if (stopped || revision !== displayRevision) return;
      if (refresh) {
        const result = matchMonitorsToDisplays(value, screen.getAllDisplays());
        matching = result.pairs ? result : null;
        if (matching) report("enabled", "monitor layout matched", matching.mode);
        else report("disabled", result.reason);
      } else {
        if (!isPoint(value)) throw new Error("invalid cursor position");
        sample = { x: value.x, y: value.y, at: clock.now() };
      }
    } catch (err) {
      if (stopped || revision !== displayRevision) return;
      if (refresh) {
        matching = null;
        report("disabled", err.message);
      } else {
        sample = null;
        report("sample unavailable", err.message, matching?.mode);
      }
    } finally {
      activeSocket = null;
      if (monitorsDue && !stopped) void poll("j/monitors");
    }
  }

  function refreshMonitors() {
    monitorsDue = true;
    void poll("j/monitors");
  }
  function onDisplayChange() {
    displayRevision += 1;
    matching = null;
    sample = null;
    refreshMonitors();
  }

  screen.getCursorScreenPoint = getCursorScreenPoint;
  for (const event of DISPLAY_EVENTS) screen.on(event, onDisplayChange);
  const cursorTimer = clock.setInterval(() => void poll("j/cursorpos"), CURSOR_INTERVAL_MS);
  const monitorTimer = clock.setInterval(refreshMonitors, MONITOR_INTERVAL_MS);
  cursorTimer.unref();
  monitorTimer.unref();
  app.once("before-quit", () => {
    stopped = true;
    sample = null;
    clock.clearInterval(cursorTimer);
    clock.clearInterval(monitorTimer);
    for (const event of DISPLAY_EVENTS) screen.removeListener(event, onDisplayChange);
    activeSocket?.destroy();
    if (screen.getCursorScreenPoint === getCursorScreenPoint) screen.getCursorScreenPoint = previous;
  });
  refreshMonitors();
  return true;
}

module.exports = { matchMonitorsToDisplays, convertHyprlandPoint, installHyprlandCursor };
