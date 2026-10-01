package h2only

import (
	"context"
	"net/http"
)

type Config struct{}

func CreateConfig() *Config { return &Config{} }

func New(_ context.Context, next http.Handler, _ *Config, _ string) (http.Handler, error) {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			http.Error(w, "Требуется HTTP/2", http.StatusHTTPVersionNotSupported)
			return
		}
		next.ServeHTTP(w, r)
	}), nil
}
