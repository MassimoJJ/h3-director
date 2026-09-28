' H3 Director Studio - hidden launcher (used by the Windows Startup shortcut).
' Runs start-h3-director.ps1 with no visible console window, passing -Open so the app
' opens in the browser at logon. ComfyUI is deliberately NOT started - launch the engine
' yourself when you render (run_nvidia_gpu.bat, or the app's Start button).
' Append " -WithComfy" to the shell.Run line below if you ever want the engine started too.
Option Explicit
Dim shell, fso, scriptPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-h3-director.ps1")
If Not fso.FileExists(scriptPath) Then
  MsgBox "H3 Director autostart script is missing:" & vbCrLf & scriptPath, 16, "H3 Director Studio"
  WScript.Quit 1
End If
' 0 = hidden window, False = do not wait
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -Open", 0, False
