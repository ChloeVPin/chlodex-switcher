package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/getlantern/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type StoredAccount struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type AccountsStore struct {
	Version         int             `json:"version"`
	Accounts        []StoredAccount `json:"accounts"`
	ActiveAccountID string          `json:"active_account_id"`
}

var (
	noAccountsItem *systray.MenuItem
	menuItemPool   []*systray.MenuItem
	poolMutex      sync.Mutex
	activeAccounts []StoredAccount
	activeAccountID string
)

func setupTray(app *App) {
	systray.Run(func() {
		onReady(app)
	}, onExit)
}

func getAccountsFilePath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".codex-switcher", "accounts.json"), nil
}

func onReady(app *App) {
	// Set embedded icon bytes
	systray.SetIcon(appIconBytes)
	systray.SetTooltip("Codex Switcher")

	// Create dynamic item pool (up to 30 accounts)
	noAccountsItem = systray.AddMenuItem("No accounts configured", "")
	noAccountsItem.Disable()

	for i := 0; i < 30; i++ {
		item := systray.AddMenuItem("", "")
		item.Hide()
		menuItemPool = append(menuItemPool, item)

		// Click listener for each pool item
		go func(index int, mItem *systray.MenuItem) {
			for range mItem.ClickedCh {
				handleAccountClick(index, app)
			}
		}(i, item)
	}

	systray.AddSeparator()

	openItem := systray.AddMenuItem("Open Codex Switcher", "Show the main window")
	quitItem := systray.AddMenuItem("Quit", "Exit the application")

	// Action listeners
	go func() {
		for {
			select {
			case <-openItem.ClickedCh:
				runtime.WindowShow(app.ctx)
			case <-quitItem.ClickedCh:
				systray.Quit()
				runtime.Quit(app.ctx)
			}
		}
	}()

	// Initial load
	refreshMenu(app)

	// File watcher polling loop (1s interval)
	go func() {
		var lastMtime int64
		accountsFile, err := getAccountsFilePath()
		if err == nil {
			if info, err := os.Stat(accountsFile); err == nil {
				lastMtime = info.ModTime().UnixNano()
			}
		}

		for {
			time.Sleep(1 * time.Second)
			if accountsFile == "" {
				continue
			}
			info, err := os.Stat(accountsFile)
			if err != nil {
				continue
			}
			mtime := info.ModTime().UnixNano()
			if mtime != lastMtime {
				lastMtime = mtime
				refreshMenu(app)
			}
		}
	}()
}

func refreshMenu(app *App) {
	poolMutex.Lock()
	defer poolMutex.Unlock()

	accountsFile, err := getAccountsFilePath()
	if err != nil {
		return
	}

	if _, err := os.Stat(accountsFile); os.IsNotExist(err) {
		noAccountsItem.Show()
		noAccountsItem.SetTitle("No accounts configured")
		for _, item := range menuItemPool {
			item.Hide()
		}
		return
	}

	data, err := ioutil.ReadFile(accountsFile)
	if err != nil {
		return
	}

	var store AccountsStore
	if err := json.Unmarshal(data, &store); err != nil {
		return
	}

	activeAccounts = store.Accounts
	activeAccountID = store.ActiveAccountID

	if len(store.Accounts) == 0 {
		noAccountsItem.Show()
		noAccountsItem.SetTitle("No accounts configured")
		for _, item := range menuItemPool {
			item.Hide()
		}
	} else {
		noAccountsItem.Hide()
		for i, account := range store.Accounts {
			if i < len(menuItemPool) {
				menuItemPool[i].Show()
				menuItemPool[i].SetTitle(account.Name)
				if account.ID == store.ActiveAccountID {
					menuItemPool[i].Check()
				} else {
					menuItemPool[i].Uncheck()
				}
			}
		}
		for i := len(store.Accounts); i < len(menuItemPool); i++ {
			menuItemPool[i].Hide()
		}
	}
}

func handleAccountClick(index int, app *App) {
	poolMutex.Lock()
	if index >= len(activeAccounts) {
		poolMutex.Unlock()
		return
	}
	account := activeAccounts[index]
	isActive := account.ID == activeAccountID
	poolMutex.Unlock()

	if isActive {
		return
	}

	// 1. Check for running Codex processes
	res, err := app.Invoke("check_codex_processes", nil)
	if err != nil {
		fmt.Printf("Error checking processes: %v\n", err)
		return
	}

	resMap, ok := res.(map[string]interface{})
	if ok {
		countVal, hasCount := resMap["count"]
		if hasCount {
			var count float64
			if cFloat, ok := countVal.(float64); ok {
				count = cFloat
			}
			if count > 0 {
				// blocked
				runtime.EventsEmit(app.ctx, "switch-account-blocked", map[string]interface{}{
					"accountId": account.ID,
					"error":     fmt.Sprintf("Cannot switch accounts while %.0f Codex process%s running", count, getPluralSuffix(count)),
				})
				runtime.WindowShow(app.ctx)
				refreshMenu(app)
				return
			}
		}
	}

	// 2. Perform switch
	_, err = app.Invoke("switch_account", map[string]interface{}{
		"accountId": account.ID,
	})
	if err != nil {
		fmt.Printf("Error switching account: %v\n", err)
		return
	}

	runtime.EventsEmit(app.ctx, "accounts-changed")
	refreshMenu(app)
}

func getPluralSuffix(count float64) string {
	if count == 1 {
		return " is"
	}
	return "es are"
}

func onExit() {
	// Cleanup on exit
}
