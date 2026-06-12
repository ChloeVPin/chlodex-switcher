import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as backend from "./backend";

export function runLanServer(host: string, port: number): void {
  const distDir = path.join(process.cwd(), "dist");

  const mimeTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp"
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method;
    const url = req.url || "";

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (method === "GET" && url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Handle Invoke APIs
    if (method === "POST" && url.startsWith("/api/invoke/")) {
      const command = url.slice("/api/invoke/".length);
      
      let bodyStr = "";
      req.on("data", chunk => {
        bodyStr += chunk;
      });

      req.on("end", async () => {
        try {
          const payload = bodyStr ? JSON.parse(bodyStr) : {};
          const result = await invokeWebCommand(command, payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }

    // Static files server
    if (method === "GET") {
      let requestedFile = url === "/" ? "index.html" : url.split("?")[0].slice(1);
      
      // Prevent path traversal
      requestedFile = path.normalize(requestedFile).replace(/^(\.\.[\/\\])+/, "");
      
      let filePath = path.join(distDir, requestedFile);

      // SPA routing fallback: if file does not exist, serve index.html
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        if (path.extname(requestedFile) === "") {
          filePath = path.join(distDir, "index.html");
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
      }

      try {
        const ext = path.extname(filePath).toLowerCase();
        const mime = mimeTypes[ext] || "application/octet-stream";
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
  });

  server.listen(port, host, () => {
    console.log(`Codex Switcher web server listening on http://${host}:${port}`);
    console.log(`Serving static files from ${distDir}`);
  });
}

async function invokeWebCommand(command: string, payload: any): Promise<any> {
  switch (command) {
    case "list_accounts":
      return backend.listAccounts();
    case "get_active_account_info":
      return backend.getActiveAccountInfo();
    case "add_account_from_file":
      return backend.addAccountFromFile(payload.path, payload.name);
    case "add_account_from_auth_json_text":
      return backend.addAccountFromAuthJsonText(payload.name, payload.contents);
    case "get_usage":
      return backend.getUsage(payload.accountId);
    case "refresh_account_metadata":
      return backend.refreshAccountMetadata(payload.accountId);
    case "refresh_all_accounts_usage":
      return backend.refreshAllAccountsUsage();
    case "warmup_account":
      await backend.warmupAccount(payload.accountId);
      return null;
    case "warmup_all_accounts":
      return backend.warmupAllAccounts();
    case "switch_account":
      await backend.switchAccount(payload.accountId);
      return null;
    case "delete_account":
      await backend.deleteAccount(payload.accountId);
      return null;
    case "rename_account":
      await backend.renameAccount(payload.accountId, payload.newName);
      return null;
    case "start_login":
      return backend.startLogin(payload.accountName);
    case "complete_login":
      return backend.completeLogin();
    case "cancel_login":
      await backend.cancelLogin();
      return null;
    case "export_accounts_slim_text":
      return backend.exportAccountsSlimText();
    case "import_accounts_slim_text":
      return backend.importAccountsSlimText(payload.payload);
    case "export_accounts_full_encrypted_bytes":
      return backend.exportAccountsFullEncryptedBytes();
    case "import_accounts_full_encrypted_bytes":
      return backend.importAccountsFullEncryptedBytes(payload.contentsBase64);
    case "get_masked_account_ids":
      return backend.getMaskedAccountIds();
    case "set_masked_account_ids":
      await backend.setMaskedAccountIds(payload.ids);
      return null;
    case "check_codex_processes":
      return backend.checkCodexProcesses();
    case "kill_codex_processes":
      return backend.killCodexProcesses();
    default:
      throw new Error(`Unsupported web command: ${command}`);
  }
}
