import { useState } from "react";
import { Check, FileJson, LogIn, ExternalLink, Copy, Upload } from "lucide-react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { Badge } from "./ui/badge";

interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

type Tab = "oauth" | "import";

export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const isPrimaryDisabled = loading || (activeTab === "oauth" && oauthPending);
  const tauriRuntime = isTauriRuntime();

  const resetForm = () => {
    setName("");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
  };

  const handleClose = () => {
    if (oauthPending) {
      onCancelOAuth();
    }
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const info = await onStartOAuth(name.trim());
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);
 
      // Wait for completion
      await onCompleteOAuth();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!name.trim()) {
      setError("Please enter an account name");
      return;
    }
    if (!fileSource) {
      setError("Please select an auth.json file");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="sm:max-w-xl gap-0 overflow-hidden border-border/70 bg-card p-0 shadow-xl shadow-black/10 dark:shadow-black/35" showCloseButton={true}>
        <DialogHeader className="px-6 pb-3 pt-5 text-left">
          <DialogTitle className="text-base font-semibold text-foreground">
            Add account
          </DialogTitle>
          <DialogDescription className="max-w-md text-sm">
            Connect a ChatGPT account or import an existing Codex credential file.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 px-6 py-3">
          {(["oauth", "import"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab === "import" && oauthPending) {
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab(tab);
                setError(null);
              }}
              className={`flex min-h-16 items-start gap-3 rounded-lg border px-3 py-3 text-left text-sm transition-all ${
                activeTab === tab
                  ? "border-border/80 bg-muted/45 text-foreground"
                  : "border-transparent bg-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground"
              }`}
            >
              <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border ${
                activeTab === tab ? "bg-background text-foreground" : "bg-muted/30"
              }`}>
                {tab === "oauth" ? <LogIn className="size-4" /> : <FileJson className="size-4" />}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">
                  {tab === "oauth" ? "ChatGPT login" : "Import file"}
                </span>
                <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                  {tab === "oauth" ? "Use browser authentication." : "Use an auth.json file."}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="space-y-2">
            <Label htmlFor="account-name" className="text-sm font-medium">
              Account name
            </Label>
            <Input
              id="account-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Work, Personal, Client"
              className="bg-background"
            />
          </div>

          {activeTab === "oauth" && (
            <div className="rounded-lg bg-muted/20 p-4 text-sm text-muted-foreground">
              {oauthPending ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background">
                      <Spinner className="size-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Waiting for browser login</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Open the generated link, finish sign-in, then return here.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg bg-background p-2">
                    <Input
                      readOnly
                      value={authUrl}
                      className="h-8 flex-1 border-0 bg-transparent px-1 font-mono text-xs text-muted-foreground shadow-none focus-visible:ring-0"
                    />
                    <Button
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(authUrl)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          })
                          .catch(() => {
                            setError("Clipboard unavailable. Copy the link manually.");
                          });
                      }}
                      variant="outline"
                      size="icon-sm"
                      className={`shrink-0 ${
                        copied
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                          : ""
                      }`}
                      title={copied ? "Copied" : "Copy link"}
                    >
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                    <Button
                      onClick={() => {
                        void openExternalUrl(authUrl);
                      }}
                      variant="default"
                      size="sm"
                      className="shrink-0"
                    >
                      <ExternalLink className="size-4" />
                      Open
                    </Button>
                  </div>
                  {!tauriRuntime && (
                    <p className="rounded-md bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                      OAuth login must finish on the same host machine because the callback
                      redirects to `localhost`.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
                    <LogIn className="size-4" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground">Browser-based authentication</p>
                    <p className="mt-1 text-xs leading-5">
                      Generate a sign-in link and complete authentication in your browser.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "import" && (
            <div className="space-y-3 rounded-lg bg-muted/20 p-4">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
                  <FileJson className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <Label className="text-sm font-medium">
                    Auth file
                  </Label>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Import credentials from an existing Codex auth.json file.
                  </p>
                </div>
                {fileSource && (
                  <Badge variant="outline" className="rounded-md border-border/70 bg-muted/30 text-muted-foreground">
                    Selected
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex min-h-9 flex-1 items-center truncate rounded-md bg-background px-3 py-2 text-sm text-muted-foreground">
                  {describeFileSource(fileSource)}
                </div>
                <Button
                  onClick={handleSelectFile}
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  <Upload className="size-4" />
                  Browse
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive dark:bg-destructive/20">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 bg-muted/15 px-6 py-4">
          <Button
            onClick={handleClose}
            variant="ghost"
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={activeTab === "oauth" ? handleOAuthLogin : handleImportFile}
            disabled={isPrimaryDisabled}
            className="w-full sm:w-auto min-w-[120px]"
          >
            {loading ? (
              <span className="flex items-center gap-2 justify-center">
                <Spinner className="h-4 w-4" />
                <span>Processing</span>
              </span>
            ) : activeTab === "oauth" ? (
              "Generate Login"
            ) : (
              "Import"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
