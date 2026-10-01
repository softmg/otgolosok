package h2only

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProtocolGate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		major  int
		status int
	}{
		{"HTTP/2", 2, http.StatusNoContent},
		{"HTTP/1.1", 1, http.StatusHTTPVersionNotSupported},
		{"HTTP/3", 3, http.StatusHTTPVersionNotSupported},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			})
			handler, err := New(context.Background(), next, CreateConfig(), "h2only")
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodGet, "https://example.com/", nil)
			req.ProtoMajor = tc.major
			resp := httptest.NewRecorder()
			handler.ServeHTTP(resp, req)
			if resp.Code != tc.status || called != (tc.major == 2) {
				t.Fatalf("status=%d called=%v", resp.Code, called)
			}
		})
	}
}
