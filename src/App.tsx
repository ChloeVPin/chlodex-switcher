import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAccounts } from "./hooks/useAccounts";
import { useForceCloseCodexProcesses } from "./hooks/useForceCloseCodexProcesses";
import {
  Zap,
  RefreshCw,
  Eye,
  EyeOff,
  Sun,
  Moon,
  ChevronDown,
  Plus,
  User,
  Check,
  Settings,
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  ShieldCheck,
  Users,
  LayoutDashboard,
  Lock,
  Download,
  Upload,
  Minus,
  Square,
  X,
} from "lucide-react";
import { AccountCard, AddAccountModal, UpdateChecker } from "./components";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./components/ui/dialog";
import { Spinner } from "./components/ui/spinner";
import { Separator } from "./components/ui/separator";
import { Switch } from "./components/ui/switch";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
import type { CodexProcessInfo, UsageInfo } from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  isDesktopRuntime as isTauriRuntime,
  invokeBackend,
  appWindow,
  listenToEvent,
} from "./lib/platform";
import "./App.css";

const THEME_STORAGE_KEY = "codex-switcher-theme";
const AUTO_WARMUP_ALL_STORAGE_KEY = "codex-switcher-auto-warmup-all";
const AUTO_WARMUP_ACCOUNTS_STORAGE_KEY = "codex-switcher-auto-warmup-accounts";
const AUTO_WARMUP_LEDGER_STORAGE_KEY =
  "codex-switcher-auto-warmup-last-success";
const AUTO_WARMUP_CHECK_INTERVAL_MS = 30 * 1000;
const AUTO_WARMUP_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES = 5;
const DEFAULT_PRIMARY_WINDOW_MINUTES = 300;
const LIMIT_FULL_THRESHOLD = 99.5;
const SWITCH_ACCOUNT_BLOCKED_EVENT = "switch-account-blocked";
type ThemeMode = "light" | "dark";
interface SwitchAccountBlockedPayload {
  accountId?: string;
  error?: string;
}
type AutoWarmupLedger = Record<
  string,
  {
    lastSuccessfulWarmupAt?: number;
  }
>;
const isMacOs =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);

function readStoredStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(AUTO_WARMUP_LEDGER_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([accountId, value]) => {
          const timestamp =
            value &&
            typeof value === "object" &&
            "lastSuccessfulWarmupAt" in value &&
            typeof value.lastSuccessfulWarmupAt === "number"
              ? value.lastSuccessfulWarmupAt
              : undefined;
          return timestamp
            ? [accountId, { lastSuccessfulWarmupAt: timestamp }]
            : null;
        })
        .filter(
          (entry): entry is [string, { lastSuccessfulWarmupAt: number }] =>
            Boolean(entry),
        ),
    );
  } catch {
    return {};
  }
}

function isLimitFull(usedPercent: number | null | undefined): boolean {
  return (
    usedPercent !== null &&
    usedPercent !== undefined &&
    usedPercent >= LIMIT_FULL_THRESHOLD
  );
}

function getPrimaryWindowMinutes(usage: UsageInfo): number {
  return usage.primary_window_minutes ?? DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function getPrimaryRemainingMs(usage: UsageInfo): number | null {
  if (!usage.primary_resets_at) return null;
  return usage.primary_resets_at * 1000 - Date.now();
}

function isPrimaryFullWindow(usage: UsageInfo): boolean {
  const remainingMs = getPrimaryRemainingMs(usage);
  if (remainingMs === null) return false;

  const thresholdMinutes = Math.max(
    0,
    getPrimaryWindowMinutes(usage) - AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES,
  );
  return remainingMs >= thresholdMinutes * 60 * 1000;
}

function getLastSuccessfulWarmupAt(
  ledger: AutoWarmupLedger,
  accountId: string,
): number | undefined {
  return ledger[accountId]?.lastSuccessfulWarmupAt;
}

function App() {
  const {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<
    "slim_export" | "slim_import"
  >("slim_export");
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [pendingTraySwitchAccountId, setPendingTraySwitchAccountId] = useState<
    string | null
  >(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOpeningCodex, setIsOpeningCodex] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true";
  });
  const [autoWarmupAccountIds, setAutoWarmupAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY)),
  );
  const [autoWarmupLedger, setAutoWarmupLedger] = useState<AutoWarmupLedger>(
    () => readStoredAutoWarmupLedger(),
  );
  const [autoWarmupRunningIds, setAutoWarmupRunningIds] = useState<Set<string>>(
    new Set(),
  );
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [otherAccountsSort, setOtherAccountsSort] = useState<
    | "deadline_asc"
    | "deadline_desc"
    | "remaining_desc"
    | "remaining_asc"
    | "subscription_asc"
    | "subscription_desc"
  >("deadline_asc");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      return saved === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const accountsRef = useRef(accounts);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupRunningIdsRef.current = autoWarmupRunningIds;
  }, [autoWarmupRunningIds]);

  useEffect(() => {
    if (loading || error) return;

    const validAccountIds = new Set(accounts.map((account) => account.id));

    setAutoWarmupAccountIds((prev) => {
      const next = new Set(
        Array.from(prev).filter((id) => validAccountIds.has(id)),
      );
      return next.size === prev.size ? prev : next;
    });

    setAutoWarmupLedger((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([accountId]) =>
          validAccountIds.has(accountId),
        ),
      );
      return Object.keys(next).length === Object.keys(prev).length
        ? prev
        : next;
    });

    for (const accountId of Object.keys(autoWarmupRetryAfterRef.current)) {
      if (!validAccountIds.has(accountId)) {
        delete autoWarmupRetryAfterRef.current[accountId];
      }
    }
  }, [accounts, error, loading]);

  useEffect(() => {
    autoWarmupLedgerRef.current = autoWarmupLedger;
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_LEDGER_STORAGE_KEY,
        JSON.stringify(autoWarmupLedger),
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupLedger]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ALL_STORAGE_KEY,
        String(autoWarmupAllEnabled),
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAllEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(Array.from(autoWarmupAccountIds)),
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAccountIds]);

  const handleTitlebarDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isTauriRuntime() || event.button !== 0) return;
      void appWindow.startDragging();
    },
    [],
  );

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime()) return;
    void appWindow.toggleMaximize();
  }, []);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const allMasked =
    accounts.length > 0 &&
    accounts.every((account) => maskedAccounts.has(account.id));

  const toggleMaskAll = () => {
    setMaskedAccounts((prev) => {
      const shouldMaskAll = !accounts.every((account) => prev.has(account.id));
      const next = shouldMaskAll
        ? new Set(accounts.map((account) => account.id))
        : new Set<string>();
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const checkProcesses = useCallback(async () => {
    try {
      const info = await invokeBackend<CodexProcessInfo>(
        "check_codex_processes",
      );
      setProcessInfo((prev) => {
        if (
          prev &&
          prev.can_switch === info.can_switch &&
          prev.count === info.count &&
          prev.background_count === info.background_count &&
          prev.pids.length === info.pids.length &&
          prev.pids.every((pid, index) => pid === info.pids[index])
        ) {
          return prev;
        }
        return info;
      });
      return info;
    } catch (err) {
      console.error("Failed to check processes:", err);
      return null;
    }
  }, []);

  // Check processes on mount and periodically
  useEffect(() => {
    checkProcesses();
    const interval = setInterval(checkProcesses, 5000);
    return () => clearInterval(interval);
  }, [checkProcesses]);

  // Load masked accounts from storage on mount
  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    const isDark = themeMode === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage errors; theme still works for current session.
    }
  }, [themeMode]);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs) return;

    let unlisten: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        setIsWindowMaximized(await appWindow.isMaximized());
      } catch (err) {
        console.error("Failed to read window state:", err);
      }
    };

    void syncMaximizedState();

    appWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to watch window resize:", err);
      });

    return () => {
      unlisten?.();
    };
  }, []);

  const handleSwitch = async (accountId: string) => {
    // Check processes before switching
    const latestProcessInfo = await checkProcesses();
    if (latestProcessInfo && !latestProcessInfo.can_switch) {
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
    } catch (err) {
      console.error("Failed to switch account:", err);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDelete = async (accountId: string) => {
    if (deleteConfirmId !== accountId) {
      setDeleteConfirmId(accountId);
      setTimeout(() => setDeleteConfirmId(null), 3000);
      return;
    }

    try {
      await deleteAccount(accountId);
      setDeleteConfirmId(null);
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshSuccess(false);
    try {
      await refreshUsage(undefined, { refreshMetadata: true });
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 2000);
    } finally {
      setIsRefreshing(false);
    }
  };

  const showWarmupToast = useCallback((message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  }, []);

  const formatWarmupError = useCallback((err: unknown) => {
    if (!err) return "Unknown error";
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }, []);

  const markSuccessfulWarmup = useCallback(
    (accountId: string, timestamp = Date.now()) => {
      setAutoWarmupLedger((prev) => ({
        ...prev,
        [accountId]: { lastSuccessfulWarmupAt: timestamp },
      }));
    },
    [],
  );

  const {
    forceCloseConfirmOpen,
    setForceCloseConfirmOpen,
    isForceClosingCodex,
    forceCloseCodexProcesses,
  } = useForceCloseCodexProcesses({
    processCount: processInfo?.count ?? 0,
    checkProcesses,
    showToast: showWarmupToast,
    formatError: formatWarmupError,
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void (async () => {
      if (!isTauriRuntime()) return;
      unlisten = await listenToEvent<SwitchAccountBlockedPayload>(
        SWITCH_ACCOUNT_BLOCKED_EVENT,
        async (payload) => {
          const latestProcessInfo = await checkProcesses();
          const accountId = payload?.accountId;

          if (accountId && latestProcessInfo && !latestProcessInfo.can_switch) {
            setPendingTraySwitchAccountId(accountId);
            setForceCloseConfirmOpen(true);
            return;
          }

          if (accountId && latestProcessInfo?.can_switch) {
            try {
              setSwitchingId(accountId);
              await switchAccount(accountId);
              setPendingTraySwitchAccountId(null);
              showWarmupToast("Switched account from tray.");
            } catch (err) {
              console.error("Failed to retry tray account switch:", err);
              showWarmupToast(`Switch failed: ${formatWarmupError(err)}`, true);
            } finally {
              setSwitchingId(null);
            }
            return;
          }

          showWarmupToast(
            payload?.error || "Account switch was blocked.",
            true,
          );
        },
      );
    })();

    return () => unlisten?.();
  }, [
    checkProcesses,
    formatWarmupError,
    setForceCloseConfirmOpen,
    showWarmupToast,
    switchAccount,
  ]);

  const handleForceCloseConfirm = useCallback(async () => {
    const accountId = pendingTraySwitchAccountId;
    const latestProcessInfo = await forceCloseCodexProcesses();

    if (!accountId) {
      return;
    }

    if (!latestProcessInfo?.can_switch) {
      setPendingTraySwitchAccountId(null);
      return;
    }

    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
      setPendingTraySwitchAccountId(null);
      showWarmupToast("Switched account after force closing Codex.");
    } catch (err) {
      console.error("Failed to switch account after force close:", err);
      setPendingTraySwitchAccountId(null);
      showWarmupToast(
        `Switch failed after force close: ${formatWarmupError(err)}`,
        true,
      );
    } finally {
      setSwitchingId(null);
    }
  }, [
    forceCloseCodexProcesses,
    formatWarmupError,
    pendingTraySwitchAccountId,
    showWarmupToast,
    switchAccount,
  ]);

  const handleWarmupAccount = async (
    accountId: string,
    accountName: string,
  ) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      markSuccessfulWarmup(accountId);
      showWarmupToast(`Warm-up sent for ${accountName}`);
    } catch (err) {
      console.error("Failed to warm up account:", err);
      showWarmupToast(
        `Warm-up failed for ${accountName}: ${formatWarmupError(err)}`,
        true,
      );
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        showWarmupToast("No accounts available for warm-up", true);
        return;
      }

      const warmedAt = Date.now();
      const failedAccountIds = new Set(summary.failed_account_ids);
      accounts.forEach((account) => {
        if (!failedAccountIds.has(account.id)) {
          markSuccessfulWarmup(account.id, warmedAt);
        }
      });

      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(
          `Warm-up sent for all ${summary.warmed_accounts} account${
            summary.warmed_accounts === 1 ? "" : "s"
          }`,
        );
      } else {
        showWarmupToast(
          `Warmed ${summary.warmed_accounts}/${summary.total_accounts}. Failed: ${summary.failed_account_ids.length}`,
          true,
        );
      }
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      showWarmupToast(`Warm-up all failed: ${formatWarmupError(err)}`, true);
    } finally {
      setIsWarmingAll(false);
    }
  };

  const toggleAutoWarmupAccount = (accountId: string) => {
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const isAutoWarmupDue = useCallback(
    (accountId: string, usage: UsageInfo | undefined) => {
      if (!usage || usage.error || !usage.primary_resets_at) return false;
      if (isLimitFull(usage.secondary_used_percent)) return false;
      if (!isPrimaryFullWindow(usage)) return false;

      const lastSuccessfulWarmupAt = getLastSuccessfulWarmupAt(
        autoWarmupLedgerRef.current,
        accountId,
      );
      if (
        lastSuccessfulWarmupAt &&
        Date.now() - lastSuccessfulWarmupAt <
          AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS
      ) {
        return false;
      }

      return true;
    },
    [],
  );

  const getAutoWarmupLabel = useCallback(
    (usage: UsageInfo | undefined, isEnabled: boolean, isRunning: boolean) => {
      if (isRunning) return "Warming...";
      if (!isEnabled) return "Auto: off";
      if (!usage || usage.error || !usage.primary_resets_at) return "Auto: on";

      if (isLimitFull(usage.secondary_used_percent)) {
        return "Waiting weekly reset";
      }

      return "Auto: on";
    },
    [],
  );

  const backOffAutoWarmupRetry = useCallback((accountId: string) => {
    autoWarmupRetryAfterRef.current[accountId] =
      Date.now() + AUTO_WARMUP_RETRY_BACKOFF_MS;
  }, []);

  const runAutoWarmupForAccount = useCallback(
    async (accountId: string, accountName: string) => {
      setAutoWarmupRunningIds((prev) => new Set(prev).add(accountId));

      try {
        let freshUsage: UsageInfo;
        try {
          freshUsage = await refreshSingleUsage(accountId);
        } catch (err) {
          console.error("Auto warm-up usage refresh failed:", err);
          backOffAutoWarmupRetry(accountId);
          return;
        }

        if (freshUsage.error || !freshUsage.primary_resets_at) {
          backOffAutoWarmupRetry(accountId);
          return;
        }
        if (!isAutoWarmupDue(accountId, freshUsage)) {
          return;
        }

        await warmupAccount(accountId);
        markSuccessfulWarmup(accountId);
        showWarmupToast(`Auto warm-up sent for ${accountName}`);
      } catch (err) {
        console.error("Auto warm-up failed:", err);
        backOffAutoWarmupRetry(accountId);
        showWarmupToast(
          `Auto warm-up failed for ${accountName}: ${formatWarmupError(err)}`,
          true,
        );
      } finally {
        setAutoWarmupRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(accountId);
          return next;
        });
      }
    },
    [
      backOffAutoWarmupRetry,
      formatWarmupError,
      isAutoWarmupDue,
      markSuccessfulWarmup,
      refreshSingleUsage,
      showWarmupToast,
      warmupAccount,
    ],
  );

  useEffect(() => {
    if (!autoWarmupAllEnabled && autoWarmupAccountIds.size === 0) return;

    const checkAutoWarmup = () => {
      for (const account of accountsRef.current) {
        const autoEnabled =
          autoWarmupAllEnabled ||
          autoWarmupAccountIdsRef.current.has(account.id);
        if (!autoEnabled || autoWarmupRunningIdsRef.current.has(account.id))
          continue;

        const retryAfter = autoWarmupRetryAfterRef.current[account.id];
        if (retryAfter && Date.now() < retryAfter) continue;

        if (!isAutoWarmupDue(account.id, account.usage)) continue;

        void runAutoWarmupForAccount(account.id, account.name);
      }
    };

    checkAutoWarmup();
    const interval = window.setInterval(
      checkAutoWarmup,
      AUTO_WARMUP_CHECK_INTERVAL_MS,
    );

    return () => window.clearInterval(interval);
  }, [
    autoWarmupAccountIds.size,
    autoWarmupAllEnabled,
    isAutoWarmupDue,
    runAutoWarmupForAccount,
  ]);

  const handleExportSlimText = async () => {
    setConfigModalMode("slim_export");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);

    try {
      setIsExportingSlim(true);
      const payload = await exportAccountsSlimText();
      setConfigPayload(payload);
      showWarmupToast(`Slim text exported (${accounts.length} accounts).`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim export failed", true);
    } finally {
      setIsExportingSlim(false);
    }
  };

  const openImportSlimTextModal = () => {
    setConfigModalMode("slim_import");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);
  };

  const handleImportSlimText = async () => {
    if (!configPayload.trim()) {
      setConfigModalError("Please paste the slim text string first.");
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`,
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim import failed", true);
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast("Full encrypted file exported.");
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      showWarmupToast("Full export failed", true);
    } finally {
      setIsExportingFull(false);
    }
  };

  const handleImportFullFile = async () => {
    try {
      setIsImportingFull(true);
      const summary = await importFullBackupFile();
      if (!summary) return;
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      const maskedIds = await loadMaskedAccountIds();
      setMaskedAccounts(new Set(maskedIds));
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count} (total ${summary.total_in_payload})`,
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      showWarmupToast("Full import failed", true);
    } finally {
      setIsImportingFull(false);
    }
  };

  const handleOpenCodexApp = async () => {
    try {
      setIsOpeningCodex(true);
      await invokeBackend("open_codex_app");
      showWarmupToast("Codex app opened.");
      setTimeout(() => {
        void checkProcesses();
      }, 1500);
    } catch (err) {
      console.error("Failed to open Codex app:", err);
      showWarmupToast(`Open Codex failed: ${formatWarmupError(err)}`, true);
    } finally {
      setIsOpeningCodex(false);
    }
  };

  const activeAccount = accounts.find((a) => a.is_active);
  const otherAccounts = accounts.filter((a) => !a.is_active);
  const hasRunningProcesses = processInfo && processInfo.count > 0;
  const limitedAccountsCount = accounts.filter(
    (account) =>
      isLimitFull(account.usage?.primary_used_percent) ||
      isLimitFull(account.usage?.secondary_used_percent),
  ).length;
  const accountsWithUsageCount = accounts.filter(
    (account) => account.usage && !account.usage.error,
  ).length;
  const autoWarmupEnabledCount = autoWarmupAllEnabled
    ? accounts.length
    : autoWarmupAccountIds.size;
  const warmingNowCount = autoWarmupRunningIds.size + (warmingUpId ? 1 : 0);
  const processStatusTone = hasRunningProcesses
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";
  const pendingTraySwitchAccount = useMemo(
    () => accounts.find((account) => account.id === pendingTraySwitchAccountId),
    [accounts, pendingTraySwitchAccountId],
  );
  const forceCloseConfirmLabel = pendingTraySwitchAccount
    ? "Force Close & Switch"
    : "Force Close Codex";

  const sortedOtherAccounts = useMemo(() => {
    const getResetDeadline = (resetAt: number | null | undefined) =>
      resetAt ?? Number.POSITIVE_INFINITY;

    const getSubscriptionDeadline = (expiresAt: string | null | undefined) => {
      if (!expiresAt) return null;
      const timestamp = new Date(expiresAt).getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    };

    const compareOptionalNumber = (
      aValue: number | null,
      bValue: number | null,
      direction: "asc" | "desc",
    ) => {
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return direction === "asc" ? aValue - bValue : bValue - aValue;
    };

    const getRemainingPercent = (usedPercent: number | null | undefined) => {
      if (usedPercent === null || usedPercent === undefined) {
        return Number.NEGATIVE_INFINITY;
      }
      return Math.max(0, 100 - usedPercent);
    };

    return [...otherAccounts].sort((a, b) => {
      if (
        otherAccountsSort === "subscription_asc" ||
        otherAccountsSort === "subscription_desc"
      ) {
        const subscriptionDiff = compareOptionalNumber(
          getSubscriptionDeadline(a.subscription_expires_at),
          getSubscriptionDeadline(b.subscription_expires_at),
          otherAccountsSort === "subscription_asc" ? "asc" : "desc",
        );
        if (subscriptionDiff !== 0) return subscriptionDiff;

        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) return deadlineDiff;

        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;

        return a.name.localeCompare(b.name);
      }

      if (
        otherAccountsSort === "deadline_asc" ||
        otherAccountsSort === "deadline_desc"
      ) {
        const deadlineDiff =
          getResetDeadline(a.usage?.primary_resets_at) -
          getResetDeadline(b.usage?.primary_resets_at);
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc"
            ? deadlineDiff
            : -deadlineDiff;
        }
        const remainingDiff =
          getRemainingPercent(b.usage?.primary_used_percent) -
          getRemainingPercent(a.usage?.primary_used_percent);
        if (remainingDiff !== 0) return remainingDiff;
        return a.name.localeCompare(b.name);
      }

      const remainingDiff =
        getRemainingPercent(b.usage?.primary_used_percent) -
        getRemainingPercent(a.usage?.primary_used_percent);
      if (otherAccountsSort === "remaining_desc" && remainingDiff !== 0) {
        return remainingDiff;
      }
      if (otherAccountsSort === "remaining_asc" && remainingDiff !== 0) {
        return -remainingDiff;
      }
      const deadlineDiff =
        getResetDeadline(a.usage?.primary_resets_at) -
        getResetDeadline(b.usage?.primary_resets_at);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.name.localeCompare(b.name);
    });
  }, [otherAccounts, otherAccountsSort]);

  return (
    <TooltipProvider>
      <div className="relative flex min-h-screen bg-background text-foreground">
        <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col border-r border-border/60 bg-card text-card-foreground">
          <div
            onMouseDown={handleTitlebarDrag}
            onDoubleClick={handleTitlebarDoubleClick}
            className="wails-drag-region flex h-16 items-center gap-3 px-4"
          >
            <svg
              className="size-8 shrink-0 text-foreground"
              viewBox="0 0 502 532"
              fill="currentColor"
            >
              <g fillOpacity="1">
                <path d="M 26 286 L 176 286 L 176 286 L 176 426 L 176 426 L 52 426 A 26 26 0 0 1 26 400 L 26 286 L 26 286 Z" />
                <path d="M 176 366 L 326 366 L 326 366 L 326 506 L 326 506 L 202 506 A 26 26 0 0 1 176 480 L 176 366 L 176 366 Z" />
                <path d="M 326 366 L 450 366 A 26 26 0 0 1 476 392 L 476 480 A 26 26 0 0 1 450 506 L 326 506 L 326 506 L 326 366 L 326 366 Z" />
                <path d="M 52 146 L 176 146 L 176 146 L 176 286 L 176 286 L 26 286 L 26 286 L 26 172 A 26 26 0 0 1 52 146 Z" />
                <path d="M 202 26 L 326 26 L 326 26 L 326 166 L 326 166 L 176 166 L 176 166 L 176 52 A 26 26 0 0 1 202 26 Z" />
                <path d="M 326 26 L 450 26 A 26 26 0 0 1 476 52 L 476 140 A 26 26 0 0 1 450 166 L 326 166 L 326 166 L 326 26 L 326 26 Z" />
                <path d="M 222 196 L 450 196 A 26 26 0 0 1 476 222 L 476 310 A 26 26 0 0 1 450 336 L 222 336 A 26 26 0 0 1 196 310 L 196 222 A 26 26 0 0 1 222 196 Z" />
                <path d="M 176 340 C 176 359.5 181.2 366 202 366 H 176 Z" />
                <path d="M 176 452 C 176 432.5 170.8 426 150 426 H 176 Z" />
                <path d="M 176 192 C 176 172.5 181.2 166 202 166 H 176 Z" />
                <path d="M 176 120 C 176 139.5 170.8 146 150 146 H 176 Z" />
              </g>
            </svg>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-none">
                Codex Switcher
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">v1.0.0</p>
            </div>
            <Button
              onClick={() =>
                setThemeMode((prev) => (prev === "dark" ? "light" : "dark"))
              }
              variant="ghost"
              size="icon-sm"
              className="wails-no-drag ml-auto text-muted-foreground hover:text-foreground"
              title={
                themeMode === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
            >
              {themeMode === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          </div>

          <div className="wails-no-drag sidebar-scroll flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
            <nav className="grid gap-1">
              <Button variant="secondary" size="sm" className="justify-start">
                <LayoutDashboard className="size-4" />
                Dashboard
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`justify-start ${hasRunningProcesses ? "text-foreground" : "text-muted-foreground"}`}
                onClick={() => {
                  if (hasRunningProcesses) {
                    setPendingTraySwitchAccountId(null);
                    setForceCloseConfirmOpen(true);
                  }
                }}
              >
                <Activity className="size-4" />
                {processInfo
                  ? `${processInfo.count} Codex running`
                  : "Checking processes"}
              </Button>
            </nav>

            <div className="grid gap-2">
              <Button
                onClick={() => setIsAddModalOpen(true)}
                size="sm"
                className="justify-start"
              >
                <Plus className="size-4" />
                Add account
              </Button>
              <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">
                Account operations
              </p>
              <Button
                onClick={handleRefresh}
                disabled={isRefreshing}
                variant="ghost"
                size="sm"
                className="justify-start"
              >
                <RefreshCw
                  className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
                />
                Refresh usage
              </Button>
              <Button
                onClick={handleWarmupAll}
                disabled={isWarmingAll || accounts.length === 0}
                variant="ghost"
                size="sm"
                className="justify-start"
              >
                <Zap
                  className={`size-4 ${isWarmingAll ? "animate-pulse" : ""}`}
                />
                Warm up all
              </Button>
              <Button
                onClick={toggleMaskAll}
                disabled={accounts.length === 0}
                variant="ghost"
                size="sm"
                className="justify-start"
              >
                {allMasked ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
                {allMasked ? "Show credentials" : "Hide credentials"}
              </Button>
            </div>

            <div className="grid gap-3 px-2">
              <p className="text-xs font-medium text-muted-foreground">
                Automation
              </p>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <Clock3 className="size-4 text-muted-foreground" />
                  Auto warm-up
                </div>
                <Switch
                  size="sm"
                  checked={autoWarmupAllEnabled}
                  disabled={accounts.length === 0}
                  onCheckedChange={(checked) =>
                    setAutoWarmupAllEnabled(checked)
                  }
                  aria-label="Auto warm-up all accounts"
                />
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2">
                  <Lock className="size-4 text-muted-foreground" />
                  Masked
                </span>
                <Badge variant="outline" className="rounded-md">
                  {maskedAccounts.size}/{accounts.length}
                </Badge>
              </div>
            </div>

            <div className="grid gap-2">
              <p className="px-2 text-xs font-medium text-muted-foreground">
                Backup
              </p>
              <Button
                onClick={handleExportSlimText}
                disabled={isExportingSlim}
                variant="ghost"
                size="sm"
                className="justify-start"
              >
                <Download className="size-4" />
                {isExportingSlim ? "Exporting..." : "Export slim text"}
              </Button>
              <Button
                onClick={openImportSlimTextModal}
                disabled={isImportingSlim}
                variant="ghost"
                size="sm"
                className="justify-start"
              >
                <Upload className="size-4" />
                {isImportingSlim ? "Importing..." : "Import slim text"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="justify-start">
                    <Settings className="size-4" />
                    More backup actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  className="w-56"
                >
                  <DropdownMenuItem
                    onClick={handleExportFullFile}
                    disabled={isExportingFull}
                  >
                    {isExportingFull
                      ? "Exporting..."
                      : "Export Full Encrypted File"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleImportFullFile}
                    disabled={isImportingFull}
                  >
                    {isImportingFull
                      ? "Importing..."
                      : "Import Full Encrypted File"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="mt-auto space-y-3">
              {isTauriRuntime() && (
                <Button
                  onClick={handleOpenCodexApp}
                  disabled={isOpeningCodex || Boolean(hasRunningProcesses)}
                  variant="outline"
                  size="sm"
                  className="w-full justify-start"
                >
                  <Zap className="size-4" />
                  {isOpeningCodex ? "Opening..." : "Open Codex"}
                </Button>
              )}
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="@container/main app-scroll min-w-0 flex-1 overflow-y-auto">
          {!isMacOs && (
            <div className="wails-drag-region sticky top-0 z-50 flex h-12 items-center justify-end px-4 md:px-6">
              <div className="wails-no-drag flex items-center gap-1">
                <Button
                  onClick={() => {
                    void appWindow.minimize();
                  }}
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Minimize"
                >
                  <Minus className="size-3.5" />
                </Button>
                <Button
                  onClick={() => {
                    void appWindow.toggleMaximize();
                  }}
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={isWindowMaximized ? "Restore" : "Maximize"}
                >
                  <Square className="size-3.5" />
                </Button>
                <Button
                  onClick={() => {
                    void appWindow.close();
                  }}
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 text-muted-foreground hover:bg-destructive hover:text-white"
                  title="Close"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          )}
          {loading && accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24">
              <Spinner className="h-8 w-8 text-primary mb-4" />
              <p className="text-xs text-muted-foreground">
                Loading accounts...
              </p>
            </div>
          ) : error ? (
            <div className="mx-auto flex min-h-[55vh] w-full max-w-xl items-center px-6">
              <Card className="w-full border-destructive/25 bg-destructive/5 py-0 shadow-none">
                <CardHeader className="border-b border-destructive/15 px-5 py-4">
                  <CardTitle className="flex items-center gap-2 text-sm text-destructive">
                    <AlertTriangle className="size-4" />
                    Failed to load accounts
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-5 py-4 text-sm text-muted-foreground">
                  {error}
                </CardContent>
              </Card>
            </div>
          ) : accounts.length === 0 ? (
            <div className="mx-auto flex min-h-[65vh] w-full max-w-xl items-center px-6">
              <Card className="w-full border-dashed bg-card/80 py-0 text-center shadow-none">
                <CardContent className="flex flex-col items-center px-8 py-10">
                  <div className="mb-5 flex size-12 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
                    <User strokeWidth={2.5} size={24} />
                  </div>
                  <h2 className="mb-1 text-base font-semibold text-foreground">
                    No accounts yet
                  </h2>
                  <p className="mb-6 max-w-sm text-sm text-muted-foreground">
                    Add your first Codex account to start switching profiles and
                    watching limits.
                  </p>
                  <Button onClick={() => setIsAddModalOpen(true)} size="sm">
                    <Plus className="size-4" />
                    Add Account
                  </Button>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 md:gap-6 md:px-6 md:py-6">
              <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card className="dashboard-stat-card py-0">
                  <CardHeader className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">
                        Accounts
                      </span>
                      <Users className="size-4 text-muted-foreground" />
                    </div>
                    <CardTitle className="text-2xl tabular-nums">
                      {accounts.length}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4 text-xs text-muted-foreground">
                    {activeAccount
                      ? `${otherAccounts.length} available to switch`
                      : "No active account selected"}
                  </CardContent>
                </Card>

                <Card className="dashboard-stat-card py-0">
                  <CardHeader className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">
                        Usage data
                      </span>
                      <Database className="size-4 text-muted-foreground" />
                    </div>
                    <CardTitle className="text-2xl tabular-nums">
                      {accountsWithUsageCount}/{accounts.length}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4 text-xs text-muted-foreground">
                    {limitedAccountsCount > 0
                      ? `${limitedAccountsCount} account${limitedAccountsCount === 1 ? "" : "s"} at limit`
                      : "No accounts at limit"}
                  </CardContent>
                </Card>

                <Card className="dashboard-stat-card py-0">
                  <CardHeader className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">
                        Codex process
                      </span>
                      <Activity className={`size-4 ${processStatusTone}`} />
                    </div>
                    <CardTitle
                      className={`text-2xl tabular-nums ${processStatusTone}`}
                    >
                      {processInfo ? processInfo.count : "-"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4 text-xs text-muted-foreground">
                    {hasRunningProcesses
                      ? "Switching paused"
                      : "Ready for account switching"}
                  </CardContent>
                </Card>

                <Card className="dashboard-stat-card py-0">
                  <CardHeader className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">
                        Auto warm-up
                      </span>
                      <Clock3 className="size-4 text-muted-foreground" />
                    </div>
                    <CardTitle className="text-2xl tabular-nums">
                      {autoWarmupEnabledCount}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-5 pb-4 text-xs text-muted-foreground">
                    {warmingNowCount > 0
                      ? `${warmingNowCount} warming now`
                      : "No warm-up jobs running"}
                  </CardContent>
                </Card>
              </section>

              <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                {activeAccount && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-sm font-semibold text-foreground">
                          Active account
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          Current profile used by Codex.
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="rounded-md border-border/70 bg-muted/30 text-muted-foreground"
                      >
                        <ShieldCheck className="size-3" />
                        Active
                      </Badge>
                    </div>
                    <AccountCard
                      account={activeAccount}
                      onSwitch={() => {}}
                      onWarmup={() =>
                        handleWarmupAccount(
                          activeAccount.id,
                          activeAccount.name,
                        )
                      }
                      onDelete={() => handleDelete(activeAccount.id)}
                      onRefresh={() =>
                        refreshSingleUsage(activeAccount.id, {
                          refreshMetadata: true,
                        })
                      }
                      onRename={(newName) =>
                        renameAccount(activeAccount.id, newName)
                      }
                      switching={switchingId === activeAccount.id}
                      switchDisabled={hasRunningProcesses ?? false}
                      warmingUp={
                        isWarmingAll ||
                        warmingUpId === activeAccount.id ||
                        autoWarmupRunningIds.has(activeAccount.id)
                      }
                      masked={maskedAccounts.has(activeAccount.id)}
                      onToggleMask={() => toggleMask(activeAccount.id)}
                      autoWarmupEnabled={
                        autoWarmupAllEnabled ||
                        autoWarmupAccountIds.has(activeAccount.id)
                      }
                      autoWarmupManagedByAll={autoWarmupAllEnabled}
                      autoWarmupLabel={getAutoWarmupLabel(
                        activeAccount.usage,
                        autoWarmupAllEnabled ||
                          autoWarmupAccountIds.has(activeAccount.id),
                        autoWarmupRunningIds.has(activeAccount.id),
                      )}
                      onToggleAutoWarmup={() =>
                        toggleAutoWarmupAccount(activeAccount.id)
                      }
                    />
                  </div>
                )}

                <Card className="quiet-panel py-0">
                  <CardHeader className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-sm">
                          Switching guard
                        </CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Process state and global account controls.
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={`rounded-md ${
                          hasRunningProcesses
                            ? "border-border/70 bg-muted/40 text-foreground"
                            : "border-border/70 bg-muted/30 text-muted-foreground"
                        }`}
                      >
                        {hasRunningProcesses ? "Blocked" : "Ready"}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 px-5 py-5">
                    <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/25 px-4 py-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {processInfo
                            ? `${processInfo.count} Codex process${processInfo.count === 1 ? "" : "es"}`
                            : "Process check pending"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {hasRunningProcesses
                            ? `${processInfo?.background_count ?? 0} background task${(processInfo?.background_count ?? 0) === 1 ? "" : "s"} detected`
                            : "No active process blocking switches"}
                        </div>
                      </div>
                      {hasRunningProcesses ? (
                        <Button
                          onClick={() => {
                            setPendingTraySwitchAccountId(null);
                            setForceCloseConfirmOpen(true);
                          }}
                          disabled={isForceClosingCodex}
                          variant="destructive"
                          size="sm"
                        >
                          Force close
                        </Button>
                      ) : isTauriRuntime() ? (
                        <Button
                          onClick={handleOpenCodexApp}
                          disabled={isOpeningCodex}
                          variant="outline"
                          size="sm"
                        >
                          {isOpeningCodex ? "Opening..." : "Open Codex"}
                        </Button>
                      ) : null}
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Hide credentials
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Mask account names and emails.
                          </div>
                        </div>
                        <Switch
                          checked={allMasked}
                          onCheckedChange={toggleMaskAll}
                          aria-label="Hide credentials"
                        />
                      </div>
                      <Separator className="soft-divider" />
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Auto warm-up all
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Keep eligible accounts ready.
                          </div>
                        </div>
                        <Switch
                          checked={autoWarmupAllEnabled}
                          disabled={accounts.length === 0}
                          onCheckedChange={(checked) =>
                            setAutoWarmupAllEnabled(checked)
                          }
                          aria-label="Auto warm-up all accounts"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        variant="outline"
                        size="sm"
                      >
                        <RefreshCw
                          className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
                        />
                        Refresh
                      </Button>
                      <Button
                        onClick={handleWarmupAll}
                        disabled={isWarmingAll || accounts.length === 0}
                        variant="outline"
                        size="sm"
                      >
                        <Zap
                          className={`size-4 ${isWarmingAll ? "animate-pulse" : ""}`}
                        />
                        Warm all
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </section>

              {otherAccounts.length > 0 && (
                <section className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">
                        Other accounts
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {otherAccounts.length} profile
                        {otherAccounts.length === 1 ? "" : "s"} available for
                        switching.
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="justify-between sm:min-w-60"
                        >
                          <span>
                            {otherAccountsSort === "deadline_asc" &&
                              "Reset: earliest to latest"}
                            {otherAccountsSort === "deadline_desc" &&
                              "Reset: latest to earliest"}
                            {otherAccountsSort === "remaining_desc" &&
                              "% remaining: highest to lowest"}
                            {otherAccountsSort === "remaining_asc" &&
                              "% remaining: lowest to highest"}
                            {otherAccountsSort === "subscription_asc" &&
                              "Expiry: earliest to latest"}
                            {otherAccountsSort === "subscription_desc" &&
                              "Expiry: latest to earliest"}
                          </span>
                          <ChevronDown className="size-4 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuItem
                          onClick={() => setOtherAccountsSort("deadline_asc")}
                        >
                          Reset: earliest to latest
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setOtherAccountsSort("deadline_desc")}
                        >
                          Reset: latest to earliest
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setOtherAccountsSort("remaining_desc")}
                        >
                          % remaining: highest to lowest
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setOtherAccountsSort("remaining_asc")}
                        >
                          % remaining: lowest to highest
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() =>
                            setOtherAccountsSort("subscription_asc")
                          }
                        >
                          Expiry: earliest to latest
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            setOtherAccountsSort("subscription_desc")
                          }
                        >
                          Expiry: latest to earliest
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {sortedOtherAccounts.map((account) => (
                      <AccountCard
                        key={account.id}
                        account={account}
                        onSwitch={() => handleSwitch(account.id)}
                        onWarmup={() =>
                          handleWarmupAccount(account.id, account.name)
                        }
                        onDelete={() => handleDelete(account.id)}
                        onRefresh={() =>
                          refreshSingleUsage(account.id, {
                            refreshMetadata: true,
                          })
                        }
                        onRename={(newName) =>
                          renameAccount(account.id, newName)
                        }
                        switching={switchingId === account.id}
                        switchDisabled={hasRunningProcesses ?? false}
                        warmingUp={
                          isWarmingAll ||
                          warmingUpId === account.id ||
                          autoWarmupRunningIds.has(account.id)
                        }
                        masked={maskedAccounts.has(account.id)}
                        onToggleMask={() => toggleMask(account.id)}
                        autoWarmupEnabled={
                          autoWarmupAllEnabled ||
                          autoWarmupAccountIds.has(account.id)
                        }
                        autoWarmupManagedByAll={autoWarmupAllEnabled}
                        autoWarmupLabel={getAutoWarmupLabel(
                          account.usage,
                          autoWarmupAllEnabled ||
                            autoWarmupAccountIds.has(account.id),
                          autoWarmupRunningIds.has(account.id),
                        )}
                        onToggleAutoWarmup={() =>
                          toggleAutoWarmupAccount(account.id)
                        }
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </main>

        {/* Refresh Success Toast */}
        {refreshSuccess && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 bg-emerald-500/90 text-white rounded-lg shadow-lg text-xs font-semibold flex items-center gap-2 backdrop-blur-xs">
            <Check strokeWidth={3} size={14} className="text-white" /> Usage
            refreshed successfully
          </div>
        )}

        {/* Warm-up Toast */}
        {warmupToast && (
          <div
            className={`fixed bottom-20 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-lg shadow-lg text-xs font-semibold ${
              warmupToast.isError
                ? "bg-red-500/90 text-white"
                : "bg-amber-500/10 text-amber-500 border border-amber-500/20 dark:bg-amber-950/40 dark:border-amber-700/40 backdrop-blur-xs"
            }`}
          >
            {warmupToast.message}
          </div>
        )}

        {/* Delete Confirmation Toast */}
        {deleteConfirmId && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 bg-destructive/90 text-white rounded-lg shadow-lg text-xs font-semibold backdrop-blur-xs animate-pulse">
            Click delete again to confirm removal
          </div>
        )}

        {/* Force Close Modal */}
        <Dialog
          open={forceCloseConfirmOpen}
          onOpenChange={(open) => {
            if (!open) setForceCloseConfirmOpen(false);
          }}
        >
          <DialogContent
            className="sm:max-w-md gap-0 overflow-hidden border-border/70 bg-card p-0 shadow-xl shadow-black/10 dark:shadow-black/35"
            showCloseButton={true}
          >
            <DialogHeader className="px-6 pb-3 pt-5 text-left">
              <DialogTitle className="text-base font-semibold text-foreground">
                Force close Codex?
              </DialogTitle>
              <DialogDescription>
                Close running Codex processes before switching accounts.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 px-6 py-5">
              <div className="rounded-lg bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
                    <AlertTriangle className="size-4" />
                  </div>
                  <div className="text-sm">
                    <p className="font-medium text-foreground">
                      {processInfo?.count ?? 0} process
                      {(processInfo?.count ?? 0) === 1 ? "" : "es"} will be
                      closed
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Account switching is blocked while Codex is running.
                    </p>
                  </div>
                </div>
              </div>
              {pendingTraySwitchAccount && (
                <p className="rounded-lg bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                  After closing Codex, Codex Switcher will switch to{" "}
                  <span className="font-semibold text-foreground">
                    {pendingTraySwitchAccount.name}
                  </span>
                  .
                </p>
              )}
              <p className="rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Unsaved Codex work may be lost.
              </p>
            </div>
            <DialogFooter className="gap-2 bg-muted/15 px-6 py-4">
              <Button
                onClick={() => {
                  setPendingTraySwitchAccountId(null);
                  setForceCloseConfirmOpen(false);
                }}
                disabled={isForceClosingCodex}
                variant="ghost"
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button
                onClick={handleForceCloseConfirm}
                disabled={isForceClosingCodex}
                variant="destructive"
                className="w-full sm:w-auto"
              >
                {isForceClosingCodex ? (
                  <span className="flex items-center gap-2 justify-center">
                    <Spinner className="h-4 w-4" />
                    <span>Closing...</span>
                  </span>
                ) : (
                  forceCloseConfirmLabel
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Import/Export Config Modal */}
        <Dialog
          open={isConfigModalOpen}
          onOpenChange={(open) => {
            if (!open) setIsConfigModalOpen(false);
          }}
        >
          <DialogContent
            className="sm:max-w-2xl gap-0 overflow-hidden border-border/70 bg-card p-0 shadow-xl shadow-black/10 dark:shadow-black/35"
            showCloseButton={true}
          >
            <DialogHeader className="px-6 pb-3 pt-5 text-left">
              <DialogTitle className="text-base font-semibold text-foreground">
                {configModalMode === "slim_export"
                  ? "Export Slim Text"
                  : "Import Slim Text"}
              </DialogTitle>
              <DialogDescription>
                {configModalMode === "slim_export"
                  ? "Copy a compact account backup string."
                  : "Paste a compact backup string to add missing accounts."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 px-6 py-5">
              {configModalMode === "slim_import" ? (
                <p className="rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Existing accounts are kept. Only missing accounts are
                  imported.
                </p>
              ) : (
                <p className="rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  This slim string contains account secrets. Keep it private.
                </p>
              )}
              <textarea
                value={configPayload}
                onChange={(e) => setConfigPayload(e.target.value)}
                readOnly={configModalMode === "slim_export"}
                placeholder={
                  configModalMode === "slim_export"
                    ? isExportingSlim
                      ? "Generating..."
                      : "Export string will appear here"
                    : "Paste config string here"
                }
                className="h-52 w-full resize-none rounded-lg border bg-background px-4 py-3 font-mono text-sm text-foreground shadow-inner shadow-black/[0.02] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {configModalError && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {configModalError}
                </div>
              )}
            </div>
            <DialogFooter className="gap-2 bg-muted/15 px-6 py-4">
              <Button
                onClick={() => setIsConfigModalOpen(false)}
                variant="ghost"
                className="w-full sm:w-auto"
              >
                Close
              </Button>
              {configModalMode === "slim_export" ? (
                <Button
                  onClick={async () => {
                    if (!configPayload) return;
                    try {
                      await navigator.clipboard.writeText(configPayload);
                      setConfigCopied(true);
                      setTimeout(() => setConfigCopied(false), 1500);
                    } catch {
                      setConfigModalError(
                        "Clipboard unavailable. Please copy manually.",
                      );
                    }
                  }}
                  disabled={!configPayload || isExportingSlim}
                  className="w-full sm:w-auto"
                >
                  {configCopied ? "Copied" : "Copy String"}
                </Button>
              ) : (
                <Button
                  onClick={handleImportSlimText}
                  disabled={isImportingSlim}
                  className="w-full sm:w-auto"
                >
                  {isImportingSlim ? (
                    <span className="flex items-center gap-2 justify-center">
                      <Spinner className="h-4 w-4" />
                      <span>Importing...</span>
                    </span>
                  ) : (
                    "Import Missing Accounts"
                  )}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Add Account Modal */}
        <AddAccountModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onImportFile={importFromFile}
          onStartOAuth={startOAuthLogin}
          onCompleteOAuth={completeOAuthLogin}
          onCancelOAuth={cancelOAuthLogin}
        />

        <UpdateChecker />
      </div>
    </TooltipProvider>
  );
}

export default App;
