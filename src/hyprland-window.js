"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const HYPRCTL_TIMEOUT_MS = 1000;

function focusHistory(client) {
  return Number.isFinite(client.focusHistoryID) ? client.focusHistoryID : Infinity;
}

async function findOrcaWindow(clients, realpath) {
  const candidates = clients.filter((client) => client && client.class === "orca"
    && Number.isSafeInteger(client.pid) && client.pid > 0
    // The address is interpolated into a Lua dispatcher expression.
    && typeof client.address === "string" && /^0x[\da-f]+$/i.test(client.address));
  candidates.sort((a, b) => Number(b.initialTitle === "Orca") - Number(a.initialTitle === "Orca")
    || focusHistory(a) - focusHistory(b));

  for (const client of candidates) {
    let executable;
    try {
      executable = await realpath(`/proc/${client.pid}/exe`);
    } catch {
      continue; // The process may have already exited.
    }
    if (path.posix.basename(executable) === "orca-ide" || executable.includes("/stably-orca/")) {
      return client.address;
    }
  }
  return null;
}

async function raiseOrcaHyprlandWindow({ execFile = childProcess.execFile, realpath = fs.promises.realpath } = {}) {
  const runHyprctl = (args) => new Promise((resolve) => {
    execFile("hyprctl", args, { encoding: "utf8", shell: false, timeout: HYPRCTL_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });

  const stdout = await runHyprctl(["clients", "-j"]);
  if (stdout === null) return "failed:clients-command";
  let clients;
  try { clients = JSON.parse(stdout); } catch {}
  if (!Array.isArray(clients)) return "failed:clients-json";

  const address = await findOrcaWindow(clients, realpath);
  if (!address) return "skipped";

  const selector = `address:${address}`;
  const lua = await runHyprctl(["dispatch", `hl.dsp.focus({ window = "${selector}" })`]);
  if (lua?.trim() === "ok") return "ok";
  const legacy = await runHyprctl(["dispatch", "focuswindow", selector]);
  return legacy?.trim() === "ok" ? "ok" : "failed:dispatch";
}

module.exports = { raiseOrcaHyprlandWindow };
