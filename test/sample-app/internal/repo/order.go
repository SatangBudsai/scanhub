package repo

import (
	"database/sql"
	"fmt"
	"net/http"
)

// Intentionally insecure sample used to test ScanHub.

type OrderRepo struct {
	db *sql.DB
}

func (r *OrderRepo) FindByCustomer(req *http.Request) (*sql.Rows, error) {
	customer := req.URL.Query().Get("customer")
	query := fmt.Sprintf("SELECT id, amount FROM orders WHERE customer = '%s'", customer)
	return r.db.Query(query)
}

func (r *OrderRepo) FindByID(id string) (*sql.Rows, error) {
	return r.db.Query("SELECT id, amount FROM orders WHERE id = " + id)
}
