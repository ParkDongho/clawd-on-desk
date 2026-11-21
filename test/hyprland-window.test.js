"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const { raiseOrcaHyprlandWindow } = require("../src/hyprland-window");

function client(address, pid, initialTitle, focusHistoryID, extra = {}) {
  return { class: "orca", address, pid, initialTitle, focusHistoryID, ...extra };
}

function createFixture(clients, executables, dispatchReplies = ["ok\n"]) {
  const calls = [];
  const procReads = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const reply = args[0] === "clients" ? clients : dispatchReplies.shift();
    if (reply instanceof Error) callback(reply);
    else callback(null, Array.isArray(reply) ? JSON.stringify(reply) : reply);
  };
  const realpath = async (file) => {
    procReads.push(file);
    const executable = executables[file];
    if (!executable) throw new Error("process not found");
    return executable;
  };
  return { calls, procReads, raise: () => raiseOrcaHyprlandWindow({ execFile, realpath }) };
}

function luaFocus(address) {
  return ["dispatch", `hl.dsp.focus({ window = "address:${address}" })`];
}

it("prefers the exact Orca initial title and then the lowest focus history ID", async () => {
  const { calls, procReads, raise } = createFixture([
    client("0x1", 42, "Orca 에이전트 대시보드", 0, { title: "Orca" }),
    client("0x2", 42, "Orca", 5),
    client("0x3", 42, "Orca", 2, { title: "Active worktree" }),
  ], { "/proc/42/exe": "/opt/stably-orca/orca-ide" });

  assert.equal(await raise(), "ok");
  assert.deepEqual(calls.map((call) => call.args), [["clients", "-j"], luaFocus("0x3")]);
  assert.deepEqual(procReads, ["/proc/42/exe"]);
  for (const { command, options } of calls) {
    assert.equal(command, "hyprctl");
    assert.equal(options.shell, false);
    assert.ok(options.timeout > 0);
  }
});

it("falls back to the verified window with the lowest focus history ID", async () => {
  const { calls, raise } = createFixture([
    client("0x1", 42, "Orca 에이전트 대시보드", 5),
    client("0x2", 43, "Orca 에이전트 대시보드", 1),
    client("0x3", 44, "Orca", 0),
  ], {
    "/proc/42/exe": "/usr/local/bin/orca-ide",
    "/proc/43/exe": "/opt/stably-orca/electron",
    "/proc/44/exe": "/usr/bin/orca",
  });

  assert.equal(await raise(), "ok");
  assert.deepEqual(calls.map((call) => call.args), [["clients", "-j"], luaFocus("0x2")]);
});

it("skips screen readers, OrcaSlicer, and clients that cannot be verified", async () => {
  const { calls, procReads, raise } = createFixture([
    client("0x1", 1, "Orca", 0),
    client("0x2", 2, "Orca", 1),
    client("0x3", 3, "Orca", 2, { class: "OrcaSlicer", initialClass: "orca" }),
    client("0x4", 4, "Orca", 3),
    client("0x5", 5, "Orca", 4),
    client('0x6" }', 6, "Orca", 5),
  ], {
    "/proc/1/exe": "/usr/bin/orca",
    "/proc/2/exe": "/usr/bin/python3",
    "/proc/3/exe": "/opt/stably-orca/orca-ide",
    "/proc/4/exe": "/usr/bin/OrcaSlicer",
    "/proc/6/exe": "/opt/stably-orca/orca-ide",
  });

  assert.equal(await raise(), "skipped");
  assert.deepEqual(calls.map((call) => call.args), [["clients", "-j"]]);
  assert.deepEqual(procReads, ["/proc/1/exe", "/proc/2/exe", "/proc/4/exe", "/proc/5/exe"]);
});

it("accepts the orca-ide executable basename outside the default install path", async () => {
  const { calls, raise } = createFixture([client("0x42", 42, "Orca", 0)], {
    "/proc/42/exe": "/usr/local/bin/orca-ide",
  });
  assert.equal(await raise(), "ok");
  assert.deepEqual(calls.map((call) => call.args), [["clients", "-j"], luaFocus("0x42")]);
});

it("tries legacy dispatch once when Lua returns a non-ok response", async () => {
  const { calls, raise } = createFixture([client("0x42", 42, "Orca", 0)], {
    "/proc/42/exe": "/opt/stably-orca/orca-ide",
  }, ["Invalid dispatcher", "ok\n"]);
  assert.equal(await raise(), "ok");
  assert.deepEqual(calls.map((call) => call.args), [
    ["clients", "-j"], luaFocus("0x42"), ["dispatch", "focuswindow", "address:0x42"],
  ]);
});

it("reports failure when both dispatches fail", async () => {
  const { calls, raise } = createFixture([client("0x42", 42, "Orca", 0)], {
    "/proc/42/exe": "/opt/stably-orca/orca-ide",
  }, [new Error("Lua dispatch timed out"), "Window not found"]);
  assert.equal(await raise(), "failed:dispatch");
  assert.deepEqual(calls.map((call) => call.args), [
    ["clients", "-j"], luaFocus("0x42"), ["dispatch", "focuswindow", "address:0x42"],
  ]);
});

it("reports listing command and JSON failures without dispatching", async () => {
  for (const [listing, expected] of [
    [new Error("hyprctl not found"), "failed:clients-command"],
    ["malformed JSON", "failed:clients-json"],
    ["{}", "failed:clients-json"],
  ]) {
    const { calls, raise } = createFixture(listing, {});
    assert.equal(await raise(), expected);
    assert.deepEqual(calls.map((call) => call.args), [["clients", "-j"]]);
  }
});
