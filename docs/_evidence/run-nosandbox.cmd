@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "C:\Users\a1519\Documents\Guncat-Work-for-web\release\Guncat Work-0.1.0"
echo START %DATE% %TIME% > "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_nosandbox.txt"
"Guncat Work.exe"  --enable-logging --v=1 --log-file="C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\chrome_debug_nosandbox.log" >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_nosandbox.txt" 2>&1
echo EXIT=%ERRORLEVEL% >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_nosandbox.txt"
echo END %DATE% %TIME% >> "C:\Users\a1519\Documents\Guncat-Work-for-web\docs\_evidence\capture_nosandbox.txt"
