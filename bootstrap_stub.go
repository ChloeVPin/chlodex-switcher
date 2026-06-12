//go:build !windows

package main

func maybeLaunchNativePayload() bool {
	return false
}
