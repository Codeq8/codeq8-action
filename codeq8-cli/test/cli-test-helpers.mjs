import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));

const packageDir = path.resolve(testDir, "..");

const binPath = path.join(packageDir, "bin", "codeq8.js");

export async function runCli(args, { env = {}, input = "" } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: packageDir,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout,
        stderr,
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

export function withTempConfig() {
  const configHome = mkdtempSync(path.join(os.tmpdir(), "codeq8-cli-test-"));
  return {
    CODEQ8_CONFIG_HOME: configHome,
    CODEQ8_AUTH_STORAGE: "file",
    configHome,
  };
}

export function listAuthFiles(configHome) {
  if (!existsSync(configHome)) {
    return [];
  }
  return readdirSync(configHome)
    .filter((entry) => entry.startsWith("auth-") && entry.endsWith(".json"))
    .map((entry) => path.join(configHome, entry));
}

export async function withMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve mock server address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: async () => {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export function jsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
