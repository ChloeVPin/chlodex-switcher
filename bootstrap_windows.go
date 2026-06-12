//go:build windows && launcher

package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

const launcherBootstrapEnv = "CODEX_SWITCHER_BOOTSTRAPPED"

//go:embed build/bootstrap/payloads/codex-switcher-windows-amd64.exe build/bootstrap/payloads/codex-switcher-windows-arm64.exe
var launcherPayloads embed.FS

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var procGetNativeSystemInfo = kernel32.NewProc("GetNativeSystemInfo")

type systemInfo struct {
	processorArchitecture uint16
	reserved              uint16
	pageSize              uint32
	minApplicationAddress uintptr
	maxApplicationAddress uintptr
	activeProcessorMask   uintptr
	numberOfProcessors    uint32
	processorType         uint32
	allocationGranularity uint32
	processorLevel        uint16
	processorRevision     uint16
}

func maybeLaunchNativePayload() bool {
	if os.Getenv(launcherBootstrapEnv) == "1" {
		return false
	}

	hostArch := getNativeWindowsArch()
	if hostArch == "386" {
		return false
	}

	payloadName := map[string]string{
		"amd64": "build/bootstrap/payloads/codex-switcher-windows-amd64.exe",
		"arm64": "build/bootstrap/payloads/codex-switcher-windows-arm64.exe",
	}[hostArch]
	if payloadName == "" {
		return false
	}

	payload, err := launcherPayloads.ReadFile(payloadName)
	if err != nil {
		fmt.Printf("Launcher payload unavailable for %s: %v\n", hostArch, err)
		return false
	}

	cachePath, err := cachedPayloadPath(hostArch, payload)
	if err != nil {
		fmt.Printf("Launcher cache path error: %v\n", err)
		return false
	}

	if err := ensureCachedPayload(cachePath, payload); err != nil {
		fmt.Printf("Launcher payload cache error: %v\n", err)
		return false
	}

	cmd := exec.Command(cachePath, os.Args[1:]...)
	if cwd, err := os.Getwd(); err == nil {
		cmd.Dir = cwd
	}
	cmd.Env = append(os.Environ(), launcherBootstrapEnv+"=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}

	if err := cmd.Start(); err != nil {
		fmt.Printf("Launcher handoff failed: %v\n", err)
		return false
	}

	os.Exit(0)
	return true
}

func getNativeWindowsArch() string {
	var info systemInfo
	_, _, _ = procGetNativeSystemInfo.Call(uintptr(unsafe.Pointer(&info)))

	switch info.processorArchitecture {
	case 9:
		return "amd64"
	case 12:
		return "arm64"
	default:
		return "386"
	}
}

func cachedPayloadPath(arch string, payload []byte) (string, error) {
	cacheRoot, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:8])
	dir := filepath.Join(cacheRoot, "Codex Switcher", "launcher-payloads", arch, hash)
	return filepath.Join(dir, "codex-switcher.exe"), nil
}

func ensureCachedPayload(path string, payload []byte) error {
	if info, err := os.Stat(path); err == nil && info.Size() == int64(len(payload)) {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, payload, 0o700)
}
