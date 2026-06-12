import { useState, useRef, useEffect } from "react";
import type { AccountWithUsage } from "../types";
import { UsageBar } from "./UsageBar";
import { Zap, RefreshCw, Trash2, Eye, EyeOff, Check, MoreVertical, Edit2 } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
  switching?: boolean;
  switchDisabled?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
  onToggleMask?: () => void;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
}

function formatLastRefresh(date: Date | null): string {
  if (!date) return "Never";
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString();
}

function getSubscriptionStatus(timestamp: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!timestamp) {
    return {
      label: "Expiry unavailable",
      className: "text-muted-foreground",
    };
  }

  const expiryDate = new Date(timestamp);
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  const remainingMs = expiryDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return {
      label: `Expired ${formattedDate}`,
      className: "text-destructive dark:text-red-400",
    };
  }

  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-destructive dark:text-red-400",
    };
  }

  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      label: `Until ${formattedDate}`,
      className: "text-amber-500 dark:text-amber-400",
    };
  }

  return {
    label: `Until ${formattedDate}`,
    className: "text-muted-foreground",
  };
}

function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span
      className={`transition-all duration-200 select-none ${blur ? "blur-sm" : ""}`}
      style={blur ? { userSelect: "none" } : undefined}
    >
      {children}
    </span>
  );
}

export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onDelete,
  onRefresh,
  onRename,
  switching,
  switchDisabled,
  warmingUp,
  masked = false,
  onToggleMask,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage && !account.usage.error ? new Date() : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
      setLastRefresh(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const planDisplay = account.plan_type
    ? account.plan_type.charAt(0).toUpperCase() + account.plan_type.slice(1)
    : account.auth_mode === "api_key"
      ? "API Key"
      : "Unknown";

  const planColors: Record<string, string> = {
    pro: "bg-muted/35 text-muted-foreground border-border/70",
    plus: "bg-muted/35 text-muted-foreground border-border/70",
    team: "bg-muted/35 text-muted-foreground border-border/70",
    enterprise: "bg-muted/35 text-muted-foreground border-border/70",
    free: "bg-muted text-muted-foreground border-border",
    api_key: "bg-muted/35 text-muted-foreground border-border/70",
  };

  const planKey = account.plan_type?.toLowerCase() || "api_key";
  const planColorClass = planColors[planKey] || planColors.free;
  const showSubscriptionStatus = account.auth_mode === "chat_g_p_t";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);

  return (
    <Card
      className={`relative p-5 transition-all duration-200 flex flex-col justify-between ${
        account.is_active
          ? "bg-card border-border/80 shadow-none"
          : "bg-card border-border/60 hover:border-border"
      }`}
    >
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-2">
          {/* Left Side: Name & Email */}
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRename}
                onKeyDown={handleKeyDown}
                className="font-semibold text-sm text-foreground bg-muted px-2 py-0.5 rounded border border-border focus:outline-none focus:border-ring w-full"
              />
            ) : (
              <h3
                className="font-semibold text-sm text-foreground truncate cursor-pointer hover:text-muted-foreground"
                onClick={() => {
                  if (masked) return;
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                title={masked ? undefined : "Click to rename"}
              >
                <BlurredText blur={masked}>{account.name}</BlurredText>
              </h3>
            )}
            {account.email && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                <BlurredText blur={masked}>{account.email}</BlurredText>
              </p>
            )}
          </div>

          {/* Right Side: Badges */}
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            {showSubscriptionStatus && (
              <span className={`text-[10px] font-medium shrink-0 ${subscriptionStatus.className}`}>
                {subscriptionStatus.label}
              </span>
            )}
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 shrink-0 ${planColorClass}`}>
              {planDisplay}
            </Badge>
            {account.is_active && (
              <Badge variant="outline" className="gap-1 bg-muted/35 text-muted-foreground border-border/70 text-[10px] px-1.5 py-0.5 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground"></span>
                Active
              </Badge>
            )}
          </div>
        </div>

        {/* Usage */}
        <div className="my-4">
          <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
        </div>
      </div>

      {/* Footer / Actions */}
      <div className="flex items-center justify-between gap-4 mt-1 pt-3">
        <div>
          {account.is_active ? (
            <div className="text-[10px] text-muted-foreground">
              Updated {formatLastRefresh(lastRefresh)}
            </div>
          ) : (
            <Button
              onClick={onSwitch}
              disabled={switching || switchDisabled}
              variant={switchDisabled ? "outline" : "default"}
              size="sm"
              className="text-xs py-1 h-8 px-3 font-medium transition-all"
              title={switchDisabled ? "Close all Codex processes first" : undefined}
            >
              {switching ? "Switching..." : switchDisabled ? "Codex Running" : "Switch"}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            onClick={handleRefresh}
            disabled={isRefreshing}
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground size-8"
            title="Refresh usage"
          >
            <RefreshCw strokeWidth={2.5} className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>

          <Button
            onClick={() => {
              void onWarmup();
            }}
            disabled={warmingUp}
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-amber-500 dark:hover:text-amber-400 size-8"
            title={warmingUp ? "Sending warm-up..." : "Send minimal warm-up request"}
          >
            <Zap strokeWidth={2.5} className={`size-3.5 ${warmingUp ? "animate-pulse" : ""}`} />
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground size-8"
                title="More options"
              >
                <MoreVertical strokeWidth={2.5} className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-44">
              {onToggleAutoWarmup && (
                <DropdownMenuItem
                  onClick={() => {
                    onToggleAutoWarmup();
                  }}
                  disabled={autoWarmupManagedByAll}
                  className="flex items-center gap-2"
                >
                  <span className="w-4 h-4 flex items-center justify-center shrink-0">
                    {autoWarmupEnabled ? (
                      <Check strokeWidth={2.5} size={14} className="text-emerald-500" />
                    ) : null}
                  </span>
                  <span>{autoWarmupLabel ?? "Auto Warm-Up"}</span>
                </DropdownMenuItem>
              )}
              
              {onToggleMask && (
                <DropdownMenuItem
                  onClick={() => {
                    onToggleMask();
                  }}
                  className="flex items-center gap-2"
                >
                  <span className="w-4 h-4 flex items-center justify-center shrink-0">
                    {masked ? <EyeOff strokeWidth={2.5} size={14} /> : <Eye strokeWidth={2.5} size={14} />}
                  </span>
                  <span>{masked ? "Show Credentials" : "Hide Credentials"}</span>
                </DropdownMenuItem>
              )}

              <DropdownMenuItem
                onClick={() => {
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                className="flex items-center gap-2"
              >
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <Edit2 strokeWidth={2.5} size={14} />
                </span>
                <span>Rename Account</span>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onClick={() => {
                  onDelete();
                }}
                variant="destructive"
                className="flex items-center gap-2"
              >
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <Trash2 strokeWidth={2.5} size={14} />
                </span>
                <span>Delete Account</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Card>
  );
}
