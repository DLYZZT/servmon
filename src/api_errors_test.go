package main

import (
	"encoding/json"
	"testing"
)

func TestLocalizedErrorCodesPreserveLegacyMessages(t *testing.T) {
	s := testServer(t)
	cases := []struct {
		method, path, token, code, legacy string
		status                            int
	}{
		{"GET", "/api/ping", "", "unauthorized", "unauthorized", 401},
		{"POST", "/api/services/nginx/stop", "view-test", "read_only", "只读令牌不能执行此操作", 403},
		{"GET", "/api/processes/invalid", "admin-test", "invalid_pid", "invalid PID", 400},
		{"POST", "/api/processes/1/kill", "admin-test", "protected_pid", "拒绝操作受保护 PID", 400},
		{"GET", "/api/services/other/logs", "view-test", "service_not_allowed", "service not allowed", 403},
		{"GET", "/api/history?range=invalid", "admin-test", "invalid_range", "invalid range", 400},
		{"POST", "/api/containers/missing/stop", "admin-test", "unknown_container", "unknown container", 400},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			w := request(s, tc.method, tc.path, tc.token, "")
			var data map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.status || data["code"] != tc.code || data["error"] != tc.legacy {
				t.Fatalf("status=%d body=%v", w.Code, data)
			}
		})
	}
}
