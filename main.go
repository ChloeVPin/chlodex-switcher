package main

import (
	"embed"
	"fmt"
	"io/ioutil"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:dist
var assets embed.FS

//go:embed dist-electron/lan.js
var lanServerJS string

//go:embed build/appicon.png
var appIconBytes []byte

var bunCmd *exec.Cmd

func getFreePort() (int, error) {
	addr, err := net.ResolveTCPAddr("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	l, err := net.ListenTCP("tcp", addr)
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func main() {
	// If this is the launcher build running on a 64-bit or ARM64 Windows host,
	// hand off to the matching native payload and exit.
	if maybeLaunchNativePayload() {
		return
	}

	// 1. Check for Bun runtime in system PATH
	_, err := exec.LookPath("bun")
	if err != nil {
		fmt.Println("Error: Bun is not installed in the system PATH. Please install Bun.")
		os.Exit(1)
	}

	// 2. Find a free port
	port, err := getFreePort()
	if err != nil {
		port = 3211 // Fallback
	}

	// 3. Write embedded lan.js to a temporary file
	tempDir := os.TempDir()
	tempJSFile := filepath.Join(tempDir, "codex-switcher-lan.js")
	err = ioutil.WriteFile(tempJSFile, []byte(lanServerJS), 0600)
	if err != nil {
		fmt.Printf("Error writing temp JS server file: %v\n", err)
		os.Exit(1)
	}
	defer os.Remove(tempJSFile)

	// 4. Start Bun background process
	bunCmd = exec.Command("bun", tempJSFile)
	// Hide command prompt console window on Windows
	bunCmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	bunCmd.Env = append(os.Environ(),
		fmt.Sprintf("CODEX_SWITCHER_WEB_PORT=%d", port),
		fmt.Sprintf("CODEX_SWITCHER_WEB_HOST=127.0.0.1"),
	)

	err = bunCmd.Start()
	if err != nil {
		fmt.Printf("Error starting Bun backend server: %v\n", err)
		os.Exit(1)
	}

	// Make sure we kill Bun on exit
	defer func() {
		if bunCmd != nil && bunCmd.Process != nil {
			_ = bunCmd.Process.Kill()
		}
	}()

	// 5. Wait for the server to be healthy
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/api/health", port)
	client := http.Client{Timeout: 500 * time.Millisecond}
	serverReady := false
	for i := 0; i < 30; i++ {
		resp, err := client.Get(healthURL)
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			serverReady = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	if !serverReady {
		fmt.Println("Error: Bun backend server failed to start or respond to health check.")
		os.Exit(1)
	}

	// 6. Create app instance
	app := NewApp(port)

	// 7. Setup system tray in a background goroutine
	go setupTray(app)

	// 8. Run Wails
	err = wails.Run(&options.App{
		Title:             "Codex Switcher",
		Width:             900,
		Height:            700,
		MinWidth:          600,
		MinHeight:         500,
		Frameless:         true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour:  &options.RGBA{R: 18, G: 18, B: 22, A: 255}, // Matches app's dark sleek theme
		OnStartup:         app.startup,
		OnShutdown:        app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		fmt.Printf("Error running Wails application: %v\n", err)
		os.Exit(1)
	}
}
