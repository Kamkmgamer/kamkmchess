package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

func main() {
	candidates := []string{
		"postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
		"postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable",
		"postgres://postgres:fixture-only@127.0.0.1:5432/postgres?sslmode=disable",
		"postgres://kha41_test:fixture-only@127.0.0.1:5432/kha41_test?sslmode=disable",
		"postgres://kha41_test@127.0.0.1:5432/kha41_test?sslmode=disable",
		"postgres://kamkmchess:kamkmchess@127.0.0.1:5432/kamkmchess?sslmode=disable",
	}
	for _, dsn := range candidates {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, dsn)
		if err != nil {
			fmt.Printf("FAIL %s: %v\n", dsn, err)
			continue
		}
		var dbs []string
		rows, err := conn.Query(ctx, "SELECT datname FROM pg_database WHERE datistemplate = false")
		if err == nil {
			for rows.Next() {
				var name string
				if err := rows.Scan(&name); err == nil {
					dbs = append(dbs, name)
				}
			}
			rows.Close()
		}
		if err != nil {
			fmt.Printf("OK   %s: list failed %v\n", dsn, err)
		} else {
			fmt.Printf("OK   %s: databases=%v\n", dsn, dbs)
		}
		conn.Close(ctx)
	}
	os.Exit(0)
}
