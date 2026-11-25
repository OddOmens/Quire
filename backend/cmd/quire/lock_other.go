//go:build !unix

package main

import "errors"

// lockDataDir can't lock on this platform; Quire's images are Linux only.
func lockDataDir(string) (func(), error) {
	return nil, errors.New("locking isn't supported on this platform")
}
