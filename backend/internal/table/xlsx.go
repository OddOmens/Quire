package table

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"path"
	"strconv"
	"strings"
	"time"
)

// maxUnzipped caps how much of a workbook is read once decompressed, so a
// small file that inflates hugely can't exhaust memory.
const maxUnzipped = 128 << 20

// ReadXLSX reads the first sheet of an Excel workbook as rows of text. Dates
// come out as YYYY-MM-DD, numbers as typed, formulas as their last result.
func ReadXLSX(data []byte) ([][]string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("it isn't an Excel workbook")
	}
	budget := int64(maxUnzipped)
	read := func(name string) ([]byte, error) {
		for _, f := range zr.File {
			if f.Name == name {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				b, err := io.ReadAll(io.LimitReader(rc, budget+1))
				if err != nil {
					return nil, err
				}
				if budget -= int64(len(b)); budget < 0 {
					return nil, errors.New("the workbook is too large")
				}
				return b, nil
			}
		}
		return nil, nil
	}

	sheet, err := firstSheet(read)
	if err != nil {
		return nil, err
	}
	strs, err := sharedStrings(read)
	if err != nil {
		return nil, err
	}
	dates, err := dateStyles(read)
	if err != nil {
		return nil, err
	}
	raw, err := read(sheet)
	if err != nil || raw == nil {
		return nil, errors.New("the workbook has no sheets")
	}

	var ws struct {
		Rows []struct {
			Cells []struct {
				Ref    string `xml:"r,attr"`
				Type   string `xml:"t,attr"`
				Style  int    `xml:"s,attr"`
				Value  string `xml:"v"`
				Inline struct {
					Text string `xml:"t"`
					Runs []struct {
						Text string `xml:"t"`
					} `xml:"r"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := xml.Unmarshal(raw, &ws); err != nil {
		return nil, errors.New("the sheet can't be read")
	}
	var out [][]string
	for _, row := range ws.Rows {
		if len(out) > MaxRows {
			return nil, ErrTooLarge
		}
		var rec []string
		for i, c := range row.Cells {
			col := i
			if c.Ref != "" {
				col = columnIndex(c.Ref)
			}
			if col < 0 || col >= MaxColumns {
				continue
			}
			for len(rec) <= col {
				rec = append(rec, "")
			}
			v := c.Value
			switch c.Type {
			case "s":
				if n, err := strconv.Atoi(v); err == nil && n >= 0 && n < len(strs) {
					v = strs[n]
				}
			case "inlineStr":
				v = c.Inline.Text
				for _, r := range c.Inline.Runs {
					v += r.Text
				}
			case "b":
				if v == "1" {
					v = "true"
				} else {
					v = "false"
				}
			case "e":
				v = ""
			case "", "n":
				if dates[c.Style] {
					if n, err := strconv.ParseFloat(v, 64); err == nil {
						v = serialDate(n)
					}
				}
			}
			rec[col] = v
		}
		out = append(out, rec)
	}
	// Drop empty rows at the end.
	for len(out) > 0 && strings.TrimSpace(strings.Join(out[len(out)-1], "")) == "" {
		out = out[:len(out)-1]
	}
	return out, nil
}

// firstSheet finds the first worksheet's file through the workbook.
func firstSheet(read func(string) ([]byte, error)) (string, error) {
	wb, err := read("xl/workbook.xml")
	if err != nil {
		return "", err
	}
	if wb == nil {
		return "", errors.New("it isn't an Excel workbook")
	}
	var book struct {
		Sheets []struct {
			ID string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := xml.Unmarshal(wb, &book); err != nil || len(book.Sheets) == 0 {
		return "xl/worksheets/sheet1.xml", nil
	}
	rels, err := read("xl/_rels/workbook.xml.rels")
	if err != nil || rels == nil {
		return "xl/worksheets/sheet1.xml", nil
	}
	var rs struct {
		Rels []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	if err := xml.Unmarshal(rels, &rs); err != nil {
		return "xl/worksheets/sheet1.xml", nil
	}
	for _, r := range rs.Rels {
		if r.ID == book.Sheets[0].ID {
			t := strings.TrimPrefix(r.Target, "/")
			if !strings.HasPrefix(t, "xl/") {
				t = path.Join("xl", t)
			}
			return path.Clean(t), nil
		}
	}
	return "xl/worksheets/sheet1.xml", nil
}

func sharedStrings(read func(string) ([]byte, error)) ([]string, error) {
	raw, err := read("xl/sharedStrings.xml")
	if err != nil || raw == nil {
		return nil, err
	}
	var sst struct {
		Items []struct {
			Text string `xml:"t"`
			Runs []struct {
				Text string `xml:"t"`
			} `xml:"r"`
		} `xml:"si"`
	}
	if err := xml.Unmarshal(raw, &sst); err != nil {
		return nil, errors.New("the workbook's text can't be read")
	}
	out := make([]string, len(sst.Items))
	for i, it := range sst.Items {
		s := it.Text
		for _, r := range it.Runs {
			s += r.Text
		}
		out[i] = s
	}
	return out, nil
}

// dateStyles lists the cell styles that show numbers as dates.
func dateStyles(read func(string) ([]byte, error)) (map[int]bool, error) {
	out := map[int]bool{}
	raw, err := read("xl/styles.xml")
	if err != nil || raw == nil {
		return out, err
	}
	var st struct {
		Formats []struct {
			ID   int    `xml:"numFmtId,attr"`
			Code string `xml:"formatCode,attr"`
		} `xml:"numFmts>numFmt"`
		Xfs []struct {
			Format int `xml:"numFmtId,attr"`
		} `xml:"cellXfs>xf"`
	}
	if err := xml.Unmarshal(raw, &st); err != nil {
		return out, nil
	}
	custom := map[int]bool{}
	for _, f := range st.Formats {
		custom[f.ID] = isDateFormat(f.Code)
	}
	for i, xf := range st.Xfs {
		id := xf.Format
		if (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || custom[id] {
			out[i] = true
		}
	}
	return out, nil
}

func isDateFormat(code string) bool {
	// Ignore quoted text and [colour]/[locale] parts.
	var b strings.Builder
	inQuote, inBracket := false, false
	for _, r := range strings.ToLower(code) {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == '[':
			inBracket = true
		case r == ']':
			inBracket = false
		case !inQuote && !inBracket:
			b.WriteRune(r)
		}
	}
	s := b.String()
	return strings.ContainsAny(s, "yd") || (strings.Contains(s, "m") && !strings.ContainsAny(s, "0#"))
}

func serialDate(n float64) string {
	t := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).Add(time.Duration(math.Round(n*86400)) * time.Second)
	if n != math.Trunc(n) {
		return t.Format("2006-01-02T15:04")
	}
	return t.Format("2006-01-02")
}

// columnIndex reads the column of a cell reference: "C7" is 2.
func columnIndex(ref string) int {
	n := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		n = n*26 + int(r-'A'+1)
		if n > MaxColumns {
			return -1
		}
	}
	return n - 1
}
