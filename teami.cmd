@echo off
rem Teami repo-local launcher (Windows).
rem Run `teami <command>` in cmd.exe or `.\teami.cmd <command>` in PowerShell
rem from the repo directory. %~dp0 resolves the repo dir from this script's
rem location. This is a dumb shim - all command resolution lives in the CLI.
node "%~dp0execution\integrations\linear\cli.mjs" %*
