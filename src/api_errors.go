package main

import (
	"errors"
	"net/http"
)

// Stable codes let clients localize errors without rewriting system output.
// Keep the error field for existing scripts and the full audit trail.
type apiError struct{ code, message string }

func (e *apiError) Error() string           { return e.message }
func codedError(code, message string) error { return &apiError{code: code, message: message} }
func errorCode(err error, fallback string) string {
	var e *apiError
	if errors.As(err, &e) {
		return e.code
	}
	return fallback
}
func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}
