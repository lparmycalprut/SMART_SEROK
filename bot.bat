@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 goto use_python
where py >nul 2>nul
if %errorlevel%==0 goto use_py

echo ERROR: Python tidak ditemukan. Install Python 3.11+ lalu centang "Add Python to PATH".
exit /b 1

:use_python
python -m gmgn_trading_bot.cli --config config.toml %*
exit /b %errorlevel%

:use_py
py -m gmgn_trading_bot.cli --config config.toml %*
exit /b %errorlevel%
