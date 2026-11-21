"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  matchMonitorsToDisplays, convertHyprlandPoint, installHyprlandCursor,
} = require("../src/hyprland-cursor");
const { installLinuxX11CursorFallback } = require("../src/linux-x11-cursor");

const MONITORS = [
  { id: 0, name: "eDP-1", x: 5757, y: 1546, width: 1920, height: 1200, scale: 1.2, transform: 0 },
  { id: 1, name: "DP-1", x: 3837, y: 1466, width: 1920, height: 1080, scale: 1, transform: 0 },
  { id: 2, name: "DP-2", x: 2837, y: 1466, width: 2560, height: 1600, scale: 1.6, transform: 1 },
];
const DISPLAYS = [
  {
    bounds: { x: 0, y: 0, width: 1920, height: 1200 }, nativeOrigin: { x: 0, y: 0 },
    scaleFactor: 1, rotation: 0, label: "Built-in display",
  },
  {
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, nativeOrigin: { x: 1920, y: 0 },
    scaleFactor: 1, rotation: 0, label: "",
  },
  {
    bounds: { x: 3840, y: 0, width: 1600, height: 2560 }, nativeOrigin: { x: 3840, y: 0 },
    scaleFactor: 1, rotation: 90, label: "",
  },
];

const HYPR_POINT = { x: 4333, y: 2130 };
const CONVERTED_POINT = { x: 2416, y: 664 };
const X11_POINT = { x: 1, y: 2 };
const ELECTRON_POINT = { x: 3, y: 4 };

test("maps the three measured Hyprland outputs by rotated physical size", () => {
  const matching = matchMonitorsToDisplays(MONITORS, [...DISPLAYS].reverse());
  assert.equal(matching.mode, "physical-size");
  assert.deepEqual(convertHyprlandPoint(HYPR_POINT, matching), CONVERTED_POINT);
  assert.deepEqual(convertHyprlandPoint({ x: 6057, y: 1746 }, matching), { x: 360, y: 240 });
  assert.deepEqual(convertHyprlandPoint({ x: 3637, y: 2866 }, matching), { x: 5120, y: 2240 });
  assert.equal(convertHyprlandPoint({ x: 5757, y: 1466 }, matching), null);
});

test("converts physical pixels back to DIP on mixed-scale displays", () => {
  const display = { ...DISPLAYS[0], bounds: { x: -960, y: 0, width: 960, height: 600 }, scaleFactor: 2 };
  const matching = matchMonitorsToDisplays([MONITORS[0]], [display]);
  assert.deepEqual(convertHyprlandPoint({ x: 6057, y: 1746 }, matching), { x: -780, y: 120 });
});

test("uses ID and native X order for colliding sizes and retains unique matches", () => {
  const monitors = [{ ...MONITORS[1], height: 1200 }, MONITORS[2], MONITORS[0]];
  const displays = [
    DISPLAYS[2],
    { ...DISPLAYS[1], bounds: { ...DISPLAYS[1].bounds, height: 1200 }, label: "eDP-1" },
    { ...DISPLAYS[0], label: "DP-1" },
  ];
  const matching = matchMonitorsToDisplays(monitors, displays);
  assert.equal(matching.mode, "id-order");
  assert.deepEqual(convertHyprlandPoint(HYPR_POINT, matching), CONVERTED_POINT);
  assert.deepEqual(convertHyprlandPoint({ x: 6057, y: 1746 }, matching), { x: 360, y: 240 });
  assert.deepEqual(convertHyprlandPoint({ x: 3637, y: 2866 }, matching), { x: 5120, y: 2240 });
});

test("disables conversion when display counts or physical sizes disagree", () => {
  const missing = matchMonitorsToDisplays(MONITORS, DISPLAYS.slice(0, 2));
  assert.equal(missing.reason, "monitor/display count mismatch");
  assert.equal(convertHyprlandPoint(HYPR_POINT, missing), null);
  const wrongSize = matchMonitorsToDisplays(MONITORS, [DISPLAYS[0], DISPLAYS[0], DISPLAYS[2]]);
  assert.equal(wrongSize.reason, "monitor/display physical size mismatch");
  assert.equal(convertHyprlandPoint(HYPR_POINT, wrongSize), null);
});

function harness(t) {
  const log = t.mock.method(console, "log", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  const app = new EventEmitter();
  app.commandLine = { getSwitchValue: (name) => name === "ozone-platform" ? "x11" : "" };
  t.after(() => app.emit("before-quit"));
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => DISPLAYS,
    getCursorScreenPoint: () => ELECTRON_POINT,
  });
  let x11Point = X11_POINT;
  installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => x11Point });
  const previous = screen.getCursorScreenPoint;
  const timers = new Map();
  const sockets = [];
  let now = 0;
  const options = {
    app, platform: "linux",
    env: { HYPRLAND_INSTANCE_SIGNATURE: "test-instance", XDG_RUNTIME_DIR: "/run/user/test" },
    fs: { existsSync(file) {
      assert.equal(file, "/run/user/test/hypr/test-instance/.socket.sock");
      return true;
    } },
    clock: {
      now: () => now,
      setInterval(callback, ms) {
        const timer = { ms, callback, unref() { this.unreferenced = true; } };
        timers.set(ms, timer);
        return timer;
      },
      clearInterval: (timer) => timers.delete(timer.ms),
    },
    net: { createConnection({ path, timeout }) {
      assert.equal(path, "/run/user/test/hypr/test-instance/.socket.sock");
      assert.equal(timeout, 150);
      assert.ok(!sockets.some((socket) => !socket.closed), "overlapping requests");
      const socket = Object.assign(new EventEmitter(), {
        setEncoding(encoding) { assert.equal(encoding, "utf8"); },
        unref() { this.unreferenced = true; },
        write(command) { this.command = command; },
        destroy() {
          this.closed = true;
          this.emit("close");
        },
      });
      sockets.push(socket);
      return socket;
    } },
  };

  function connect(command) {
    const socket = sockets.at(-1);
    assert.ok(socket && !socket.closed);
    assert.ok(socket.unreferenced);
    socket.emit("connect");
    assert.equal(socket.command, command);
    return socket;
  }
  async function reply(command, body) {
    const socket = connect(command);
    socket.emit("data", body.slice(0, 4));
    socket.emit("data", body.slice(4));
    socket.emit("end");
    socket.destroy();
  }
  async function start() {
    assert.equal(installHyprlandCursor(screen, options), true);
    await reply("j/monitors", JSON.stringify(MONITORS));
  }
  async function sample(point = HYPR_POINT) {
    timers.get(33).callback();
    await reply("j/cursorpos", JSON.stringify(point));
  }
  return {
    options, screen, previous, timers, sockets, connect, reply, start, sample, log, warn,
    advance: (ms) => { now += ms; }, useElectronFallback: () => { x11Point = null; },
  };
}

test("returns the fresh Hyprland sample, then falls through X11 to Electron", async (t) => {
  const h = harness(t);
  await h.start();
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  await h.sample();
  h.advance(150);
  assert.deepEqual(h.screen.getCursorScreenPoint(), CONVERTED_POINT);
  h.advance(1);
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  h.useElectronFallback();
  assert.deepEqual(h.screen.getCursorScreenPoint(), ELECTRON_POINT);
  assert.equal(h.log.mock.callCount(), 1);
  assert.match(h.log.mock.calls[0].arguments[0], /enabled.*matching=physical-size/);
  await h.sample({ x: 5757, y: 1466 });
  assert.deepEqual(h.screen.getCursorScreenPoint(), ELECTRON_POINT);
});

test("socket errors, timeouts and malformed replies fall back and log each reason once", async (t) => {
  const h = harness(t);
  await h.start();
  async function failSocket(reason) {
    h.timers.get(33).callback();
    const socket = h.connect("j/cursorpos");
    if (reason === "timeout") socket.emit("timeout");
    else {
      socket.emit("error", Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
      socket.destroy();
    }
  }

  await h.sample();
  await failSocket("error");
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  await failSocket("error");
  await h.sample();
  await failSocket("timeout");
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);

  for (const body of ["invalid json", "invalid json", '{"x":4333,"y":null}']) {
    await h.sample();
    h.timers.get(33).callback();
    await h.reply("j/cursorpos", body);
    assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  }
  assert.equal(h.warn.mock.callCount(), 4);
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), CONVERTED_POINT);
});

test("serializes cursor and monitor requests, including refreshes queued by display events", async (t) => {
  const h = harness(t);
  await h.start();
  assert.ok([...h.timers.values()].every((timer) => timer.unreferenced));
  await h.sample();
  h.timers.get(33).callback();
  h.timers.get(33).callback();
  assert.equal(h.sockets.length, 3);
  h.screen.emit("display-added");
  h.timers.get(2000).callback();
  assert.equal(h.sockets.length, 3);
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);

  await h.reply("j/cursorpos", JSON.stringify(HYPR_POINT));
  h.screen.emit("display-metrics-changed");
  await h.reply("j/monitors", JSON.stringify(MONITORS));
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  await h.reply("j/monitors", JSON.stringify(MONITORS));
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), CONVERTED_POINT);

  h.timers.get(2000).callback();
  await h.reply("j/monitors", JSON.stringify(MONITORS));
  h.screen.emit("display-removed");
  h.options.app.emit("before-quit");
  assert.ok(h.sockets.at(-1).closed);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.screen.eventNames(), []);
  assert.equal(h.screen.getCursorScreenPoint, h.previous);
});

test("falls back on a monitor count mismatch and recovers after a display refresh", async (t) => {
  const h = harness(t);
  h.screen.getAllDisplays = () => DISPLAYS.slice(0, 2);
  await h.start();
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), X11_POINT);
  assert.match(h.warn.mock.calls[0].arguments[0], /disabled.*count mismatch.*matching=none/);

  h.screen.getAllDisplays = () => DISPLAYS;
  h.screen.emit("display-added");
  await h.reply("j/monitors", JSON.stringify(MONITORS));
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), CONVERTED_POINT);
});

test("requires Linux, an explicit resolved ozone backend, and an existing Hyprland socket", (t) => {
  const h = harness(t);
  const { options, screen } = h;
  const cases = [
    { platform: "darwin" },
    { app: { commandLine: { getSwitchValue: () => "auto" } } },
    { env: { XDG_RUNTIME_DIR: "/run/user/test" } },
    { env: { HYPRLAND_INSTANCE_SIGNATURE: "test-instance" } },
    { fs: { existsSync: () => false } },
  ];
  for (const overrides of cases) {
    assert.equal(installHyprlandCursor(screen, { ...options, ...overrides }), false);
    assert.equal(screen.getCursorScreenPoint, h.previous);
  }
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets.length, 0);
});

const WAYLAND_DISPLAYS = [
  { label: "Built-in display (eDP-1)", bounds: { x: 5757, y: 1546, width: 1600, height: 1000 } },
  { label: "Sceptre (DP-1)", bounds: { x: 3837, y: 1466, width: 1920, height: 1080 } },
  { label: "External (DP-2)", bounds: { x: 2837, y: 1466, width: 1000, height: 1600 } },
];

function waylandHarness(t) {
  const h = harness(t);
  h.options.app.commandLine.getSwitchValue = () => "wayland";
  h.screen.getAllDisplays = () => [...WAYLAND_DISPLAYS].reverse();
  h.useElectronFallback();
  return h;
}

test("Wayland installs identity conversion only after matching all displays by connector and rotated logical bounds", async (t) => {
  const h = waylandHarness(t);
  assert.equal(installHyprlandCursor(h.screen, h.options), true);
  assert.equal(h.screen.getCursorScreenPoint, h.previous);
  h.timers.get(33).callback();
  assert.equal(h.sockets.length, 1);
  await h.reply("j/monitors", JSON.stringify(MONITORS));
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), HYPR_POINT);
  await h.sample({ x: 3637, y: 2866 });
  assert.deepEqual(h.screen.getCursorScreenPoint(), { x: 3637, y: 2866 });
  assert.match(h.log.mock.calls[0].arguments[0], /matching=identity/);
  h.advance(151);
  assert.deepEqual(h.screen.getCursorScreenPoint(), ELECTRON_POINT);
});

test("Wayland disables cursor sampling on a display mismatch and validates again after a display change", async (t) => {
  const h = waylandHarness(t);
  await h.start();
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), HYPR_POINT);

  for (const displays of [
    WAYLAND_DISPLAYS.slice(1),
    [{ ...WAYLAND_DISPLAYS[0], label: "eDP-1" }, ...WAYLAND_DISPLAYS.slice(1)],
    [{ ...WAYLAND_DISPLAYS[0], label: "Other (DP-1)" }, ...WAYLAND_DISPLAYS.slice(1)],
    [{ ...WAYLAND_DISPLAYS[0], bounds: { ...WAYLAND_DISPLAYS[0].bounds, x: 5756 } }, ...WAYLAND_DISPLAYS.slice(1)],
    [...WAYLAND_DISPLAYS.slice(0, 2), { ...WAYLAND_DISPLAYS[2], bounds: { x: 2837, y: 1466, width: 1600, height: 1000 } }],
  ]) {
    h.screen.getAllDisplays = () => displays;
    h.screen.emit("display-metrics-changed");
    await h.reply("j/monitors", JSON.stringify(MONITORS));
    const socketCount = h.sockets.length;
    h.timers.get(33).callback();
    assert.equal(h.sockets.length, socketCount);
    assert.equal(h.screen.getCursorScreenPoint, h.previous);
    assert.deepEqual(h.screen.getCursorScreenPoint(), ELECTRON_POINT);
  }
  assert.equal(h.warn.mock.callCount(), 1);
  assert.match(h.warn.mock.calls[0].arguments[0], /Wayland monitor\/display geometry mismatch/);

  h.screen.getAllDisplays = () => WAYLAND_DISPLAYS;
  h.screen.emit("display-added");
  await h.reply("j/monitors", JSON.stringify(MONITORS));
  await h.sample();
  assert.deepEqual(h.screen.getCursorScreenPoint(), HYPR_POINT);
});
