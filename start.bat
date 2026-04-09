@echo off
title WhatsApp Scheduler
echo ================================================
echo   WhatsApp Scheduler - Femina Adventure
echo ================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERREUR] Node.js n'est pas installe.
    echo Telechargez-le sur https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installation des dependances...
    npm install
    echo.
)

:: Copy .env if missing
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo Fichier .env cree depuis .env.example
    )
)

echo Demarrage du serveur...
echo L'interface s'ouvrira dans votre navigateur.
echo.

:: Open browser after a short delay
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

:: Start server
node src/server.js

pause
