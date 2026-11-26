@echo off
rem dsh-session-native.cmd - native messaging launcher
rem
rem Chrome requires the native host "path" to be an EXECUTABLE,
rem it cannot point at a .mjs directly. This .cmd runs it with node.
rem
rem IMPORTANT: native messaging stdio is a binary protocol channel.
rem Never echo anything here or the protocol breaks.
rem
rem NOTE: keep this file ASCII-only. cmd.exe reads it with the system
rem code page (GBK on zh-CN Windows); non-ASCII comments become
rem garbage commands and print errors to stderr.

setlocal
set "HERE=%~dp0"

rem Prefer an explicit node if the installer recorded one.
if exist "%HERE%node-path.txt" (
  set /p NODE_BIN=<"%HERE%node-path.txt"
)

if not defined NODE_BIN set "NODE_BIN=node"

"%NODE_BIN%" "%HERE%native-host.mjs"
