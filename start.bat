@echo off
cd /d "%~dp0"
set "URL=http://127.0.0.1:8377/"

rem --- already running? then just open the page ---
powershell -NoProfile -Command "try{ $null=Invoke-WebRequest '%URL%api/ping' -TimeoutSec 2 -UseBasicParsing; exit 0 }catch{ exit 1 }"
if errorlevel 1 goto boot
goto open

:boot
wscript //nologo "%~dp0serve.vbs"
set /a tries=0
:wait
set /a tries+=1
ping -n 2 127.0.0.1 >nul
powershell -NoProfile -Command "try{ $null=Invoke-WebRequest '%URL%api/ping' -TimeoutSec 2 -UseBasicParsing; exit 0 }catch{ exit 1 }"
if not errorlevel 1 goto open
if %tries% LSS 15 goto wait
goto fail

:open
start "" "%URL%"
exit /b 0

:fail
echo.
echo ProjectMap did not start. server.log:
echo ------------------------------------------------------
powershell -NoProfile -Command "if (Test-Path '%~dp0server.log') { Get-Content '%~dp0server.log' -Tail 15 -Encoding utf8 }"
echo ------------------------------------------------------
echo Common causes: node not in PATH, or port 8377 taken.
pause
exit /b 1