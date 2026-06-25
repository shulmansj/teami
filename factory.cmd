@echo off
rem Agentic Factory repo-local launcher (Windows).
rem Run `factory <command>` in cmd.exe or `.\factory.cmd <command>` in PowerShell
rem from the repo directory. %~dp0 resolves the repo dir from this script's
rem location. This is a dumb shim — all command resolution lives in the CLI.
node "%~dp0execution\integrations\linear\cli.mjs" %*
