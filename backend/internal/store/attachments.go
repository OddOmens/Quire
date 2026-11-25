package store

// PageTexts calls fn with each indexed page's path and text.
func (s *Store) PageTexts(fn func(path, text string)) error {
	rows, err := s.db.Query(`SELECT path, body FROM fts`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var p, body string
		if err := rows.Scan(&p, &body); err != nil {
			return err
		}
		fn(p, body)
	}
	return rows.Err()
}

// HistoryTexts calls fn with each page version that may mention an
// attachment, one at a time.
func (s *Store) HistoryTexts(fn func(text string)) error {
	rows, err := s.db.Query(`SELECT content FROM revisions WHERE content LIKE '%attachments/%' OR content LIKE '%![[%'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return err
		}
		fn(c)
	}
	return rows.Err()
}
