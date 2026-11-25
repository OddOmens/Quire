// Package backup copies the vault and a database snapshot to a Coffer server
// over WebDAV. Point it at a folder on an encrypted Coffer drive (or one a
// Coffer backup sends to an encrypted drive) and Coffer encrypts everything
// before it reaches the bucket.
//
// Remote layout, under the chosen folder:
//
//	notes/…        the vault, file for file
//	deleted/<day>/… files that left the vault, kept for 30 days
//	quire.db       the database: account, page history, share links
//	backup.json    what this is and when it was made
package backup

import (
	"cmp"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/oddomens/quire/internal/store"
	"github.com/oddomens/quire/internal/vault"
)

type Config struct {
	// URL is Coffer's address, e.g. https://coffer.example or http://10.0.0.5:8180.
	URL      string `json:"url"`
	Username string `json:"username"`
	// Folder is a path under Coffer's WebDAV root: a place, then folders.
	Folder string `json:"folder"`
	// Hours between automatic runs; 0 means only when asked.
	Hours int `json:"hours"`
	// Password is the Coffer app password, sealed with the local key on disk.
	Password string `json:"-"`
	Sealed   string `json:"password,omitempty"`
}

type Status struct {
	Running     bool   `json:"running"`
	LastRun     int64  `json:"lastRun"`
	LastSuccess int64  `json:"lastSuccess"`
	LastError   string `json:"lastError"`
	Files       int    `json:"files"`
	Uploaded    int    `json:"uploaded"`
	Deleted     int    `json:"deleted"`
	Bytes       int64  `json:"bytes"`
	// NeedsPassword means the saved Coffer app password couldn't be
	// unsealed (secret.key lost or replaced), so backups are paused until
	// it's entered again.
	NeedsPassword bool `json:"needsPassword,omitempty"`
	// HeldDeletes is how many removals the last run held back because
	// there were too many at once (see largeLoss); 0 when none were.
	HeldDeletes int `json:"heldDeletes,omitempty"`
}

type fileStamp struct {
	Size  int64 `json:"size"`
	Mtime int64 `json:"mtime"`
}

// state remembers what's already on the server, so each run sends changes only.
type state struct {
	Target string               `json:"target"`
	Files  map[string]fileStamp `json:"files"`
	DBHash string               `json:"dbHash"`
	Status Status               `json:"status"`
}

type Manager struct {
	dataDir string
	version string
	vault   *vault.Vault
	store   *store.Store
	log     *slog.Logger
	client  *http.Client

	mu      sync.Mutex
	cfg     *Config
	st      state
	running bool
	// locked is set when backup.json's app password couldn't be unsealed.
	// The settings are kept; backups wait until the password is saved again.
	locked bool
	// allowLoss lets the next run make a large deletion; it's used up by
	// that run.
	allowLoss bool
	now       func() time.Time
}

// errLocked is returned while the app password needs entering again.
var errLocked = errors.New("Quire can't unlock the saved Coffer app password (was secret.key replaced?). Enter it again in Settings → Backups")

// sameOrigin stops a redirect from leaving the address the backup was set up
// with, so the app password is never resent somewhere else or over plain http.
func sameOrigin(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 || req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host {
		return http.ErrUseLastResponse
	}
	return nil
}

func New(dataDir, version string, v *vault.Vault, st *store.Store, log *slog.Logger) (*Manager, error) {
	m := &Manager{dataDir: dataDir, version: version, vault: v, store: st, log: log,
		client: &http.Client{Timeout: 15 * time.Minute, CheckRedirect: sameOrigin}, now: time.Now}
	if err := m.load(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manager) configFile() string { return filepath.Join(m.dataDir, "backup.json") }
func (m *Manager) stateFile() string  { return filepath.Join(m.dataDir, "backup-state.json") }

func (m *Manager) load() error {
	m.st = state{Files: map[string]fileStamp{}}
	if data, err := os.ReadFile(m.stateFile()); err == nil {
		_ = json.Unmarshal(data, &m.st)
		if m.st.Files == nil {
			m.st.Files = map[string]fileStamp{}
		}
	}
	data, err := os.ReadFile(m.configFile())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return fmt.Errorf("backup.json: %w", err)
	}
	if c.Sealed != "" {
		if c.Password, err = m.open(c.Sealed); err != nil {
			// Not a reason to stop serving pages: keep the settings, pause
			// backups and ask for the app password again.
			c.Password = ""
			m.locked = true
			m.log.Error("backups are paused: can't unseal the saved Coffer app password (was secret.key in the data folder lost or replaced?). Enter the app password again in Settings → Backups", "err", err)
		}
	}
	m.cfg = &c
	return nil
}

// Config returns the saved settings, or nil when backups aren't set up.
func (m *Manager) Config() *Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg == nil {
		return nil
	}
	c := *m.cfg
	return &c
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.st.Status
	s.Running = m.running
	s.NeedsPassword = m.locked
	return s
}

// Validate cleans up settings and refuses unsafe ones: the app password may
// only travel unencrypted to this machine or a private network.
func Validate(c *Config) error {
	c.URL = strings.TrimRight(strings.TrimSpace(c.URL), "/")
	c.Username = strings.TrimSpace(c.Username)
	c.Folder = strings.Trim(strings.TrimSpace(strings.ReplaceAll(c.Folder, `\`, "/")), "/")
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return errors.New("enter Coffer's address, like https://coffer.example.com")
	}
	if u.Scheme == "http" && !privateHost(u.Hostname()) {
		return errors.New("use https for a Coffer outside your network, so the app password isn't sent in the clear")
	}
	if c.Username == "" {
		return errors.New("enter your Coffer username")
	}
	if c.Folder == "" || strings.Contains("/"+c.Folder+"/", "/../") || strings.Contains("/"+c.Folder+"/", "/./") {
		return errors.New("choose a folder in Coffer, like “Backups/Quire”")
	}
	if c.Hours < 0 || c.Hours > 24*7 {
		return errors.New("choose how often to back up")
	}
	return nil
}

func privateHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".ts.net") || !strings.Contains(host, ".") && net.ParseIP(host) == nil {
		return true
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	a = a.Unmap()
	cgnat := netip.MustParsePrefix("100.64.0.0/10") // Tailscale
	return a.IsLoopback() || a.IsPrivate() || cgnat.Contains(a)
}

// Save stores new settings. An empty password keeps the saved one.
func (m *Manager) Save(c Config) error {
	if err := Validate(&c); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.Password == "" && m.cfg != nil {
		c.Password = m.cfg.Password
	}
	if c.Password == "" {
		return errors.New("enter a Coffer app password")
	}
	sealed, err := m.seal(c.Password)
	if err != nil {
		return err
	}
	c.Sealed = sealed
	data, _ := json.MarshalIndent(c, "", "  ")
	if err := writeFile(m.configFile(), data); err != nil {
		return err
	}
	m.cfg = &c
	m.locked = false
	return nil
}

func (m *Manager) Remove() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg = nil
	m.locked = false
	m.allowLoss = false
	m.st = state{Files: map[string]fileStamp{}}
	for _, f := range []string{m.configFile(), m.stateFile()} {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func writeFile(name string, data []byte) error {
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, name)
}

// ── Sealing the app password at rest ──

func (m *Manager) key() ([]byte, error) {
	file := filepath.Join(m.dataDir, "secret.key")
	if k, err := os.ReadFile(file); err == nil && len(k) == 32 {
		return k, nil
	} else if err == nil {
		return nil, errors.New("secret.key in the data folder is damaged (it should be 32 bytes); move it aside and save the backup settings again")
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	_, err = f.Write(k)
	return k, err
}

func (m *Manager) aead() (cipher.AEAD, error) {
	k, err := m.key()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (m *Manager) seal(s string) (string, error) {
	g, err := m.aead()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(g.Seal(nonce, nonce, []byte(s), []byte("quire-backup"))), nil
}

func (m *Manager) open(s string) (string, error) {
	g, err := m.aead()
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) < g.NonceSize() {
		return "", errors.New("bad sealed value")
	}
	out, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], []byte("quire-backup"))
	return string(out), err
}

// ── WebDAV ──

// dav talks to Coffer's WebDAV root, where each place is a top-level folder.
// Paths given to it are relative to the backup folder.
type dav struct {
	c    *http.Client
	cfg  Config
	dirs map[string]bool
}

func newDav(c *http.Client, cfg Config) *dav {
	return &dav{c: c, cfg: cfg, dirs: map[string]bool{}}
}

// full is p's path from the WebDAV root.
func (d *dav) full(p string) string {
	if p == "" {
		return d.cfg.Folder
	}
	return d.cfg.Folder + "/" + p
}

func (d *dav) url(full string) string {
	segs := strings.Split(full, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return d.cfg.URL + "/dav/" + strings.Join(segs, "/")
}

func (d *dav) do(ctx context.Context, method, full string, body io.Reader, size int64, hdr map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.url(full), body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(d.cfg.Username, d.cfg.Password)
	req.Header.Set("User-Agent", "Quire-Backup/1.0")
	if body != nil {
		req.ContentLength = size
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := d.c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("can't reach Coffer: %w", err)
	}
	if res.StatusCode == http.StatusUnauthorized {
		res.Body.Close()
		return nil, errors.New("Coffer refused the username or app password")
	}
	return res, nil
}

func drain(res *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	res.Body.Close()
}

// mkdirs creates p (relative to the backup folder) and every folder above
// it, the backup folder included, skipping ones that exist. The place at the
// top must exist already.
func (d *dav) mkdirs(ctx context.Context, p string) error {
	segs := strings.Split(d.full(p), "/")
	for i := 2; i <= len(segs); i++ {
		dir := strings.Join(segs[:i], "/")
		if d.dirs[dir] {
			continue
		}
		res, err := d.do(ctx, "MKCOL", dir, nil, 0, nil)
		if err != nil {
			return err
		}
		drain(res)
		switch res.StatusCode {
		case http.StatusCreated, http.StatusMethodNotAllowed, http.StatusOK, http.StatusNoContent:
		case http.StatusConflict, http.StatusNotFound:
			return fmt.Errorf("Coffer has no place called “%s”; check the folder", segs[0])
		case http.StatusForbidden:
			return fmt.Errorf("Coffer won't let this account write to “%s”", d.cfg.Folder)
		default:
			return fmt.Errorf("Coffer couldn't create a folder (HTTP %d)", res.StatusCode)
		}
		d.dirs[dir] = true
	}
	return nil
}

func (d *dav) put(ctx context.Context, p string, r io.Reader, size int64) error {
	if dir := path.Dir(p); dir != "." {
		if err := d.mkdirs(ctx, dir); err != nil {
			return err
		}
	}
	res, err := d.do(ctx, http.MethodPut, d.full(p), r, size, map[string]string{"Content-Type": "application/octet-stream"})
	if err != nil {
		return err
	}
	drain(res)
	switch res.StatusCode {
	case http.StatusCreated, http.StatusNoContent, http.StatusOK:
		return nil
	case http.StatusInsufficientStorage, http.StatusRequestEntityTooLarge:
		return errors.New("Coffer is out of space for this upload")
	case http.StatusForbidden:
		return fmt.Errorf("Coffer won't let this account write to “%s”", d.cfg.Folder)
	default:
		return fmt.Errorf("uploading %s failed (HTTP %d)", p, res.StatusCode)
	}
}

func (d *dav) remove(ctx context.Context, p string) error {
	res, err := d.do(ctx, http.MethodDelete, d.full(p), nil, 0, nil)
	if err != nil {
		return err
	}
	drain(res)
	if res.StatusCode >= 300 && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("removing %s failed (HTTP %d)", p, res.StatusCode)
	}
	return nil
}

// move renames from to to on the server, overwriting what's there. A from
// that's already gone counts as moved.
func (d *dav) move(ctx context.Context, from, to string) error {
	if err := d.mkdirs(ctx, path.Dir(to)); err != nil {
		return err
	}
	res, err := d.do(ctx, "MOVE", d.full(from), nil, 0, map[string]string{"Destination": d.url(d.full(to)), "Overwrite": "T"})
	if err != nil {
		return err
	}
	drain(res)
	if res.StatusCode >= 300 && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("moving %s aside failed (HTTP %d)", from, res.StatusCode)
	}
	return nil
}

// list returns the names in folder p, or none if it doesn't exist.
func (d *dav) list(ctx context.Context, p string) ([]string, error) {
	const body = `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`
	res, err := d.do(ctx, "PROPFIND", d.full(p), strings.NewReader(body), int64(len(body)),
		map[string]string{"Depth": "1", "Content-Type": "application/xml"})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode != http.StatusMultiStatus {
		return nil, fmt.Errorf("listing %s failed (HTTP %d)", p, res.StatusCode)
	}
	var ms struct {
		Responses []struct {
			Href string `xml:"href"`
		} `xml:"response"`
	}
	if err := xml.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&ms); err != nil {
		return nil, fmt.Errorf("listing %s: %w", p, err)
	}
	self := path.Base(d.full(p))
	var out []string
	for _, r := range ms.Responses {
		u, err := url.Parse(strings.TrimSpace(r.Href))
		if err != nil {
			continue
		}
		if name := path.Base(strings.TrimRight(u.Path, "/")); name != self && name != "/" && name != "." {
			out = append(out, name)
		}
	}
	return out, nil
}

// Test checks the settings: sign-in works and the folder can be written.
func (m *Manager) Test(ctx context.Context, c Config) error {
	if err := Validate(&c); err != nil {
		return err
	}
	// The saved app password only goes back to the server and account it
	// belongs to; a test against anything else needs its own.
	if c.Password == "" {
		if saved := m.Config(); saved != nil && saved.URL == c.URL && saved.Username == c.Username {
			c.Password = saved.Password
		}
	}
	if c.Password == "" {
		return errors.New("enter the Coffer app password")
	}
	d := newDav(m.client, c)
	if err := d.mkdirs(ctx, ""); err != nil {
		return err
	}
	probe := ".quire-write-test"
	if err := d.put(ctx, probe, strings.NewReader("ok"), 2); err != nil {
		return err
	}
	return d.remove(ctx, probe)
}

// ── Running ──

// Run backs up once. It returns at once with an error if a run is already
// going or nothing is configured; otherwise it runs in the background.
func (m *Manager) Run() error {
	m.mu.Lock()
	if m.cfg == nil {
		m.mu.Unlock()
		return errors.New("set up backups first")
	}
	if m.locked {
		m.mu.Unlock()
		return errLocked
	}
	if m.running {
		m.mu.Unlock()
		return nil
	}
	m.running = true
	cfg := *m.cfg
	m.mu.Unlock()
	go func() {
		err := m.run(context.Background(), cfg)
		m.finish(err)
	}()
	return nil
}

// AllowLargeDelete lets the next run go ahead with a deletion that would
// otherwise be held back as too large, for an owner who really did remove
// that much.
func (m *Manager) AllowLargeDelete() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.allowLoss = true
}

// RunNow backs up and waits; for tests and the CLI.
func (m *Manager) RunNow(ctx context.Context) error {
	m.mu.Lock()
	if m.cfg == nil || m.running {
		m.mu.Unlock()
		return errors.New("not configured, or already running")
	}
	if m.locked {
		m.mu.Unlock()
		return errLocked
	}
	m.running = true
	cfg := *m.cfg
	m.mu.Unlock()
	err := m.run(ctx, cfg)
	m.finish(err)
	return err
}

func (m *Manager) finish(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.running = false
	m.st.Status.LastRun = time.Now().UnixMilli()
	if err != nil {
		m.st.Status.LastError = err.Error()
		m.log.Warn("backup to Coffer failed", "err", err)
	} else {
		m.st.Status.LastError = ""
		m.st.Status.LastSuccess = m.st.Status.LastRun
		m.log.Info("backed up to Coffer", "uploaded", m.st.Status.Uploaded, "deleted", m.st.Status.Deleted, "files", m.st.Status.Files)
	}
	m.saveState()
}

func (m *Manager) saveState() {
	data, _ := json.Marshal(m.st)
	if err := writeFile(m.stateFile(), data); err != nil {
		m.log.Warn("save backup state", "err", err)
	}
}

func (m *Manager) run(ctx context.Context, cfg Config) error {
	d := newDav(m.client, cfg)
	target := cfg.URL + "|" + cfg.Username + "|" + cfg.Folder

	m.mu.Lock()
	if m.st.Target != target {
		// A new destination starts from nothing.
		m.st.Target, m.st.Files, m.st.DBHash = target, map[string]fileStamp{}, ""
	}
	sent := m.st.Files
	m.st.Status.Uploaded, m.st.Status.Deleted, m.st.Status.Bytes, m.st.Status.HeldDeletes = 0, 0, 0, 0
	allowLoss := m.allowLoss
	m.allowLoss = false
	m.mu.Unlock()

	files, err := m.vault.BackupFiles()
	if err != nil {
		return err
	}
	// An empty notes folder is far more likely a drive that didn't mount
	// than every page deleted; mirroring it would empty the backup too.
	pages, sentPages := 0, 0
	for _, e := range files {
		if vault.IsNote(e.Path) {
			pages++
		}
	}
	for p := range sent {
		if vault.IsNote(p) {
			sentPages++
		}
	}
	if pages == 0 && sentPages > 0 {
		return errors.New("your notes folder has no pages, so the backup was skipped to keep the copy in Coffer safe. If you really deleted everything, turn backups off and on again")
	}
	current := map[string]bool{}
	added := 0
	for _, e := range files {
		current[e.Path] = true
		if _, ok := sent[e.Path]; !ok {
			added++
		}
	}
	var gone []string
	for p := range sent {
		if !current[p] {
			gone = append(gone, p)
		}
	}
	if largeLoss(len(gone), added, len(sent)) && !allowLoss {
		m.mu.Lock()
		m.st.Status.HeldDeletes = len(gone)
		m.mu.Unlock()
		return fmt.Errorf("this backup would remove %d of the %d files in the Coffer copy at once, which looks more like files that went missing than ones you deleted, so it was skipped to keep the copy safe. If you meant to remove them, back up again and allow the large deletion", len(gone), len(sent))
	}
	if err := d.mkdirs(ctx, "notes"); err != nil {
		return err
	}
	var uploaded, deleted int
	var bytes int64
	for _, e := range files {
		st := fileStamp{Size: e.Size, Mtime: e.ModTime.UnixNano()}
		if prev, ok := sent[e.Path]; ok && prev == st {
			continue
		}
		f, err := m.vault.Open(e.Path)
		if err != nil {
			continue // Deleted since the walk.
		}
		err = d.put(ctx, "notes/"+e.Path, f, e.Size)
		f.Close()
		if err != nil {
			return err
		}
		m.mu.Lock()
		sent[e.Path] = st
		m.mu.Unlock()
		uploaded++
		bytes += e.Size
	}
	// Removed files are moved aside rather than deleted, so a mistake can
	// still be undone from Coffer. One that can't be moved stays where it
	// is, and is tried again next run.
	day := m.now().Format(time.DateOnly)
	var unmoved int
	var moveErr error
	for _, p := range gone {
		if err := d.move(ctx, "notes/"+p, "deleted/"+day+"/"+p); err != nil {
			unmoved++
			moveErr = cmp.Or(moveErr, err)
			continue
		}
		m.mu.Lock()
		delete(sent, p)
		m.mu.Unlock()
		deleted++
	}
	if err := m.pruneDeleted(ctx, d); err != nil {
		m.log.Warn("tidy old deleted files in the backup", "err", err)
	}

	// The database, as a consistent snapshot.
	snap := filepath.Join(m.dataDir, "backup-snapshot.db")
	defer os.Remove(snap)
	if err := m.store.Snapshot(snap); err != nil {
		return fmt.Errorf("snapshot the database: %w", err)
	}
	hash, size, err := fileHash(snap)
	if err != nil {
		return err
	}
	if hash != m.st.DBHash {
		f, err := os.Open(snap)
		if err != nil {
			return err
		}
		err = d.put(ctx, "quire.db", f, size)
		f.Close()
		if err != nil {
			return err
		}
		m.mu.Lock()
		m.st.DBHash = hash
		m.mu.Unlock()
		uploaded++
		bytes += size
	}

	manifest, _ := json.MarshalIndent(map[string]any{
		"app":      "Quire",
		"version":  m.version,
		"created":  time.Now().UTC().Format(time.RFC3339),
		"files":    len(files),
		"notes":    "notes/ holds the vault: copy it into QUIRE_NOTES_DIR",
		"database": "quire.db holds your account, page history and share links: copy it into QUIRE_DATA_DIR",
	}, "", "  ")
	if err := d.put(ctx, "backup.json", strings.NewReader(string(manifest)), int64(len(manifest))); err != nil {
		return err
	}

	m.mu.Lock()
	m.st.Status.Files, m.st.Status.Uploaded, m.st.Status.Deleted, m.st.Status.Bytes = len(files), uploaded, deleted, bytes
	m.mu.Unlock()
	if unmoved > 0 {
		return fmt.Errorf("%d removed files couldn't be moved into deleted/ in Coffer, so they were left in the backup: %w", unmoved, moveErr)
	}
	return nil
}

// keepDeleted is how long files that left the vault stay in deleted/.
const keepDeleted = 30 * 24 * time.Hour

// largeLoss reports a run that would take a large share of the backup away
// at once: more than 50 files, or at least 10 that are more than a fifth of
// it. Files new to the backup are counted against the ones removed, so
// renaming a space (its pages removed under the old name, added under the
// new) isn't a loss.
func largeLoss(gone, added, total int) bool {
	loss := gone - added
	return loss > 50 || loss >= 10 && loss*5 > total
}

// pruneDeleted removes deleted/ day folders older than keepDeleted.
func (m *Manager) pruneDeleted(ctx context.Context, d *dav) error {
	names, err := d.list(ctx, "deleted")
	if err != nil {
		return err
	}
	cut := m.now().Add(-keepDeleted)
	for _, n := range names {
		day, err := time.ParseInLocation(time.DateOnly, n, time.Local)
		if err != nil || !day.Before(cut) {
			continue
		}
		if err := d.remove(ctx, "deleted/"+n); err != nil {
			return err
		}
	}
	return nil
}

func fileHash(name string) (string, int64, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

// Schedule runs backups every cfg.Hours, retrying failures after 30 minutes.
func (m *Manager) Schedule(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.mu.Lock()
			cfg, st, running, locked := m.cfg, m.st.Status, m.running, m.locked
			m.mu.Unlock()
			if cfg == nil || cfg.Hours <= 0 || running || locked {
				continue
			}
			now := time.Now().UnixMilli()
			due := st.LastSuccess + int64(cfg.Hours)*3_600_000
			if st.LastError != "" {
				// After a failure, try again 30 minutes after the last
				// attempt, not every minute once the backup is overdue.
				due = st.LastRun + 30*60_000
			}
			if now >= due {
				_ = m.Run()
			}
		}
	}
}
