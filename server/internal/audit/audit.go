// Package audit writes immutable audit_log rows. Every state-changing operation
// records exactly one entry, ideally in the same DB transaction as the mutation
// (05-schema-contract #8, 09-acceptance-tests §E).
package audit

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"time"
)

// Execer is satisfied by both *sql.DB and *sql.Tx, so callers can write the audit
// row inside the mutation's transaction.
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type Entry struct {
	EntityType  string
	EntityID    string
	Action      string
	ActorUserID string      // "" -> NULL
	Reason      string      // "" -> NULL
	RequestID   string      // "" -> NULL
	Before      interface{} // marshaled to before_json
	After       interface{} // marshaled to after_json
}

// Write appends one audit row. Returns the error so callers in a tx can roll back.
func Write(ctx context.Context, ex Execer, e Entry) error {
	var beforeJSON, afterJSON interface{}
	if e.Before != nil {
		b, _ := json.Marshal(e.Before)
		beforeJSON = string(b)
	}
	if e.After != nil {
		b, _ := json.Marshal(e.After)
		afterJSON = string(b)
	}
	_, err := ex.ExecContext(ctx,
		`INSERT INTO audit_log
		   (id, entity_type, entity_id, action, actor_user_id, reason, before_json, after_json, request_id, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?)`,
		"aud_"+randHex(12), e.EntityType, e.EntityID, e.Action,
		nullStr(e.ActorUserID), nullStr(e.Reason), beforeJSON, afterJSON, nullStr(e.RequestID),
		time.Now().Unix())
	return err
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
