$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$pgbin = (Resolve-Path '.scratch/kha41/postgresql/pgsql/bin').Path
$data = (Resolve-Path '.scratch/kha41/postgresql/data').Path
& "$pgbin\pg_ctl.exe" -D $data status *> $null
if ($LASTEXITCODE -ne 0) {
  & "$pgbin\pg_ctl.exe" -D $data -l (Join-Path $data 'server.log') -o '-h 127.0.0.1 -p 55441' -w start
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the isolated KHA-41 PostgreSQL cluster.' }
}
$env:KHA41_TEST_DATABASE_URL = 'postgres://kha41_test@127.0.0.1:55441/kha41_test?sslmode=disable'
$env:KHA41_REQUIRE_POSTGRES = '1'
go test ./backend/integration -count=1 -v
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
