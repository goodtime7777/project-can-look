' Start the ProjectMap server with no window; output goes to server.log (UTF-8).
' Called by start.bat; can also be double-clicked on its own.
Option Explicit

Dim fso, sh, base, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

cmd = "cmd /c node """ & base & "\server.mjs"" >> """ & base & "\server.log"" 2>&1"
sh.Run cmd, 0, False