@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
set ELECTRON_ENABLE_LOGGING=
cd /d "C:\Users\a1519\Documents\Guncat-Work-for-web\release\Guncat Work-0.1.0"
echo START %DATE% %TIME% > "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_full.txt"
echo ARGS: %* >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_full.txt"
"Guncat Work.exe" %* --enable-logging --v=1 --log-file="C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\chrome_debug.log" >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_full.txt" 2>&1
echo EXIT=%ERRORLEVEL% >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_full.txt"
echo END %DATE% %TIME% >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_full.txt"
