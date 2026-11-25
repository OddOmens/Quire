//go:build unix

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// lockDataDir takes an exclusive lock on quire.lock in the data folder and
// holds it until release. The server holds it while it runs, so
// reset-account (and a second server) can tell the folder is in use. The
// kernel drops the lock when the process exits, so a crash never leaves it
// stuck. It returns errDataDirInUse if another process holds it, or another
// error if the file system can't lock at all.
func lockDataDir(dir string) (release func(), err error) {
	f, err := os.OpenFile(filepath.Join(dir, "quire.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errDataDirInUse
		}
		return nil, err
	}
	return func() { f.Close() }, nil
}
