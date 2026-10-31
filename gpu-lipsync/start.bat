@echo off
cd /d D:\lipsync
set PYTHONIOENCODING=utf-8
venv\Scripts\python.exe server.py >> D:\lipsync\server.log 2>&1
