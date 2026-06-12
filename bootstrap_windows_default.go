//go:build windows && !launcher

package main

func maybeLaunchNativePayload() bool {
	return false
}
