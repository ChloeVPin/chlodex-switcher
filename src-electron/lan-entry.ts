import { runLanServer } from "./lan-server";
import { loadAccounts } from "./backend";

const host = process.env.CODEX_SWITCHER_WEB_HOST || "0.0.0.0";
const port = parseInt(process.env.CODEX_SWITCHER_WEB_PORT || "3210", 10);

loadAccounts(); // Initialize/check configuration
runLanServer(host, port);
