"use strict";

// Under XWayland a menu opened before its owner window has focus closes within
// milliseconds, and hiding the owner right when a focused menu closes can block
// the main process until the GPU process exits. Both paths are Linux only.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const MENU_MODULE_PATH = require.resolve("../src/menu");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadMenu(fakeElectron, placement) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (request === "./hyprland-placement") return placement;
    if (request === "./taskbar") return { keepOutOfTaskbar() {} };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness({ focused = true, native = false, hitVisible = true } = {}) {
  const state = { hides: 0, destroyed: false, ownerCalls: [], menuSignals: [], menuLogs: [], renderShows: 0 };
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed,
    isFocused: () => focused,
    setBounds() { state.ownerCalls.push("bounds"); },
    show() { state.ownerCalls.push("show"); },
    focus() { state.ownerCalls.push("focus"); },
    hide() { state.hides += 1; },
  });
  const hit = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => hitVisible,
  });
  const ctx = {
    win: { isDestroyed: () => false, showInactive() { state.renderShows++; }, setAlwaysOnTop() {} },
    hitWin: hit,
    menuOpen: false,
    contextMenuOwner: owner,
    petHidden: false,
    reapplyMacVisibility() {},
  };
  const initMenu = loadMenu({
    app: { quit() {} },
    BrowserWindow: function BrowserWindow() {},
    Menu: { buildFromTemplate: () => ({}) },
    Tray: function Tray() {},
    nativeImage: { createFromPath: () => ({ resize() { return this; }, setTemplateImage() {} }) },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  }, {
    isHyprlandPlacementActive: () => native,
    setHyprlandMenuOpen: (open) => state.menuSignals.push(open),
    logHyprlandMenu: (...args) => state.menuLogs.push(args),
  });
  const menu = initMenu(ctx);
  const popups = [];
  const fakeMenu = { popup(options) {
    if (state.popupError) throw state.popupError;
    popups.push(options);
  } };
  return {
    ctx,
    state,
    owner,
    hit,
    popups,
    open: () => menu.popupMenuAt(fakeMenu),
    close: () => popups.at(-1).callback(),
    fireFocus: () => owner.emit("focus"),
  };
}

describe("pet menu owner on Linux", { skip: process.platform !== "linux" }, () => {
  it("a focused owner opens the menu right away", () => {
    const h = createHarness();
    h.open();
    assert.equal(h.popups.length, 1);
    assert.equal(h.popups[0].window, h.owner);
    assert.deepEqual(h.state.ownerCalls, ["bounds", "show", "focus"]);
    assert.deepEqual(h.state.menuSignals, []);
    assert.equal(h.ctx.menuOpen, true);
  });

  it("an unfocused owner waits for focus, and a second click meanwhile does nothing", () => {
    const h = createHarness({ focused: false });
    h.open();
    assert.equal(h.popups.length, 0);
    assert.equal(h.ctx.menuOpen, true);
    h.open();
    h.fireFocus();
    assert.equal(h.popups.length, 1);
    assert.equal(h.owner.listenerCount("focus"), 0);
  });

  it("no focus in time still opens the menu", async () => {
    const h = createHarness({ focused: false });
    h.open();
    await wait(260);
    assert.equal(h.popups.length, 1);
    assert.equal(h.owner.listenerCount("focus"), 0);
  });

  it("an owner destroyed while waiting opens nothing and frees the menu state", async () => {
    const h = createHarness({ focused: false });
    h.open();
    h.state.destroyed = true;
    await wait(260);
    assert.equal(h.popups.length, 0);
    assert.equal(h.ctx.menuOpen, false);
  });

  it("quitting while waiting opens nothing and frees the menu state", async () => {
    const h = createHarness({ focused: false });
    h.open();
    h.ctx.isQuitting = true;
    await wait(260);
    assert.equal(h.popups.length, 0);
    assert.equal(h.ctx.menuOpen, false);
  });

  it("quitting before the focus event opens nothing and frees the menu state", () => {
    const h = createHarness({ focused: false });
    h.open();
    h.ctx.isQuitting = true;
    h.fireFocus();
    assert.equal(h.popups.length, 0);
    assert.equal(h.ctx.menuOpen, false);
  });

  it("leaves unrelated focus listeners attached", () => {
    const h = createHarness({ focused: false });
    let unrelated = 0;
    h.owner.on("focus", () => { unrelated += 1; });
    h.open();
    h.fireFocus();
    assert.equal(h.popups.length, 1);
    assert.equal(unrelated, 1);
    assert.equal(h.owner.listenerCount("focus"), 1);
  });

  it("hides the owner a moment after the menu closes, never at once", async () => {
    const h = createHarness();
    h.open();
    h.close();
    assert.equal(h.state.hides, 0);
    assert.equal(h.state.renderShows, 1);
    assert.equal(h.ctx.menuOpen, false);
    await wait(560);
    assert.equal(h.state.hides, 1);
  });

  it("a new menu keeps the owner up", async () => {
    const h = createHarness();
    h.open();
    h.close();
    h.open();
    await wait(560);
    assert.equal(h.state.hides, 0);
    h.close();
    await wait(560);
    assert.equal(h.state.hides, 1);
  });

  it("an owner destroyed before the delayed hide is left alone", async () => {
    const h = createHarness();
    h.open();
    h.close();
    h.state.destroyed = true;
    await wait(560);
    assert.equal(h.state.hides, 0);
  });
});

describe("pet menu on native Hyprland", () => {
  it("uses the visible hit window and suspends restoration until the popup callback", () => {
    const h = createHarness({ native: true });
    h.open();
    assert.equal(h.popups[0].window, h.hit);
    assert.equal(h.ctx.menuOpen, true);
    assert.deepEqual(h.state.ownerCalls, []);
    assert.deepEqual(h.state.menuSignals, [true]);
    h.close();
    assert.equal(h.ctx.menuOpen, false);
    assert.deepEqual(h.state.menuSignals, [true, false]);
    assert.deepEqual(h.state.menuLogs, [["open", h.hit], ["close", h.hit]]);
    assert.equal(h.state.renderShows, 0);
    assert.equal(h.hit.listenerCount("closed"), 0);
  });

  it("uses the owner when the hit window cannot host the menu", () => {
    const h = createHarness({ native: true, hitVisible: false });
    h.open();
    assert.equal(h.popups[0].window, h.owner);
    assert.deepEqual(h.state.ownerCalls, ["bounds", "show", "focus"]);
    assert.deepEqual(h.state.menuSignals, []);
  });

  it("resumes focus restoration if opening the native menu throws", () => {
    const h = createHarness({ native: true });
    h.state.popupError = new Error("popup failed");
    assert.throws(h.open, /popup failed/);
    assert.equal(h.ctx.menuOpen, false);
    assert.deepEqual(h.state.menuSignals, [true, false]);
    assert.equal(h.state.renderShows, 0);
    assert.equal(h.hit.listenerCount("closed"), 0);
  });
});
