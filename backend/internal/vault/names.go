package vault

import (
	"path"
	"strings"
)

// AttachmentName turns an uploaded file's name into one that works in a
// Markdown link as is: no spaces, slashes, brackets or other characters
// links or file systems trip over.
func AttachmentName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r == ' ' || strings.ContainsRune(`/\:*?"<>|()[]#%`, r) || r < 32 {
			return '-'
		}
		return r
	}, path.Base(strings.ReplaceAll(name, `\`, "/")))
	name = strings.TrimLeft(name, ".-")
	// Room for " 2" in a file system's 255 bytes.
	if len(name) > 200 {
		ext := path.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		stem := []rune(strings.TrimSuffix(name, ext))
		for len(string(stem))+len(ext) > 200 {
			stem = stem[:len(stem)-1]
		}
		name = string(stem) + ext
	}
	if name == "" || name == "-" {
		name = "file"
	}
	return name
}
