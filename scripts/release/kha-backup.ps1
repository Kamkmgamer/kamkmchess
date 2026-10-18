<#
.SYNOPSIS
  Operator entry point for the encrypted PostgreSQL backup tooling.

.DESCRIPTION
  Thin pass-through to `go run ./backend/backup/cmd/khabackup`. It exists so an
  operator on Windows does not have to remember the command layout, and it keeps
  two rules that the Go command also enforces:

    * a passphrase is never accepted as an argument. It is read from the
      environment variable named by -PassphraseEnv.
    * nothing is written or deleted unless -Apply is passed.

  This script provisions nothing, contacts no provider and needs no paid plan.

.EXAMPLE
  $env:KHA_BACKUP_PASSPHRASE = '<operator passphrase>'
  $env:DATABASE_URL = 'postgres://user:password@host:5432/kamkmchess?sslmode=require'
  ./scripts/release/kha-backup.ps1 -Action create -Class daily -Out D:\backups

.EXAMPLE
  ./scripts/release/kha-backup.ps1 -Action rotate -Dir D:\backups
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('create', 'verify', 'inspect', 'plan', 'restore', 'rotate', 'ledger', 'help')]
  [string]$Action,

  [ValidateSet('daily', 'weekly')]
  [string]$Class = 'daily',

  [string]$Out,
  [string]$File,
  [string]$Dir,
  [string[]]$File2,
  [string]$NewerLedger,
  [string[]]$Protect,
  [string]$PassphraseEnv = 'KHA_BACKUP_PASSPHRASE',
  [string]$DatabaseUrlEnv = 'DATABASE_URL',
  [int]$Daily,
  [int]$Weekly,
  [switch]$Apply,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path

function Invoke-Backup {
  param([string[]]$Arguments)

  Push-Location $repositoryRoot
  try {
    & go run ./backend/backup/cmd/khabackup @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "khabackup exited with $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}

$common = @('--passphrase-env', $PassphraseEnv, '--database-url-env', $DatabaseUrlEnv)
if ($Json) { $common += '--json' }

switch ($Action) {
  'create' {
    if (-not $Out) { throw '-Out is required for create' }
    Invoke-Backup (@('create', '--out', $Out, '--class', $Class) + $common)
  }
  'verify' {
    if (-not $File) { throw '-File is required for verify' }
    Invoke-Backup (@('verify', '--file', $File) + $common)
  }
  'inspect' {
    if (-not $File) { throw '-File is required for inspect' }
    Invoke-Backup @('inspect', '--file', $File)
  }
  'plan' {
    if (-not $File) { throw '-File is required for plan' }
    $arguments = @('plan', '--file', $File) + $common
    foreach ($ledger in @($NewerLedger)) {
      if ($ledger) { $arguments += @('--newer-ledger', $ledger) }
    }
    Invoke-Backup $arguments
  }
  'restore' {
    if (-not $File) { throw '-File is required for restore' }
    if (-not $Apply) { throw 'restore refuses to run without -Apply; run -Action plan first' }
    $arguments = @('restore', '--file', $File, '--apply') + $common
    foreach ($ledger in @($NewerLedger)) {
      if ($ledger) { $arguments += @('--newer-ledger', $ledger) }
    }
    Invoke-Backup $arguments
  }
  'rotate' {
    if (-not $Dir) { throw '-Dir is required for rotate' }
    $arguments = @('rotate', '--dir', $Dir)
    if ($Daily -gt 0) { $arguments += @('--daily', "$Daily") }
    if ($Weekly -gt 0) { $arguments += @('--weekly', "$Weekly") }
    foreach ($label in @($Protect)) {
      if ($label) { $arguments += @('--protect', $label) }
    }
    if ($Apply) { $arguments += '--apply' }
    Invoke-Backup $arguments
  }
  'ledger' {
    $arguments = @('ledger')
    foreach ($path in @($File) + @($File2)) {
      if ($path) { $arguments += @('--file', $path) }
    }
    if ($arguments.Count -eq 1) { throw '-File is required for ledger' }
    Invoke-Backup ($arguments + $common)
  }
  'help' {
    Invoke-Backup @('help')
  }
}