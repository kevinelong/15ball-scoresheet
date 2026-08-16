// Package migrations embeds the SQL migration files so they ship inside the
// static binary (go:embed can only see its own directory tree, which is why the
// embed lives here at server/migrations/ rather than in the store package).
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
