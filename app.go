package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx  context.Context
	port int
}

func NewApp(port int) *App {
	return &App{port: port}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(ctx context.Context) {
	if bunCmd != nil && bunCmd.Process != nil {
		_ = bunCmd.Process.Kill()
	}
}

// Invoke routes calls from frontend to local Bun backend server
func (a *App) Invoke(command string, payload map[string]interface{}) (interface{}, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/api/invoke/%s", a.port, command)
	
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		var errData map[string]interface{}
		if json.Unmarshal(respBody, &errData) == nil {
			if errMsg, ok := errData["error"].(string); ok {
				return nil, fmt.Errorf("%s", errMsg)
			}
		}
		return nil, fmt.Errorf("backend returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result interface{}
	if len(respBody) > 0 {
		err = json.Unmarshal(respBody, &result)
		if err != nil {
			return nil, err
		}
	}

	return result, nil
}

// Native Window Controls
func (a *App) WindowMinimize() {
	runtime.WindowMinimise(a.ctx)
}

func (a *App) WindowToggleMaximize() {
	runtime.WindowToggleMaximise(a.ctx)
}

func (a *App) WindowIsMaximized() bool {
	return runtime.WindowIsMaximised(a.ctx)
}

func (a *App) WindowClose() {
	runtime.WindowHide(a.ctx) // Hides to tray instead of quitting
}

func (a *App) BrowserOpenURL(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}

// Native Dialogs
func (a *App) ShowOpenDialog(title string, filters []interface{}) (string, error) {
	var openFilters []runtime.FileFilter
	for _, filterVal := range filters {
		filterMap, ok := filterVal.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := filterMap["name"].(string)
		extensions, ok := filterMap["extensions"].([]interface{})
		if !ok {
			continue
		}
		var patterns []string
		for _, ext := range extensions {
			if extStr, ok := ext.(string); ok {
				patterns = append(patterns, "*."+extStr)
			}
		}
		openFilters = append(openFilters, runtime.FileFilter{
			DisplayName: name,
			Pattern:     strings.Join(patterns, ";"),
		})
	}

	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   title,
		Filters: openFilters,
	})
}

func (a *App) ShowSaveDialog(title string, defaultPath string, filters []interface{}) (string, error) {
	var saveFilters []runtime.FileFilter
	for _, filterVal := range filters {
		filterMap, ok := filterVal.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := filterMap["name"].(string)
		extensions, ok := filterMap["extensions"].([]interface{})
		if !ok {
			continue
		}
		var patterns []string
		for _, ext := range extensions {
			if extStr, ok := ext.(string); ok {
				patterns = append(patterns, "*."+extStr)
			}
		}
		saveFilters = append(saveFilters, runtime.FileFilter{
			DisplayName: name,
			Pattern:     strings.Join(patterns, ";"),
		})
	}

	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           title,
		DefaultFilename: defaultPath,
		Filters:         saveFilters,
	})
}
