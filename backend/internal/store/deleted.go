package store

// HistoryPath is a page path that has history outside the trash.
type HistoryPath struct {
	Path     string `json:"path"`
	Updated  int64  `json:"updated"`
	Versions int    `json:"versions"`
	// Latest is the newest version's revision id.
	Latest int64 `json:"latest"`
}

// HistoryPaths lists every path with history outside the trash, newest
// first. Pages deleted through Quire take their history to the trash, so a
// path here whose file is gone was deleted or moved by something else.
func (s *Store) HistoryPaths() ([]HistoryPath, error) {
	// SQLite takes id from the row MAX(updated) picked.
	rows, err := s.db.Query(`SELECT path, id, MAX(updated), COUNT(*) FROM revisions WHERE path NOT LIKE '.trash/%' GROUP BY path ORDER BY MAX(updated) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryPath
	for rows.Next() {
		var h HistoryPath
		if err := rows.Scan(&h.Path, &h.Latest, &h.Updated, &h.Versions); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
