@echo off
rem Remove the dsh-projectmap plugin from the web profile.
rem Run this if DSH stops booting after installing it.
cd /d "%~dp0"
echo Removing dsh-projectmap from profile "web" ...
call npx -y @deepseek-ai/dsh plugin --profile web remove dsh-projectmap
echo.
echo Done. Now run restart-panel.bat to restart the panel.
pause