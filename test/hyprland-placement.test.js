"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const createPetWindowRuntime = require("../src/pet-window-runtime");
const {
  createOverlayWindow, installHyprlandPlacement, isHyprlandPlacementActive, setHyprlandMenuOpen, setHyprlandPointerHeld, logHyprlandMenu, luaQuote,
} = require("../src/hyprland-placement");

const SOCKET_DIR = "/run/user/test/hypr/test-instance";
const CLASS = "clawd-on-desk";

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.title = options.title;
    this.size = { width: options.width ?? 100, height: options.height ?? 75 };
  }
  isDestroyed() { return false; }
  setTitle(title) { this.title = title; }
  getBounds() { return { x: 0, y: 0, ...this.size }; }
  getContentBounds() { return this.getBounds(); }
  getPosition() { return [0, 0]; }
  focus(value) { return [this, value]; }
  show() { return this; }
  showInactive() { return this; }
  moveTop() { return this; }
  setPosition() {}
  setSize(width, height) { this.size = { width, height }; }
  setBounds(bounds) {
    assert.equal(bounds.x, undefined);
    assert.equal(bounds.y, undefined);
    this.setSize(bounds.width ?? this.size.width, bounds.height ?? this.size.height);
  }
  setContentBounds(bounds) { this.setBounds(bounds); }
  setContentSize(width, height) { this.setSize(width, height); }
}

function harness(t) {
  const app = new EventEmitter();
  app.getName = () => CLASS;
  app.commandLine = { getSwitchValue: (name) => name === "ozone-platform" ? "wayland" : "" };
  const screen = new EventEmitter();
  const warn = t.mock.method(console, "warn", () => {});
  const log = t.mock.method(console, "log", () => {});
  const openedSockets = [];
  const commands = [];
  const notifications = [];
  const timers = new Map();
  const timeouts = new Set();
  let now = 0;
  let eventSocket;
  const h = {
    app, screen, warn, log, commands, notifications, timers, timeouts, openedSockets,
    clients: [],
    monitors: [],
    ruleReply: "ok\n",
    options: {
      app, screen, platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/test", HYPRLAND_INSTANCE_SIGNATURE: "test-instance" },
      Notification: class {
        static isSupported() { return true; }
        constructor(options) { this.options = options; }
        show() { notifications.push(this.options); }
      },
      fs: { existsSync(file) { return file === SOCKET_DIR + "/.socket.sock"; } },
      clock: {
        setInterval(callback, ms) {
          const timer = { callback, ms, unref() { this.unreferenced = true; } };
          timers.set(ms, timer);
          return timer;
        },
        clearInterval(timer) { timers.delete(timer.ms); },
        setTimeout(callback, ms) {
          const timer = { callback, dueAt: now + ms, unref() {} };
          timeouts.add(timer);
          return timer;
        },
        clearTimeout(timer) { timeouts.delete(timer); },
      },
      net: { createConnection({ path, timeout }) {
        assert.equal(timeout, 500);
        const events = path === SOCKET_DIR + "/.socket2.sock";
        if (!events) assert.equal(path, SOCKET_DIR + "/.socket.sock");
        const socket = Object.assign(new EventEmitter(), {
          setEncoding(encoding) { assert.equal(encoding, "utf8"); },
          setTimeout(ms) { assert.equal(ms, 0); },
          unref() {},
          destroy() {
            if (this.closed) return;
            this.closed = true;
            this.emit("close");
          },
          reply(value) {
            this.emit("data", value.slice(0, 4));
            this.emit("data", value.slice(4));
            this.emit("end");
            this.destroy();
          },
          write(command) {
            assert.ok(!events);
            commands.push(command);
            if (command === "j/clients") {
              if (h.holdClients) h.clientSocket = this;
              else this.reply(JSON.stringify(h.clients));
            } else if (command === "j/monitors") {
              this.reply(JSON.stringify(h.monitors));
            } else if (command.startsWith("eval hl.window_rule(")) {
              this.reply(h.ruleReply);
            } else if (command.startsWith("eval local prev = ")) {
              this.reply("ok");
            } else {
              assert.match(command, /^eval hl.dispatch\(hl.dsp.window.move\(/);
              if (h.failMoveSocket) {
                this.emit("error", { code: "ECONNRESET" });
                this.destroy();
              } else {
                this.reply("ok");
              }
            }
          },
        });
        if (events) eventSocket = socket;
        openedSockets.push(socket);
        queueMicrotask(() => {
          if (events && h.failEventConnection) {
            socket.emit("error", { code: "ECONNREFUSED" });
            socket.destroy();
          } else {
            if (!events && h.beforeCommandConnect) {
              const beforeCommandConnect = h.beforeCommandConnect;
              h.beforeCommandConnect = null;
              beforeCommandConnect();
            }
            socket.emit("connect");
          }
        });
        return socket;
      } },
    },
    start: () => installHyprlandPlacement(h.options),
    moves: () => commands.filter((command) => command.includes("hl.dsp.window.move(")),
    restores: () => commands.filter((command) => command.includes("hl.dsp.focus(")),
    advance(ms) {
      now += ms;
      for (const timer of timeouts) {
        if (timer.dueAt > now) continue;
        timeouts.delete(timer);
        timer.callback();
      }
    },
    event: (...chunks) => { for (const chunk of chunks) eventSocket.emit("data", chunk); },
    disconnect: () => eventSocket.destroy(),
    create: (role, options) => createOverlayWindow(FakeWindow, role, { frame: false, ...options }),
  };
  t.after(() => app.emit("before-quit"));
  return h;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function client(win, address, at, extra) {
  return { class: CLASS, title: win.title, pid: process.pid, xwayland: false, address, at, ...extra };
}

test("placement gates on Linux, the resolved Wayland backend, environment and the socket", async (t) => {
  const h = harness(t);
  for (const overrides of [
    { platform: "darwin" },
    { app: { commandLine: { getSwitchValue: () => "x11" } } },
    { app: { commandLine: { getSwitchValue: () => "" } } },
    { env: { XDG_RUNTIME_DIR: "/run/user/test" } },
    { env: { HYPRLAND_INSTANCE_SIGNATURE: "test-instance" } },
    { fs: { existsSync: () => false } },
  ]) {
    assert.equal(await installHyprlandPlacement({ ...h.options, ...overrides }), false);
    const win = h.create("hit", { title: "Clawd" });
    assert.equal(win.title, "Clawd");
    assert.equal(win.setBounds, FakeWindow.prototype.setBounds);
  }
  assert.equal(h.openedSockets.length, 0);
  assert.equal(h.warn.mock.callCount(), 1);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body, /CLAWD_OZONE_PLATFORM=x11/);
});

test("tags known frameless overlays at construction and prevents page titles from replacing the tags", async (t) => {
  const h = harness(t);
  assert.equal(await h.start(), true);
  const render = h.create("render", { title: "Clawd", x: 10, y: 20 });
  const hit = h.create("hit", {});
  assert.match(render.title, /^clawd·render·\d+·\d+$/);
  assert.match(hit.title, /^clawd·hit·\d+·\d+$/);
  assert.notEqual(h.create("hit", {}).title, hit.title);
  const preventDefault = t.mock.fn();
  render.emit("page-title-updated", { preventDefault }, "Page title");
  assert.equal(preventDefault.mock.callCount(), 1);
  assert.deepEqual(render.getPosition(), [10, 20]);

  for (const win of [h.create("render", { frame: true }), h.create("other", {})]) {
    assert.equal(win.title, undefined);
    assert.equal(win.setBounds, FakeWindow.prototype.setBounds);
    assert.equal(win.listenerCount("page-title-updated"), 0);
  }
});

test("queues until socket2 supplies addresses and batches the latest same-tick moves", async (t) => {
  const h = harness(t);
  await h.start();
  const render = h.create("render", { x: 10, y: 20 });
  const hit = h.create("hit", { x: 12, y: 23 });
  render.setPosition(32, 50);
  await tick();
  assert.deepEqual(h.moves(), []);

  h.clients = [client(render, "0xabc", [10, 20]), client(hit, "0xdef", [12, 23])];
  h.event("openwindow>>abc,1,clawd-", "on-desk," + render.title + "\n" +
    "openwindow>>0xdef,1,clawd-on-desk," + hit.title + "\n");
  render.setPosition(-90.1, 54.7);
  hit.setBounds({ x: -64, y: 59, width: 50, height: 60 });
  assert.deepEqual(hit.getBounds(), { x: -64, y: 59, width: 50, height: 60 });
  await tick();
  await tick();
  assert.deepEqual(h.moves(), [
    'eval hl.dispatch(hl.dsp.window.move({ window = "address:0xabc", x = -90, y = 55 })); ' +
    'hl.dispatch(hl.dsp.window.move({ window = "address:0xdef", x = -64, y = 59 }))',
  ]);
});

test("discovers clients by title, app class and PID, then reconciles compositor moves", async (t) => {
  const h = harness(t);
  await h.start();
  const win = h.create("quota-ring", {});
  win.setBounds({ x: 200, y: 100, width: 50 });
  const matched = client(win, "0xcafe", [33, 54]);
  h.clients = [
    { ...matched, pid: process.pid + 1 },
    { ...matched, xwayland: true },
    { ...matched, class: "orca" },
  ];
  await tick();
  assert.deepEqual(h.moves(), []);

  h.clients = [matched];
  const timer = h.timers.get(1000);
  assert.ok(timer.unreferenced);
  timer.callback();
  await tick();
  await tick();
  assert.match(h.moves()[0], /address:0xcafe", x = 200, y = 100/);
  assert.deepEqual(win.getPosition(), [200, 100]);
  h.advance(250);
  await tick();
  const move = t.mock.fn();
  win.on("move", move);
  h.clients = [{ ...matched, at: [210, -20], size: [1, 1] }];
  h.screen.emit("display-metrics-changed");
  await tick();
  await tick();
  assert.deepEqual(win.getBounds(), { x: 210, y: -20, width: 50, height: 75 });
  assert.equal(move.mock.callCount(), 1);
  win.setContentBounds({ x: 30, y: -50, width: 74, height: 85 });
  win.setSize(80, 90);
  win.setBounds({ y: 50 });
  assert.deepEqual(win.getContentBounds(), { x: 30, y: 50, width: 80, height: 90 });
  await tick();
  assert.match(h.moves()[1], /address:0xcafe", x = 30, y = 50/);
});

test("a stale client snapshot cannot undo a pending move or reattach an unmapped address", async (t) => {
  const h = harness(t);
  await h.start();
  const win = h.create("hit", { x: 10, y: 20 });
  h.holdClients = true;
  await tick();
  const staleClient = client(win, "0xabc", [5, 6]);
  h.event("openwindow>>abc,1,clawd-on-desk," + win.title + "\nclosewindow>>abc\n");
  win.setPosition(80, 90);
  h.clientSocket.reply(JSON.stringify([staleClient]));
  await tick();
  assert.deepEqual(win.getPosition(), [80, 90]);
  assert.deepEqual(h.moves(), []);
  h.holdClients = false;
  h.clients = [client(win, "0xdef", [5, 6])];
  h.clientSocket.reply("[]");
  h.event("openwindow>>def,1,clawd-on-desk," + win.title + "\n");
  await tick();
  await tick();
  assert.match(h.moves()[0], /address:0xdef", x = 80, y = 90/);

  win.emit("closed");
  h.event("openwindow>>123,1,clawd-on-desk," + win.title + "\n");
  await tick();
  assert.equal(h.moves().length, 1);
});

test("installs named role rules and replaces the same names on config reload", async (t) => {
  const h = harness(t);
  await h.start();
  const command = h.commands[0];
  const names = [...command.matchAll(/name = "([^"]+)"/g)].map((match) => match[1]);
  assert.equal(names.length, 10);
  assert.equal(new Set(names).size, 10);
  for (const role of [
    "render", "hit", "permission", "permission-queue", "hud", "quota-ring", "update-bubble",
    "menu-owner", "resume-input", "roam-fence",
  ]) {
    const rule = command.split("; ").find((statement) => statement.includes('name = "clawd-on-desk-native-' + role + '"'));
    assert.ok(rule.includes('title = "^clawd·' + role + '·[0-9]+·[0-9]+$"'));
    assert.match(rule, /no_anim = true, no_shadow = true, no_blur = true, no_dim = true, decorate = false, border_size = 0, rounding = 0/);
    if (role === "menu-owner") assert.doesNotMatch(rule, /pin =/);
    else assert.match(rule, /float = true, pin = true/);
    if (role === "render") {
      assert.match(rule, /no_focus = true/);
      assert.doesNotMatch(rule, /no_initial_focus|no_follow_mouse/);
    } else {
      assert.match(rule, /no_initial_focus = true, no_follow_mouse = true/);
      assert.doesNotMatch(rule, /no_focus =/);
    }
  }

  h.event("configreloaded>>\n");
  await tick();
  assert.deepEqual(h.commands, [command, "j/monitors", command]);
});

test("quotes Lua strings and rejects invalid addresses and coordinates", async (t) => {
  assert.equal(luaQuote('x"\\\n\0' + "9"), '"x\\"\\\\\\010\\0009"');
  const h = harness(t);
  await h.start();
  const win = h.create("hit", {});
  win.setPosition(30, 40);
  win.setPosition(Infinity, 10);
  win.setPosition("1; bad()", 10);
  win.setPosition(NaN, 10);
  win.setPosition(1e50, 10);
  h.event("openwindow>>abc,1,another-app," + win.title + "\n" +
    "openwindow>>bad());,1,clawd-on-desk," + win.title + "\n");
  h.clients = [client(win, '0xabc"); error("bad")', [5, 8])];
  await tick();
  assert.deepEqual(h.moves(), []);
  h.clients = [client(win, "0xabc", [5, 8])];
  h.event("openwindow>>abc,1,clawd-on-desk," + win.title + "\n");
  await tick();
  await tick();
  assert.match(h.moves()[0], /address:0xabc", x = 30, y = 40/);
});

test("socket and initial rule failures leave windows native and report once", async (t) => {
  const h = harness(t);
  h.failEventConnection = true;
  assert.equal(await h.start(), false);
  assert.equal(h.commands.length, 0);
  assert.equal(h.warn.mock.callCount(), 1);
  assert.equal(isHyprlandPlacementActive(), false);

  h.failEventConnection = false;
  h.ruleReply = "error: unknown rule";
  assert.equal(await h.start(), false);
  const win = h.create("render", { title: "Clawd" });
  assert.equal(win.title, "Clawd");
  assert.equal(win.getBounds, FakeWindow.prototype.getBounds);
  assert.equal(h.warn.mock.callCount(), 2);
  assert.equal(h.timers.size, 0);
  assert.ok(h.openedSockets.every((socket) => socket.closed));
});

test("a failed rule reload rolls back hooks and cancels future moves", async (t) => {
  const h = harness(t);
  await h.start();
  const win = h.create("hit", { title: "Input" });
  await tick();
  h.ruleReply = "error: rejected";
  h.event("configreloaded>>\nconfigreloaded>>\n");
  await tick();
  h.disconnect();
  win.setPosition(501, 600);

  assert.equal(win.title, "Input");
  assert.equal(win.getBounds, FakeWindow.prototype.getBounds);
  assert.equal(win.listenerCount("page-title-updated"), 0);
  assert.equal(isHyprlandPlacementActive(), false);
  assert.deepEqual(h.moves(), []);
  assert.equal(h.warn.mock.callCount(), 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.screen.eventNames(), []);
});

test("a command socket failure disables placement after startup", async (t) => {
  const h = harness(t);
  await h.start();
  const win = h.create("render", { x: 10, y: 20 });
  h.failMoveSocket = true;
  h.clients = [client(win, "0xabc", [10, 20])];
  h.event("openwindow>>abc,1,clawd-on-desk," + win.title + "\n");
  await tick();
  await tick();
  assert.equal(win.setPosition, FakeWindow.prototype.setPosition);
  assert.equal(isHyprlandPlacementActive(), false);
  assert.equal(h.warn.mock.callCount(), 1);
});

function mapOverlay(h, role, address, options) {
  const win = h.create(role, options);
  h.clients.push(client(win, "0x" + address, [10, 20]));
  h.event("openwindow>>" + address + ",1,clawd-on-desk," + win.title + "\n");
  return win;
}

function restoreCommand(address) {
  return 'eval local prev = hl.get_config("cursor:no_warps"); hl.config({ cursor = { no_warps = true } }); ' +
    'hl.dispatch(hl.dsp.focus({ window = "address:0x' + address + '" })); hl.config({ cursor = { no_warps = prev } })';
}

test("restores the last non-overlay focus after 150 ms using valid activewindowv2 addresses", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindowv2>>0xcafe\nactivewindow", "v2>>d00d\nactivewindowv2>>abc\n");
  h.event('activewindowv2>>d00d"); error("bad")\n');
  assert.equal(h.timeouts.size, 1);
  h.advance(149);
  await tick();
  assert.deepEqual(h.restores(), []);
  h.advance(1);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("d00d")]);
});

test("focusable overlays keep keyboard focus and are never remembered as the restore target", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "permission", "abc", { focusable: true });
  mapOverlay(h, "permission-queue", "bcd", { focusable: true });
  mapOverlay(h, "resume-input", "cde", {});
  mapOverlay(h, "hit", "def", { focusable: false });
  h.event("activewindowv2>>cafe\n");
  for (const address of ["abc", "bcd", "cde"]) {
    h.event("activewindowv2>>" + address + "\n");
    h.advance(150);
    await tick();
    assert.equal(h.timeouts.size, 0);
    assert.deepEqual(h.restores(), []);
  }
  h.event("activewindowv2>>def\n");
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

for (const event of ["hide", "blur"]) {
  test("the menu owner defers focus restoration until " + event, async (t) => {
    const h = harness(t);
    await h.start();
    const menu = mapOverlay(h, "menu-owner", "abc", { focusable: true });
    h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
    h.advance(150);
    await tick();
    assert.deepEqual(h.restores(), []);
    if (event === "hide") h.event("activewindowv2>>\n");
    menu.emit(event);
    await tick();
    assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
  });
}

test("a newer activation replaces the debounce and a foreground change cancels it", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  const menu = mapOverlay(h, "menu-owner", "bcd", { focusable: true });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  const firstTimer = [...h.timeouts][0];
  h.advance(100);
  h.event("activewindowv2>>bcd\n");
  assert.equal(h.timeouts.size, 1);
  assert.ok(!h.timeouts.has(firstTimer));
  h.advance(50);
  menu.emit("blur");
  await tick();
  assert.deepEqual(h.restores(), []);

  h.event("activewindowv2>>d00d\n");
  assert.equal(h.timeouts.size, 0);
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
});

test("rechecks active focus before writing the restore command", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  await tick();
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  h.advance(150);
  h.beforeCommandConnect = () => h.event("activewindowv2>>d00d\n");
  await tick();
  assert.equal(h.beforeCommandConnect, null);
  assert.deepEqual(h.restores(), []);
  assert.equal(isHyprlandPlacementActive(), true);
});

test("without a remembered non-overlay, activation does not request focus", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindowv2>>abc\n");
  assert.equal(h.timeouts.size, 0);
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
});

test("late address discovery recognizes an already active overlay", async (t) => {
  const h = harness(t);
  await h.start();
  const win = h.create("hit", { focusable: false });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  h.clients.push(client(win, "0xabc", [10, 20]));
  await tick();
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

test("disappearing restore targets and placement shutdown cancel focus work", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  const menu = mapOverlay(h, "menu-owner", "bcd", { focusable: true });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\nclosewindow>>cafe\n");
  assert.equal(h.timeouts.size, 0);
  h.event("activewindowv2>>d00d\nactivewindowv2>>bcd\n");
  assert.equal(h.timeouts.size, 1);
  assert.equal(menu.listenerCount("blur"), 1);
  h.disconnect();
  assert.equal(h.timeouts.size, 0);
  assert.equal(menu.listenerCount("blur"), 0);
  assert.equal(menu.listenerCount("hide"), 0);
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
});

function monitor(id, x, workspaceId, extra) {
  return {
    id, x, y: 1466, width: 1920, height: 1080, scale: 1, transform: 0,
    activeWorkspace: { id: workspaceId }, ...extra,
  };
}

function guardedMove(workspace, x, y) {
  return 'eval local prev = hl.get_config("cursor:no_warps"); hl.config({ cursor = { no_warps = true } }); ' +
    'hl.dispatch(hl.dsp.window.move({ window = "address:0xabc", workspace = "' + workspace + '" })); ' +
    'hl.dispatch(hl.dsp.window.move({ window = "address:0xabc", x = ' + x + ', y = ' + y + ' })); ' +
    'hl.config({ cursor = { no_warps = prev } })';
}

test("the first move preserves primary startup geometry and re-homes after settling", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4), monitor(0, 2837, 7, {
    width: 2560, height: 1600, scale: 1.6, transform: 3,
  })];
  await h.start();
  const startup = { x: 5507, y: 2296, width: 230, height: 230 };
  const runtime = createPetWindowRuntime({
    isLinux: true,
    getPrimaryWorkAreaSafe: () => ({ x: 3837, y: 1466, width: 1920, height: 1080 }),
  });
  const { initialWindowBounds } = runtime.resolveStartupPlacement({ positionSaved: false }, {
    width: 230, height: 230,
  });
  const win = h.create("render", initialWindowBounds);
  h.event("openwindow>>abc,7,clawd-on-desk," + win.title + "\n");
  h.holdClients = true;
  await tick();
  assert.deepEqual(win.getBounds(), startup);
  assert.deepEqual(h.moves(), []);
  h.holdClients = false;
  h.clientSocket.reply(JSON.stringify([
    client(win, "0xabc", [2837, 1466], { monitor: 0, workspace: { id: 7 } }),
  ]));
  await tick();
  await tick();
  assert.deepEqual(h.moves(), [
    'eval hl.dispatch(hl.dsp.window.move({ window = "address:0xabc", x = 5507, y = 2296 }))',
  ]);
  h.advance(250);
  await tick();
  assert.equal(h.moves().at(-1), guardedMove(4, 5507, 2296));
  win.setPosition(5400, 2200);
  await tick();
  assert.doesNotMatch(h.moves().at(-1), /workspace|no_warps/);

  // The rotated, scaled monitor occupies x=[2837,3837), y=[1466,3066).
  win.setPosition(3000, 2900);
  await tick();
  assert.doesNotMatch(h.moves().at(-1), /workspace|no_warps/);
  h.advance(250);
  await tick();
  assert.equal(h.moves().at(-1), guardedMove(7, 3000, 2900));
});

test("refreshes monitor geometry and workspaces before moves for display and socket events", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4), monitor(2, 5757, 8)];
  await h.start();
  const win = h.create("hit", {});
  // A workspace ID can identify the monitor before a valid monitor ID is reported.
  h.clients = [client(win, "0xabc", [4000, 1600], { monitor: -1, workspace: { id: 4 } })];
  await tick();

  const events = [
    "workspacev2>>", "focusedmonv2>>", "monitoraddedv2>>", "monitorremovedv2>>", "display-metrics-changed",
  ];
  for (const [index, event] of events.entries()) {
    const destinationId = index % 2 === 0 ? 2 : 1;
    const x = destinationId === 2 ? 6000 + index * 5 : 3900 + index * 5;
    const workspace = 10 + index;
    h.monitors = h.monitors.map((m) => m.id === destinationId ? monitor(m.id, x, workspace) : m);
    const before = h.commands.length;
    if (event.includes(">>")) h.event(event + "payload\n");
    else h.screen.emit(event);
    win.setPosition(x, 1500);
    await tick();
    await tick();
    assert.equal(h.commands[before], "j/monitors", event);
    assert.ok(h.moves().at(-1).includes('workspace = "' + workspace + '"'), event);
    if (!event.includes(">>")) await tick();
  }
});

test("uses absolute-only movement when the destination workspace ID is invalid", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4), monitor(2, 5757, '8"); error("bad")')];
  await h.start();
  const win = h.create("hit", {});
  h.clients = [client(win, "0xabc", [4000, 1600], { monitor: 1, workspace: { id: 4 } })];
  await tick();
  win.setPosition(6000, 1600);
  await tick();
  assert.match(h.moves().at(-1), /window = "address:0xabc", x = 6000, y = 1600/);
  assert.doesNotMatch(h.moves().at(-1), /workspace|bad/);
  h.monitors[1] = monitor(2, 5757, 8);
  h.event("workspacev2>>8,eight\n");
  win.setPosition(6020, 1600);
  await tick();
  await tick();
  assert.match(h.moves().at(-1), /workspace = "8"/);
});

test("uses a fresh workspace if monitors change while the move socket connects", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4), monitor(2, 5757, 8)];
  await h.start();
  const win = h.create("hit", {});
  h.clients = [client(win, "0xabc", [4000, 1600], { monitor: 1 })];
  await tick();
  h.beforeCommandConnect = () => {
    h.monitors[1] = monitor(2, 5757, 9);
    h.event("workspacev2>>9,nine\n");
  };
  win.setPosition(6000, 1600);
  h.advance(250);
  await tick();
  await tick();
  await tick();
  assert.equal(h.moves().length, 1);
  assert.match(h.moves()[0], /workspace = "9"/);
});

test("continuous movement sends only coordinates and re-homes once after 250 ms unchanged", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4), monitor(2, 5757, 8)];
  await h.start();
  const win = h.create("hit", {});
  h.clients = [client(win, "0xabc", [4000, 1600], { monitor: 1 })];
  await tick();
  for (const x of [5800, 5900, 6000]) {
    win.setPosition(x, 1600);
    await tick();
    h.advance(249);
    await tick();
  }
  assert.equal(h.moves().length, 3);
  assert.ok(h.moves().every((command) => !/workspace|no_warps/.test(command)));
  h.advance(1);
  await tick();
  assert.equal(h.moves().length, 4);
  assert.equal(h.moves().at(-1), guardedMove(8, 6000, 1600));
  h.advance(250);
  await tick();
  assert.equal(h.moves().length, 4);
});

test("workspace events re-home an already moved window immediately while other moves stay in the same guard", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4), monitor(2, 5757, 8)];
  await h.start();
  const hit = h.create("hit", {});
  const hud = h.create("hud", {});
  h.clients = [
    client(hit, "0xabc", [4000, 1600], { monitor: 1 }),
    client(hud, "0xdef", [4000, 1700], { monitor: 1 }),
  ];
  await tick();
  hit.setPosition(6000, 1600);
  await tick();
  assert.doesNotMatch(h.moves().at(-1), /workspace|no_warps/);
  h.monitors[1] = monitor(2, 5757, 9);
  h.event("workspacev2>>9,nine\n");
  hud.setPosition(4200, 1700);
  await tick();
  await tick();
  assert.equal(h.moves().at(-1), guardedMove(9, 6000, 1600).replace(
    "; hl.config({ cursor = { no_warps = prev } })",
    '; hl.dispatch(hl.dsp.window.move({ window = "address:0xdef", x = 4200, y = 1700 })); ' +
    "hl.config({ cursor = { no_warps = prev } })",
  ));
});

test("unknown Wayland geometry exposes size and withholds the placeholder origin", async (t) => {
  const h = harness(t);
  await h.start();
  const win = h.create("hud", {});
  assert.deepEqual(win.getBounds(), { x: undefined, y: undefined, width: 100, height: 75 });
  assert.deepEqual(win.getContentBounds(), win.getBounds());
  assert.deepEqual(win.getPosition(), [undefined, undefined]);
  win.setBounds({ x: 99, width: 120 });
  assert.deepEqual(win.getBounds(), { x: undefined, y: undefined, width: 120, height: 75 });
  h.clients = [client(win, "0xabc", [0, 0])];
  await tick();
  assert.deepEqual(win.getPosition(), [0, 0]);
});

test("holds no-warp restoration during a hit-window menu and releases it on close", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  setHyprlandMenuOpen(true);
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
  setHyprlandMenuOpen(false);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

test("holds focus restoration while the pointer is held and releases it on drag-lock release", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  setHyprlandPointerHeld(true);
  h.advance(150);
  await tick();
  // A focus change mid-press broke the drag live; nothing may be sent yet.
  assert.deepEqual(h.restores(), []);
  setHyprlandPointerHeld(false);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

test("a pointer release before the restore delay still waits for the delay", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  setHyprlandPointerHeld(true);
  setHyprlandPointerHeld(false);
  await tick();
  assert.deepEqual(h.restores(), []);
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

test("a clawd-on-desk window is never remembered as the restore target, even before its address is known", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindow>>orca,Orca\nactivewindowv2>>cafe\n");
  // A new Clawd overlay (e.g. a re-created HUD) is activated before openwindow names it.
  h.event("activewindow>>clawd-on-desk,clawd·hud·1·9\nactivewindowv2>>beef\n");
  h.event("activewindow>>clawd-on-desk,clawd·hit·1·3\nactivewindowv2>>abc\n");
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

test("a workspace switch cancels a pending focus restore instead of switching back", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  // Switching workspace focuses the pinned pet by itself, then reports the switch.
  h.event("activewindow>>orca,Orca\nactivewindowv2>>cafe\n");
  h.event("activewindow>>clawd-on-desk,clawd·hit·1·1\nactivewindowv2>>abc\nworkspacev2>>4,4\n");
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
});

test("never restores focus to a window on a workspace that is not visible", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4)];
  await h.start();
  const win = mapOverlay(h, "hit", "abc", { focusable: false });
  h.clients = [client(win, "0xabc", [10, 20], { workspace: { id: 4 } }),
    { class: "orca", title: "Orca", pid: 1, xwayland: false, address: "0xcafe", at: [0, 0], workspace: { id: 2 } }];
  h.event("activewindow>>orca,Orca\nactivewindowv2>>cafe\n");
  h.advance(1000);
  await tick();
  await tick();
  h.event("activewindow>>clawd-on-desk,clawd·hit·1·1\nactivewindowv2>>abc\n");
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
});

test("still restores focus to a window on a visible workspace (control)", async (t) => {
  const h = harness(t);
  h.monitors = [monitor(1, 3837, 4)];
  await h.start();
  const win = mapOverlay(h, "hit", "abc", { focusable: false });
  h.clients = [client(win, "0xabc", [10, 20], { workspace: { id: 4 } }),
    { class: "orca", title: "Orca", pid: 1, xwayland: false, address: "0xcafe", at: [0, 0], workspace: { id: 4 } }];
  h.event("activewindow>>orca,Orca\nactivewindowv2>>cafe\n");
  h.advance(1000);
  await tick();
  await tick();
  h.event("activewindow>>clawd-on-desk,clawd·hit·1·1\nactivewindowv2>>abc\n");
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
});

test("closing a hit-window menu cannot restore over a newer activation", async (t) => {
  const h = harness(t);
  await h.start();
  mapOverlay(h, "hit", "abc", { focusable: false });
  h.event("activewindowv2>>cafe\nactivewindowv2>>abc\n");
  setHyprlandMenuOpen(true);
  h.event("activewindowv2>>d00d\n");
  setHyprlandMenuOpen(false);
  h.advance(150);
  await tick();
  assert.deepEqual(h.restores(), []);
});

for (const enabled of [false, true]) {
  test("placement debug logging is " + (enabled ? "opt-in" : "off by default"), async (t) => {
    const h = harness(t);
    if (enabled) h.options.env.CLAWD_HYPRLAND_DEBUG = "1";
    await h.start();
    const hit = mapOverlay(h, "hit", "abc", { focusable: false });
    const render = mapOverlay(h, "render", "def", {});
    if (enabled) assert.notEqual(hit.focus, FakeWindow.prototype.focus);
    else assert.equal(hit.focus, FakeWindow.prototype.focus);
    assert.deepEqual(hit.focus("value"), [hit, "value"]);
    assert.equal(render.show(), render);
    assert.equal(render.showInactive(), render);
    assert.equal(render.moveTop(), render);
    logHyprlandMenu("open", hit);
    logHyprlandMenu("close", hit);
    h.event("activewindowv2>>abc\nactivewindowv2>>cafe\nactivewindowv2>>abc\n");
    h.advance(150);
    await tick();
    assert.deepEqual(h.restores(), [restoreCommand("cafe")]);
    h.event("workspacev2>>4,four\nfocusedmonv2>>DP-1,4\nconfigreloaded>>\nclosewindow>>def\n");
    await tick();
    await tick();
    await tick();

    const lines = h.log.mock.calls.map(({ arguments: args }) => args[0]);
    if (enabled) {
      assert.equal(lines.filter((line) => line.includes(" command ")).length, h.commands.length);
      assert.ok(lines.some((line) => line.includes("command eval hl.window_rule(") && line.endsWith("…")));
      for (const event of ["openwindow", "closewindow", "activewindowv2", "workspacev2", "focusedmonv2", "configreloaded"]) {
        assert.ok(lines.some((line) => line.includes("event " + event + ">>")), event);
      }
      for (const message of ["focus skipped", "no previous window", "focus scheduled", "focus sent",
        "menu open host=clawd·hit", "menu close host=clawd·hit",
        "window " + hit.title + " focus() at ",
        ...["show", "showInactive", "moveTop"].map((method) => "window " + render.title + " " + method + "() at "),
      ]) {
        assert.ok(lines.some((line) => line.includes(message)), message);
      }
    } else {
      assert.deepEqual(lines, []);
    }
    h.disconnect();
    assert.equal(hit.focus, FakeWindow.prototype.focus);
    assert.equal(render.moveTop, FakeWindow.prototype.moveTop);
  });
}
