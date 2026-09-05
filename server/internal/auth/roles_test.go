package auth

import (
	"context"
	"testing"

	"github.com/kevinelong/15ball-scoresheet/server/internal/audit"
)

func TestBootstrapAdminProvisioning(t *testing.T) {
	ctx := context.Background()
	a, _ := newTestAuth(t)
	a.Cfg.BootstrapAdmins = []string{"boss@club.com"}

	uid, err := a.upsertUser(ctx, "Boss@Club.com")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	roles, _ := a.Roles(ctx, uid)
	if len(roles) != 1 || roles[0] != RoleSystemAdmin {
		t.Fatalf("bootstrap admin should be system_admin, got %v", roles)
	}
	if p, _ := a.Pending(ctx, uid); p {
		t.Fatalf("bootstrap admin should not be pending")
	}
}

func TestNonAdminIsPendingViewer(t *testing.T) {
	ctx := context.Background()
	a, _ := newTestAuth(t)
	a.Cfg.BootstrapAdmins = []string{"boss@club.com"}

	uid, _ := a.upsertUser(ctx, "rando@x.com")
	roles, _ := a.Roles(ctx, uid)
	if len(roles) != 1 || roles[0] != RoleViewer {
		t.Fatalf("non-admin should be viewer, got %v", roles)
	}
	if p, _ := a.Pending(ctx, uid); !p {
		t.Fatalf("non-admin should be pending")
	}
	// no auto-promotion on re-provision
	if err := a.EnsureProvisioned(ctx, uid, "rando@x.com"); err != nil {
		t.Fatalf("re-provision: %v", err)
	}
	roles, _ = a.Roles(ctx, uid)
	if len(roles) != 1 || roles[0] != RoleViewer {
		t.Fatalf("must not auto-promote, got %v", roles)
	}
}

func TestGrantRevokeRole(t *testing.T) {
	ctx := context.Background()
	a, _ := newTestAuth(t)
	uid, _ := a.upsertUser(ctx, "player@x.com")   // viewer+pending
	admin, _ := a.upsertUser(ctx, "admin@x.com")

	if err := a.GrantRole(ctx, uid, RoleTournamentDirector, admin); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if ok, _ := a.HasAnyRole(ctx, uid, DirectorOrAbove...); !ok {
		t.Fatalf("should have director role after grant")
	}
	if p, _ := a.Pending(ctx, uid); p {
		t.Fatalf("grant should clear pending")
	}
	if err := a.RevokeRole(ctx, uid, RoleTournamentDirector); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if ok, _ := a.HasAnyRole(ctx, uid, RoleTournamentDirector); ok {
		t.Fatalf("director role should be gone after revoke")
	}
}

func TestAuditWriteAppends(t *testing.T) {
	ctx := context.Background()
	a, _ := newTestAuth(t)
	if err := audit.Write(ctx, a.DB, audit.Entry{
		EntityType: "user", EntityID: "u_1", Action: "test",
		ActorUserID: "u_admin", After: map[string]string{"k": "v"},
	}); err != nil {
		t.Fatalf("audit write: %v", err)
	}
	var n int
	if err := a.DB.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM audit_log WHERE entity_id='u_1' AND action='test'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("want 1 audit row, got %d", n)
	}
}
