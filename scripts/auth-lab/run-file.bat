@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: run-file.bat path\to\cookies.txt
  exit /b 1
)
python auth_lab.py file "%~1" %*
pause
