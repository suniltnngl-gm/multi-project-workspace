@echo off
rem Objective: Windows entry point for the cross-platform workspace CLI.
rem Requirements: Work from CMD and PowerShell; forward every argument unchanged.
rem Decisions: Keep the shim tiny; all commands, ports, and platform handling live in scripts\workspace-cli.mjs.
rem Relevant Files: workspace, workspace.cmd, scripts\workspace-cli.mjs
rem Important Context: User file. POSIX shells use ./workspace instead.
rem Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
setlocal
set "ROOT_DIR=%~dp0"
node "%ROOT_DIR%scripts\workspace-cli.mjs" %*
exit /b %ERRORLEVEL%
