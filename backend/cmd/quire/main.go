// Command quire serves a Markdown notes vault over HTTP.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // formulas use the reader's time zone, even in a bare container

	"github.com/oddomens/quire/internal/backup"
	"github.com/oddomens/quire/internal/server"
	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
	"github.com/oddomens/quire/internal/webui"
)

var version = "dev"

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			os.Exit(healthcheck())
		case "reset-account":
			if err := resetAccount(env("QUIRE_DATA_DIR", "./data"), os.Stdout); err != nil {
				fmt.Fprintln(os.Stderr, "quire:", err)
				os.Exit(1)
			}
			return
		}
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "quire:", err)
		os.Exit(1)
	}
}

func run() error {
	level := slog.LevelInfo
	if strings.EqualFold(env("QUIRE_LOG_LEVEL", "info"), "debug") {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	listen := env("QUIRE_LISTEN", ":8080")
	// A second address that serves only public forms, if set.
	publicListen := env("QUIRE_PUBLIC_LISTEN", "")
	notesDir := env("QUIRE_NOTES_DIR", "./notes")
	dataDir := env("QUIRE_DATA_DIR", "./data")
	interval, err := time.ParseDuration(env("QUIRE_SCAN_INTERVAL", "10s"))
	if err != nil || interval < time.Second {
		return fmt.Errorf("QUIRE_SCAN_INTERVAL must be a duration of at least 1s, like 10s")
	}
	retention, err := strconv.Atoi(env("QUIRE_TRASH_DAYS", "30"))
	if err != nil || retention < 1 {
		return fmt.Errorf("QUIRE_TRASH_DAYS must be a whole number of days")
	}
	var proxies []netip.Prefix
	for _, c := range strings.FieldsFunc(os.Getenv("QUIRE_TRUSTED_PROXIES"), func(r rune) bool { return r == ',' || r == ' ' }) {
		p, err := netip.ParsePrefix(c)
		if err != nil {
			return fmt.Errorf("QUIRE_TRUSTED_PROXIES: %q isn't a CIDR range like 10.0.0.0/8", c)
		}
		proxies = append(proxies, p)
	}
	cfg := server.Config{
		ScanInterval:   interval,
		Version:        version,
		TrustedProxies: proxies,
		TrashRetention: time.Duration(retention) * 24 * time.Hour,
		// The data folder is writable even with a read-only root file system.
		TempDir: dataDir,
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	// Hold the data folder for as long as the server runs, so reset-account
	// and a second server started by mistake can tell it's in use.
	release, err := lockDataDir(dataDir)
	switch {
	case errors.Is(err, errDataDirInUse):
		return fmt.Errorf("another Quire is already using the data folder %s", dataDir)
	case err != nil:
		log.Warn("can't lock the data folder; reset-account won't be able to tell that Quire is running", "err", err)
	default:
		defer release()
	}
	v, err := vault.Open(notesDir)
	if err != nil {
		return fmt.Errorf("open notes folder: %w", err)
	}
	defer v.Close()
	st, err := store.Open(filepath.Join(dataDir, "quire.db"))
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()
	_ = os.Chmod(filepath.Join(dataDir, "quire.db"), 0o600)
	if err := st.Check(); err != nil {
		log.Error("the database failed its integrity check; restore data/quire.db from a backup (pages are safe as .md files)", "err", err)
	}

	bk, err := backup.New(dataDir, version, v, st, log)
	if err != nil {
		return fmt.Errorf("backups: %w", err)
	}
	srv := server.New(cfg, v, st, bk, webui.FS(), log)
	if err := srv.Seed(); err != nil {
		log.Warn("write starter pages", "err", err)
	}
	start := time.Now()
	changed, err := srv.Scan()
	if err != nil {
		return fmt.Errorf("index pages: %w", err)
	}
	log.Info("indexed vault", "dir", notesDir, "updated", len(changed), "took", time.Since(start).Round(time.Millisecond))

	// First run: create the account from QUIRE_PASSWORD if given, otherwise
	// print a one-time code for the setup screen.
	if made, err := srv.Bootstrap(env("QUIRE_NAME", "Owner"), os.Getenv("QUIRE_PASSWORD")); err != nil {
		return fmt.Errorf("create account: %w", err)
	} else if made {
		log.Info("account created from QUIRE_PASSWORD; you can remove it from the environment now")
	}
	if code, err := srv.SetupCode(); err != nil {
		return err
	} else if code != "" {
		log.Warn("Quire isn't set up yet. Open it in a browser and enter this setup code", "code", code)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.Watch(ctx)
	go bk.Schedule(ctx)

	hs := &http.Server{
		Addr:              listen,
		Handler:           srv.Handler(),
		ReadTimeout:       2 * time.Minute,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errc := make(chan error, 2)
	go func() { errc <- hs.ListenAndServe() }()
	log.Info("quire listening", "addr", listen, "version", version)
	var ps *http.Server
	if publicListen != "" {
		ps = &http.Server{
			Addr:              publicListen,
			Handler:           srv.PublicHandler(),
			ReadTimeout:       30 * time.Second,
			ReadHeaderTimeout: 10 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    32 << 10,
		}
		go func() { errc <- ps.ListenAndServe() }()
		log.Info("public forms listening", "addr", publicListen)
	}

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if ps != nil {
		_ = ps.Shutdown(shutdown)
	}
	return hs.Shutdown(shutdown)
}

func healthcheck() int {
	addr := env("QUIRE_LISTEN", ":8080")
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 3 * time.Second}
	res, err := c.Get("http://" + addr + "/api/health")
	if err != nil {
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
